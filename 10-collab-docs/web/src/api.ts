import type { DocRole } from './collab/roles';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: Record<string, unknown>;

  constructor(status: number, code: string, message: string, details: Record<string, unknown>) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';

/** Calls the JSON API and returns the parsed body, or throws ApiError with the envelope's code. */
export async function api<T>(method: Method, path: string, body?: unknown): Promise<T> {
  const init: RequestInit = { method, credentials: 'same-origin', headers: {} };
  if (method !== 'GET') {
    init.headers = { 'content-type': 'application/json' };
    init.body = JSON.stringify(body ?? {});
  }
  const response = await fetch(`/api${path}`, init);
  const text = await response.text();
  const parsed = text.length > 0 ? JSON.parse(text) : null;
  if (!response.ok) {
    const error = parsed?.error ?? {};
    throw new ApiError(
      response.status,
      error.code ?? 'internal_error',
      error.message ?? 'Something went wrong.',
      error.details ?? {},
    );
  }
  return parsed as T;
}

export function withLink(path: string, link: string | null): string {
  if (!link) return path;
  const separator = path.includes('?') ? '&' : '?';
  return `${path}${separator}link=${encodeURIComponent(link)}`;
}

export interface User {
  id: string;
  email: string;
  name: string;
}

export type WorkspaceRole = 'owner' | 'admin' | 'member';

export interface Workspace {
  id: string;
  name: string;
  allowExternalSharing: boolean;
  role: WorkspaceRole;
}

export interface Member {
  userId: string;
  email: string;
  name: string;
  role: WorkspaceRole;
}

export type WorkspaceAccess = 'none' | 'viewer' | 'commenter' | 'editor';

export interface Doc {
  id: string;
  workspaceId: string;
  title: string;
  ownerId: string;
  workspaceAccess: WorkspaceAccess;
  role: DocRole;
  canManage: boolean;
  trashedAt: string | null;
  updatedAt: string;
}

export interface Share {
  userId: string;
  email: string;
  name: string;
  role: 'viewer' | 'commenter' | 'editor';
  external: boolean;
}

export interface Link {
  id: string;
  role: 'viewer' | 'commenter' | 'editor';
  expiresAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

export interface Comment {
  id: string;
  authorId: string;
  authorName: string;
  body: string;
  createdAt: string;
  editedAt: string | null;
  deletedAt: string | null;
}

export interface Thread {
  id: string;
  quotedText: string;
  status: 'open' | 'resolved';
  range: { start: number; end: number };
  detached: boolean;
  createdBy: string;
  comments: Comment[];
}

export interface Version {
  id: string;
  seq: number;
  kind: 'auto' | 'named' | 'pre_restore';
  label: string | null;
  createdAt: string;
}
