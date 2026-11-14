import type { FastifyInstance, FastifyRequest } from 'fastify';
import { notFound } from '../lib/errors.js';
import type { Role } from '../lib/permissions.js';
import { findMembershipBySlug } from '../modules/orgs/repo.js';
import { currentUser } from './auth.js';
import { cachedMembership, rememberMembership } from './membership-cache.js';

export interface TenantContext {
  orgId: string;
  role: Role;
  userId: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    tenant: TenantContext;
  }
}

export function registerTenantContext(app: FastifyInstance): void {
  app.decorateRequest('tenant', null as unknown as TenantContext);
}

/** preHandler for routes under /orgs/:orgSlug; sets `request.tenant`. */
export async function resolveTenant(request: FastifyRequest): Promise<void> {
  const user = currentUser(request);
  const { orgSlug } = request.params as { orgSlug: string };
  const { db, clock } = request.server.deps;
  const now = clock.now();
  let membership = cachedMembership(orgSlug, user.id, now);
  if (!membership) {
    membership = await findMembershipBySlug(orgSlug, user.id, db);
    if (!membership) {
      throw notFound();
    }
    rememberMembership(orgSlug, user.id, membership, now);
  }
  request.tenant = { orgId: membership.orgId, role: membership.role, userId: user.id };
}
