import { sql } from 'kysely';
import type { Db } from '../db/db.js';
import { isWorkspaceManager, type WorkspaceRole } from '../domain/roles.js';
import { errors } from '../http/errors.js';
import type { ServiceContext } from './context.js';

export interface WorkspaceView {
  id: string;
  name: string;
  allowExternalSharing: boolean;
  role: WorkspaceRole;
}

export interface MemberView {
  userId: string;
  email: string;
  name: string;
  role: WorkspaceRole;
  joinedAt: Date;
}

export interface WorkspaceUpdate {
  name?: string;
  allowExternalSharing?: boolean;
}

/** Returns the caller's role in a workspace, or null when they are not a member. */
export async function workspaceRole(
  db: Db,
  workspaceId: string,
  userId: string,
): Promise<WorkspaceRole | null> {
  const row = await db
    .selectFrom('workspace_members')
    .select('role')
    .where('workspace_id', '=', workspaceId)
    .where('user_id', '=', userId)
    .executeTakeFirst();
  return row?.role ?? null;
}

async function requireRole(db: Db, workspaceId: string, userId: string): Promise<WorkspaceRole> {
  const role = await workspaceRole(db, workspaceId, userId);
  if (role === null) throw errors.notFound('Workspace not found.');
  return role;
}

async function requireManager(db: Db, workspaceId: string, userId: string): Promise<WorkspaceRole> {
  const role = await requireRole(db, workspaceId, userId);
  if (!isWorkspaceManager(role)) throw errors.forbidden('Only workspace admins can do that.');
  return role;
}

/** Increments the workspace permission epoch. */
export async function bumpWorkspaceEpoch(db: Db, workspaceId: string, now: Date): Promise<void> {
  await db
    .updateTable('workspaces')
    .set({ perm_epoch: sql<number>`perm_epoch + 1`, updated_at: now })
    .where('id', '=', workspaceId)
    .execute();
}

function toView(row: {
  id: string;
  name: string;
  allow_external_sharing: boolean;
  role: WorkspaceRole;
}): WorkspaceView {
  return {
    id: row.id,
    name: row.name,
    allowExternalSharing: row.allow_external_sharing,
    role: row.role,
  };
}

/** Lists the workspaces the user belongs to, with their role in each. */
export async function listWorkspaces(ctx: ServiceContext, userId: string): Promise<WorkspaceView[]> {
  const rows = await ctx.db
    .selectFrom('workspaces')
    .innerJoin('workspace_members', 'workspace_members.workspace_id', 'workspaces.id')
    .select([
      'workspaces.id',
      'workspaces.name',
      'workspaces.allow_external_sharing',
      'workspace_members.role',
    ])
    .where('workspace_members.user_id', '=', userId)
    .orderBy('workspaces.name')
    .execute();
  return rows.map(toView);
}

/** Creates a workspace owned by the user. */
export async function createWorkspace(
  ctx: ServiceContext,
  userId: string,
  input: { name: string },
): Promise<WorkspaceView> {
  const now = ctx.clock.now();
  return ctx.db.transaction().execute(async (trx) => {
    const workspace = await trx
      .insertInto('workspaces')
      .values({ name: input.name, created_at: now, updated_at: now })
      .returning(['id', 'name', 'allow_external_sharing'])
      .executeTakeFirstOrThrow();
    await trx
      .insertInto('workspace_members')
      .values({ workspace_id: workspace.id, user_id: userId, role: 'owner', created_at: now })
      .execute();
    return toView({ ...workspace, role: 'owner' });
  });
}

