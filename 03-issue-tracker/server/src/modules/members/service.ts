import type { Transaction } from 'kysely';
import type { AppDeps } from '../../app.js';
import { isUniqueViolation } from '../../db/index.js';
import type { DB } from '../../db/types.js';
import { buildPage, decodeCursor } from '../../lib/cursor.js';
import { conflict, forbidden, notFound, unprocessable } from '../../lib/errors.js';
import { assertCan, canManageMember, type Role } from '../../lib/permissions.js';
import type { TenantContext } from '../../plugins/tenant.js';
import { normalizeEmail } from '../auth/service.js';
import {
  deleteMembership,
  findMember,
  findMembershipRole,
  findUserIdByEmail,
  insertMembership,
  listMembersPage,
  lockMembership,
  lockOwners,
  unassignMemberIssues,
  updateMembershipRole,
  type MemberRow,
} from './repo.js';

type Deps = Pick<AppDeps, 'db' | 'clock'>;

export interface MemberView {
  userId: string;
  name: string;
  email: string;
  role: Role;
  joinedAt: string;
}

function toMember(row: MemberRow): MemberView {
  return {
    userId: row.user_id,
    name: row.name,
    email: row.email,
    role: row.role,
    joinedAt: row.created_at.toISOString(),
  };
}

function lastOwner() {
  return unprocessable('last_owner', 'An organisation must keep at least one owner.');
}

async function loadMember(deps: Deps, orgId: string, userId: string): Promise<MemberView> {
  const row = await findMember(orgId, userId, deps.db);
  if (!row) throw notFound();
  return toMember(row);
}

/**
 * Runs a membership change with the org's owner rows locked, using the caller's role as it
 * is once the lock is held rather than as it was when the request arrived.
 */
async function withOwnersLocked<T>(
  deps: Deps,
  tenant: TenantContext,
  work: (trx: Transaction<DB>, actorRole: Role, ownerIds: string[]) => Promise<T>,
): Promise<T> {
  return deps.db.transaction().execute(async (trx) => {
    const ownerIds = await lockOwners(tenant.orgId, trx);
    const actorRole = await findMembershipRole(tenant.orgId, tenant.userId, trx);
    if (!actorRole) throw notFound();
    return work(trx, actorRole, ownerIds);
  });
}

export async function listMembers(
  deps: Deps,
  tenant: TenantContext,
  query: { limit?: number; cursor?: string },
) {
  const limit = query.limit ?? 25;
  const after = query.cursor ? decodeCursor(query.cursor, 'joined') : null;
  const rows = await listMembersPage(tenant.orgId, after, limit + 1, deps.db);
  const page = buildPage(rows, limit, (row) => ({
    s: 'joined',
    v: row.joined_cursor,
    id: row.user_id,
  }));
  return { items: page.rows.map(toMember), nextCursor: page.nextCursor };
}

export async function addMember(
  deps: Deps,
  tenant: TenantContext,
  input: { email: string; role: Role },
): Promise<MemberView> {
  const userId = await withOwnersLocked(deps, tenant, async (trx, actorRole) => {
    assertCan(actorRole, 'member.manage');
    if (input.role === 'owner') assertCan(actorRole, 'member.grantOwner');
    const userId = await findUserIdByEmail(normalizeEmail(input.email), trx);
    if (!userId) {
      throw unprocessable('user_not_found', 'No account exists with that email address.');
    }
    try {
      await insertMembership(
        tenant.orgId,
        { userId, role: input.role, now: deps.clock.now() },
        trx,
      );
    } catch (err) {
      if (isUniqueViolation(err, 'memberships_pkey')) {
        throw conflict('already_member', 'That user is already a member of this organisation.');
      }
      throw err;
    }
    return userId;
  });
  return loadMember(deps, tenant.orgId, userId);
}

export async function changeMemberRole(
  deps: Deps,
  tenant: TenantContext,
  userId: string,
  role: Role,
): Promise<MemberView> {
  await withOwnersLocked(deps, tenant, async (trx, actorRole, ownerIds) => {
    const currentRole = await lockMembership(tenant.orgId, userId, trx);
    if (!currentRole) throw notFound();
    if (!canManageMember(actorRole, currentRole, role)) throw forbidden();
    if (currentRole === role) return;
    if (currentRole === 'owner' && ownerIds.length === 1) throw lastOwner();
    if (role === 'viewer') {
      await unassignMemberIssues(tenant.orgId, userId, deps.clock.now(), trx);
    }
    await updateMembershipRole(tenant.orgId, userId, role, trx);
  });
  return loadMember(deps, tenant.orgId, userId);
}

export async function removeMember(
  deps: Deps,
  tenant: TenantContext,
  userId: string,
): Promise<void> {
  await withOwnersLocked(deps, tenant, async (trx, actorRole, ownerIds) => {
    const currentRole = await lockMembership(tenant.orgId, userId, trx);
    if (!currentRole) throw notFound();
    const leaving = userId === tenant.userId;
    if (!leaving && !canManageMember(actorRole, currentRole, null)) throw forbidden();
    if (currentRole === 'owner' && ownerIds.length === 1) throw lastOwner();
    await unassignMemberIssues(tenant.orgId, userId, deps.clock.now(), trx);
    await deleteMembership(tenant.orgId, userId, trx);
  });
}
