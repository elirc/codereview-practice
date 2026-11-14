import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { z } from 'zod';
import type { Db } from '../db/db.js';
import { parseCookieHeader, SESSION_COOKIE } from '../http/auth.js';
import { resolveDocAccess, type DocAccess } from '../services/access.js';
import { findSession, type AuthSession } from '../services/auth.js';

const DOC_PATH = /^\/ws\/docs\/([^/]+)$/;
const docId = z.string().uuid();

const STATUS_TEXT: Record<number, string> = {
  403: 'Forbidden',
  404: 'Not Found',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  503: 'Service Unavailable',
};

export type UpgradeDecision =
  | { ok: true; session: AuthSession | null; access: DocAccess }
  | { ok: false; status: number };

export interface UpgradeCheck {
  db: Db;
  appOrigin: string;
  now: Date;
}

/** Decides whether an upgrade request may open a connection, and as whom. */
export async function authorizeUpgrade(
  request: IncomingMessage,
  check: UpgradeCheck,
): Promise<UpgradeDecision> {
  const url = new URL(request.url ?? '/', 'http://localhost');
  const match = DOC_PATH.exec(url.pathname);
  if (!match) return { ok: false, status: 404 };
  if (request.headers.origin !== check.appOrigin) return { ok: false, status: 403 };

  const parsedId = docId.safeParse(match[1]);
  if (!parsedId.success) return { ok: false, status: 404 };

  const token = parseCookieHeader(request.headers.cookie)[SESSION_COOKIE];
  const session = token ? await findSession(check.db, token, check.now) : null;
  const linkToken = url.searchParams.get('link');
  const result = await resolveDocAccess(
    check.db,
    parsedId.data,
    { userId: session?.user.id ?? null, link: linkToken ? { token: linkToken } : null },
    check.now,
  );
  if (result.kind !== 'ok') return { ok: false, status: 404 };
  return { ok: true, session, access: result.access };
}

/** Writes a plain HTTP response on an upgrade socket and closes it. */
export function rejectUpgrade(socket: Duplex, status: number): void {
  if (socket.destroyed) return;
  const text = STATUS_TEXT[status] ?? 'Error';
  socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}