/** Renames a workspace or changes its external-sharing setting. */
export async function updateWorkspace(
  ctx: ServiceContext,
  actorId: string,
  workspaceId: string,
  input: WorkspaceUpdate,
): Promise<WorkspaceView> {
  const now = ctx.clock.now();
  let sharingChanged = false;
  const view = await ctx.db.transaction().execute(async (trx) => {
    const role = await requireManager(trx, workspaceId, actorId);
    const current = await trx
      .selectFrom('workspaces')
      .select(['allow_external_sharing'])
      .where('id', '=', workspaceId)
      .forUpdate()
      .executeTakeFirstOrThrow();

    const updated = await trx
      .updateTable('workspaces')
      .set({
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.allowExternalSharing !== undefined
          ? { allow_external_sharing: input.allowExternalSharing }
          : {}),
        updated_at: now,
      })
      .where('id', '=', workspaceId)
      .returning(['id', 'name', 'allow_external_sharing'])
      .executeTakeFirstOrThrow();

    sharingChanged =
      input.allowExternalSharing !== undefined &&
      input.allowExternalSharing !== current.allow_external_sharing;
    if (sharingChanged) {
      if (!input.allowExternalSharing) {
        await trx
          .deleteFrom('doc_shares')
          .where('doc_id', 'in', trx.selectFrom('docs').select('id').where('workspace_id', '=', workspaceId))
          .where(
            'user_id',
            'not in',
            trx.selectFrom('workspace_members').select('user_id').where('workspace_id', '=', workspaceId),
          )
          .execute();
      }
      await bumpWorkspaceEpoch(trx, workspaceId, now);
    }
    return toView({ ...updated, role });
  });
  if (sharingChanged) ctx.notifier.control({ kind: 'workspace_perm', workspaceId });
  return view;
}

/** Lists the members of a workspace the caller belongs to. */
export async function listMembers(
  ctx: ServiceContext,
  actorId: string,
  workspaceId: string,
): Promise<MemberView[]> {
  await requireRole(ctx.db, workspaceId, actorId);
  const rows = await ctx.db
    .selectFrom('workspace_members')
    .innerJoin('users', 'users.id', 'workspace_members.user_id')
    .select([
      'users.id',
      'users.email',
      'users.name',
      'workspace_members.role',
      'workspace_members.created_at',
    ])
    .where('workspace_members.workspace_id', '=', workspaceId)
    .orderBy('users.name')
    .execute();
  return rows.map((row) => ({
    userId: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    joinedAt: row.created_at,
  }));
}

/** Adds an existing user, found by email, to the workspace. */
export async function addMember(
  ctx: ServiceContext,
  actorId: string,
  workspaceId: string,
  input: { email: string; role: 'admin' | 'member' },
): Promise<MemberView> {
  const now = ctx.clock.now();
  const member = await ctx.db.transaction().execute(async (trx) => {
    const actorRole = await requireManager(trx, workspaceId, actorId);
    if (input.role === 'admin' && actorRole !== 'owner') {
      throw errors.forbidden('Only the workspace owner can appoint admins.');
    }
    const user = await trx
      .selectFrom('users')
      .select(['id', 'email', 'name'])
      .where('email', '=', input.email.toLowerCase())
      .executeTakeFirst();
    if (!user) throw errors.userNotFound();
    const inserted = await trx
      .insertInto('workspace_members')
      .values({ workspace_id: workspaceId, user_id: user.id, role: input.role, created_at: now })
      .onConflict((oc) => oc.columns(['workspace_id', 'user_id']).doNothing())
      .returning('created_at')
      .executeTakeFirst();
    if (!inserted) throw errors.invalidState('That user is already a member.');
    await bumpWorkspaceEpoch(trx, workspaceId, now);
    return {
      userId: user.id,
      email: user.email,
      name: user.name,
      role: input.role,
      joinedAt: inserted.created_at,
    };
  });
  ctx.notifier.control({ kind: 'workspace_perm', workspaceId });
  return member;
}

/** Changes a member's role between `admin` and `member`. */
export async function updateMember(
  ctx: ServiceContext,
  actorId: string,
  workspaceId: string,
  userId: string,
  input: { role: 'admin' | 'member' },
): Promise<void> {
  const now = ctx.clock.now();
  const changed = await ctx.db.transaction().execute(async (trx) => {
    const actorRole = await requireManager(trx, workspaceId, actorId);
    const targetRole = await workspaceRole(trx, workspaceId, userId);
    if (targetRole === null) throw errors.notFound('Member not found.');
    if (targetRole === 'owner') throw errors.ownerRequired();
    if (targetRole === input.role) return false;
    if (actorRole !== 'owner') throw errors.forbidden('Only the workspace owner can change admins.');
    await trx
      .updateTable('workspace_members')
      .set({ role: input.role })
      .where('workspace_id', '=', workspaceId)
      .where('user_id', '=', userId)
      .execute();
    await bumpWorkspaceEpoch(trx, workspaceId, now);
    return true;
  });
  if (changed) ctx.notifier.control({ kind: 'workspace_perm', workspaceId });
}

