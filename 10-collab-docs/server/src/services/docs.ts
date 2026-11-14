import { sql } from 'kysely';
import type { Db } from '../db/db.js';
import {
  canManageDoc,
  effectiveRole,
  roleAtLeast,
  type DocRole,
  type WorkspaceAccess,
} from '../domain/roles.js';
import { errors } from '../http/errors.js';
import {
  requireDocAccess,
  type DocAccess,
  type Principal,
  type UserPrincipal,
} from './access.js';
import type { ServiceContext } from './context.js';
import { workspaceRole } from './workspaces.js';

export interface DocView {
  id: string;
  workspaceId: string;
  title: string;
  ownerId: string;
  workspaceAccess: WorkspaceAccess;
  role: DocRole;
  canManage: boolean;
  trashedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface DocUpdate {
  title?: string;
  workspaceAccess?: WorkspaceAccess;
}

/** Returns the API view of a document for a resolved access. */
export function docView(access: DocAccess): DocView {
  return {
    id: access.docId,
    workspaceId: access.workspaceId,
    title: access.title,
    ownerId: access.ownerId,
    workspaceAccess: access.workspaceAccess,
    role: access.role,
    canManage: access.canManage,
    trashedAt: access.trashedAt,
    createdAt: access.createdAt,
    updatedAt: access.updatedAt,
  };
}

/** Increments a document's permission epoch. */
export async function bumpDocEpoch(db: Db, docId: string, now: Date): Promise<void> {
  await db
    .updateTable('docs')
    .set({ perm_epoch: sql<number>`perm_epoch + 1`, updated_at: now })
    .where('id', '=', docId)
    .execute();
}

/** Creates a document owned by the caller in a workspace they belong to. */
export async function createDoc(
  ctx: ServiceContext,
  userId: string,
  workspaceId: string,
  input: { title: string; workspaceAccess?: WorkspaceAccess },
): Promise<DocView> {
  const role = await workspaceRole(ctx.db, workspaceId, userId);
  if (role === null) throw errors.notFound('Workspace not found.');
  const now = ctx.clock.now();
  const row = await ctx.db
    .insertInto('docs')
    .values({
      workspace_id: workspaceId,
      title: input.title,
      owner_id: userId,
      workspace_access: input.workspaceAccess ?? 'none',
      created_at: now,
      updated_at: now,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    title: row.title,
    ownerId: row.owner_id,
    workspaceAccess: row.workspace_access,
    role: 'owner',
    canManage: true,
    trashedAt: null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Lists the workspace's documents the caller can open, or with `trashed`
 * the trashed documents the caller may restore.
 */
export async function listDocs(
  ctx: ServiceContext,
  userId: string,
  workspaceId: string,
  options: { trashed: boolean },
): Promise<DocView[]> {
  const now = ctx.clock.now();
  const memberRole = await workspaceRole(ctx.db, workspaceId, userId);
  const rows = await ctx.db
    .selectFrom('docs')
    .leftJoin('doc_shares', (join) =>
      join.onRef('doc_shares.doc_id', '=', 'docs.id').on('doc_shares.user_id', '=', userId),
    )
    .select([
      'docs.id',
      'docs.workspace_id',
      'docs.title',
      'docs.owner_id',
      'docs.workspace_access',
      'docs.trashed_at',
      'docs.created_at',
      'docs.updated_at',
      'doc_shares.role as share_role',
    ])
    .where('docs.workspace_id', '=', workspaceId)
    .where('docs.trashed_at', options.trashed ? 'is not' : 'is', null)
    .orderBy('docs.updated_at', 'desc')
    .execute();

  const views: DocView[] = [];
  for (const row of rows) {
    const isDocOwner = row.owner_id === userId;
    const role = effectiveRole(
      {
        authenticated: true,
        isDocOwner,
        workspaceRole: memberRole,
        shareRole: row.share_role,
        workspaceAccess: row.workspace_access,
        link: null,
      },
      now,
    );
    if (role === null) continue;
    const canManage = canManageDoc({ isDocOwner, workspaceRole: memberRole });
    if (options.trashed && !canManage) continue;
    views.push({
      id: row.id,
      workspaceId: row.workspace_id,
      title: row.title,
      ownerId: row.owner_id,
      workspaceAccess: row.workspace_access,
      role,
      canManage,
      trashedAt: row.trashed_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
  }
  if (memberRole === null && views.length === 0) throw errors.notFound('Workspace not found.');
  return views;
}

/** Returns a document the principal can open, with their role. */
export async function getDoc(ctx: ServiceContext, docId: string, principal: Principal): Promise<DocView> {
  return docView(await requireDocAccess(ctx.db, docId, principal, ctx.clock.now()));
}

/** Renames a document (editor) or changes its workspace access (manager). */
export async function updateDoc(
  ctx: ServiceContext,
  docId: string,
  principal: Principal,
  input: DocUpdate,
): Promise<DocView> {
  const now = ctx.clock.now();
  const result = await ctx.db.transaction().execute(async (trx) => {
    const access = await requireDocAccess(trx, docId, principal, now, { min: 'viewer' });
    if (input.title !== undefined && !roleAtLeast(access.role, 'editor')) throw errors.forbidden();
    const accessChanged =
      input.workspaceAccess !== undefined && input.workspaceAccess !== access.workspaceAccess;
    if (input.workspaceAccess !== undefined && !access.canManage) throw errors.forbidden();
    const titleChanged = input.title !== undefined && input.title !== access.title;

    if (titleChanged || accessChanged) {
      await trx
        .updateTable('docs')
        .set({
          ...(titleChanged ? { title: input.title } : {}),
          ...(accessChanged ? { workspace_access: input.workspaceAccess } : {}),
          ...(accessChanged ? { perm_epoch: sql<number>`perm_epoch + 1` } : {}),
          updated_at: now,
        })
        .where('id', '=', docId)
        .execute();
    }
    const fresh = await requireDocAccess(trx, docId, principal, now);
    return { view: docView(fresh), titleChanged, accessChanged };
  });
  if (result.titleChanged) ctx.notifier.doc(docId, { kind: 'meta', title: result.view.title });
  if (result.accessChanged) ctx.notifier.doc(docId, { kind: 'perm' });
  return result.view;
}

/** Transfers a document to another member of its workspace. */
export async function transferDoc(
  ctx: ServiceContext,
  docId: string,
  principal: Principal,
  input: { userId: string },
): Promise<DocView> {
  const now = ctx.clock.now();
  const result = await ctx.db.transaction().execute(async (trx) => {
    const access = await requireDocAccess(trx, docId, principal, now, { manage: true });
    const targetRole = await workspaceRole(trx, access.workspaceId, input.userId);
    if (targetRole === null) throw errors.notAMember();
    if (input.userId === access.ownerId) return { view: docView(access), changed: false };
    await trx
      .updateTable('docs')
      .set({ owner_id: input.userId, perm_epoch: sql<number>`perm_epoch + 1`, updated_at: now })
      .where('id', '=', docId)
      .execute();
    await trx
      .deleteFrom('doc_shares')
      .where('doc_id', '=', docId)
      .where('user_id', '=', input.userId)
      .execute();
    const fresh = await requireDocAccess(trx, docId, principal, now);
    return { view: docView(fresh), changed: true };
  });
  if (result.changed) ctx.notifier.doc(docId, { kind: 'perm' });
  return result.view;
}

/** Moves a document to the trash. */
export async function trashDoc(
  ctx: ServiceContext,
  docId: string,
  principal: UserPrincipal,
): Promise<void> {
  const now = ctx.clock.now();
  await ctx.db.transaction().execute(async (trx) => {
    const access = await requireDocAccess(trx, docId, principal, now, {
      manage: true,
      allowTrashed: true,
    });
    if (access.trashedAt !== null) throw errors.invalidState('The document is already in the trash.');
    const updated = await trx
      .updateTable('docs')
      .set({
        trashed_at: now,
        trashed_by: principal.userId,
        perm_epoch: sql<number>`perm_epoch + 1`,
        updated_at: now,
      })
      .where('id', '=', docId)
      .where('trashed_at', 'is', null)
      .executeTakeFirst();
    if (updated.numUpdatedRows === 0n) {
      throw errors.invalidState('The document is already in the trash.');
    }
  });
  ctx.notifier.doc(docId, { kind: 'trashed' });
}

/** Restores a document from the trash. */
export async function restoreDoc(
  ctx: ServiceContext,
  docId: string,
  principal: Principal,
): Promise<DocView> {
  const now = ctx.clock.now();
  const view = await ctx.db.transaction().execute(async (trx) => {
    const access = await requireDocAccess(trx, docId, principal, now, {
      manage: true,
      allowTrashed: true,
    });
    if (access.trashedAt === null) throw errors.invalidState('The document is not in the trash.');
    await trx
      .updateTable('docs')
      .set({
        trashed_at: null,
        trashed_by: null,
        perm_epoch: sql<number>`perm_epoch + 1`,
        updated_at: now,
      })
      .where('id', '=', docId)
      .execute();
    return docView(await requireDocAccess(trx, docId, principal, now));
  });
  ctx.notifier.doc(docId, { kind: 'perm' });
  return view;
}
