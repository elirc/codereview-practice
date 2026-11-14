import type { Role } from '../lib/permissions.js';

const TTL_MS = 30_000;
const MAX_ENTRIES = 10_000;

interface CachedMembership {
  orgId: string;
  role: Role;
  expiresAt: number;
}

const entries = new Map<string, CachedMembership>();

function keyFor(org: string, userId: string): string {
  return `${org}:${userId}`;
}

export function cachedMembership(
  orgSlug: string,
  userId: string,
  now: Date,
): { orgId: string; role: Role } | undefined {
  const entry = entries.get(keyFor(orgSlug, userId));
  if (!entry || entry.expiresAt <= now.getTime()) return undefined;
  return { orgId: entry.orgId, role: entry.role };
}

export function rememberMembership(
  orgSlug: string,
  userId: string,
  membership: { orgId: string; role: Role },
  now: Date,
): void {
  if (entries.size >= MAX_ENTRIES) entries.clear();
  entries.set(keyFor(orgSlug, userId), { ...membership, expiresAt: now.getTime() + TTL_MS });
}

/** Drops a cached membership once it has changed. */
export function forgetMembership(orgId: string, userId: string): void {
  entries.delete(keyFor(orgId, userId));
}