/**
 * Removes a member: their shares on the workspace's documents go unless
 * external sharing is on, and the documents they own pass to the workspace owner.
 */
export async function removeMember(
  ctx: ServiceContext,
  actorId: string,
  workspaceId: string,
  userId: string,
): Promise<void> {
  const now = ctx.clock.now();
  await ctx.db.transaction().execute(async (trx) => {
    const actorRole = await requireManager(trx, workspaceId, actorId);
    const workspace = await trx
      .selectFrom('workspaces')
      .select(['allow_external_sharing'])
      .where('id', '=', workspaceId)
      .forUpdate()
      .executeTakeFirstOrThrow();
    const targetRole = await workspaceRole(trx, workspaceId, userId);
    if (targetRole === null) throw errors.notFound('Member not found.');
    if (targetRole === 'owner') throw errors.ownerRequired();
    if (targetRole === 'admin' && actorRole !== 'owner') {
      throw errors.forbidden('Only the workspace owner can remove admins.');
    }
    const owner = await trx
      .selectFrom('workspace_members')
      .select('user_id')
      .where('workspace_id', '=', workspaceId)
      .where('role', '=', 'owner')
      .executeTakeFirstOrThrow();

    const workspaceDocs = trx.selectFrom('docs').select('id').where('workspace_id', '=', workspaceId);
    if (!workspace.allow_external_sharing) {
      await trx
        .deleteFrom('doc_shares')
        .where('user_id', '=', userId)
        .where('doc_id', 'in', workspaceDocs)
        .execute();
    }

    const transferred = await trx
      .updateTable('docs')
      .set({ owner_id: owner.user_id, perm_epoch: sql<number>`perm_epoch + 1`, updated_at: now })
      .where('workspace_id', '=', workspaceId)
      .where('owner_id', '=', userId)
      .returning('id')
      .execute();
    if (transferred.length > 0) {
      await trx
        .deleteFrom('doc_shares')
        .where('user_id', '=', owner.user_id)
        .where(
          'doc_id',
          'in',
          transferred.map((doc) => doc.id),
        )
        .execute();
    }

    await trx
      .deleteFrom('workspace_members')
      .where('workspace_id', '=', workspaceId)
      .where('user_id', '=', userId)
      .execute();
    await bumpWorkspaceEpoch(trx, workspaceId, now);
  });
  ctx.notifier.control({ kind: 'workspace_perm', workspaceId });
}

/** Makes another member the workspace owner; the previous owner becomes an admin. */
export async function transferWorkspace(
  ctx: ServiceContext,
  actorId: string,
  workspaceId: string,
  input: { userId: string },
): Promise<void> {
  const now = ctx.clock.now();
  const changed = await ctx.db.transaction().execute(async (trx) => {
    const actorRole = await requireRole(trx, workspaceId, actorId);
    if (actorRole !== 'owner') throw errors.forbidden('Only the workspace owner can transfer it.');
    await trx
      .selectFrom('workspaces')
      .select('id')
      .where('id', '=', workspaceId)
      .forUpdate()
      .executeTakeFirstOrThrow();
    const targetRole = await workspaceRole(trx, workspaceId, input.userId);
    if (targetRole === null) throw errors.notAMember();
    if (input.userId === actorId) return false;
    await trx
      .updateTable('workspace_members')
      .set({ role: 'admin' })
      .where('workspace_id', '=', workspaceId)
      .where('user_id', '=', actorId)
      .execute();
    await trx
      .updateTable('workspace_members')
      .set({ role: 'owner' })
      .where('workspace_id', '=', workspaceId)
      .where('user_id', '=', input.userId)
      .execute();
    await bumpWorkspaceEpoch(trx, workspaceId, now);
    return true;
  });
  if (changed) ctx.notifier.control({ kind: 'workspace_perm', workspaceId });
}
