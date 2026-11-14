import type { FastifyInstance, FastifyRequest } from 'fastify';
import { notFound } from '../lib/errors.js';
import type { Role } from '../lib/permissions.js';
import { findMembershipBySlug } from '../modules/orgs/repo.js';
import { currentUser } from './auth.js';

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
  app.decorateRequest('tenant', null);
}

/**
 * preHandler for everything under /orgs/:orgSlug. A missing org and an org the caller does
 * not belong to produce the same 404.
 */
export async function resolveTenant(request: FastifyRequest): Promise<void> {
  const user = currentUser(request);
  const { orgSlug } = request.params as { orgSlug: string };
  const membership = await findMembershipBySlug(orgSlug, user.id, request.server.deps.db);
  if (!membership) {
    throw notFound();
  }
  request.tenant = { orgId: membership.orgId, role: membership.role, userId: user.id };
}
