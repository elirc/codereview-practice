import type { ShareRole } from '../domain/roles.js';
import { errors } from '../http/errors.js';
import { sha256Hex } from '../lib/random.js';
import { requireDocAccess, type Principal, type UserPrincipal } from './access.js';
import type { ServiceContext } from './context.js';
import { bumpDocEpoch } from './docs.js';

export interface ShareView {
  userId: string;
  email: string;
  name: string;
  role: ShareRole;
  external: boolean;
}

export interface LinkView {
  id: string;
  role: ShareRole;
  expiresAt: Date | null;
  revokedAt: Date | null;
  createdBy: string;
  createdAt: Date;
}

/** Lists a document's shares for someone who manages it. */
export async function listShares(
  ctx: ServiceContext,
  docId: string,
  principal: Principal,
): Promise<ShareView[]> {
  const access = await requireDocAccess(ctx.db, docId, principal, ctx.clock.now(), { manage: true });
  const rows = await ctx.db
    .selectFrom('doc_shares')
    .innerJoin('users', 'users.id', 'doc_shares.user_id')
    .leftJoin('workspace_members', (join) =>
      join
        .onRef('workspace_members.user_id', '=', 'doc_shares.user_id')
        .on('workspace_members.workspace_id', '=', access.workspaceId),
    )
    .select([
      'users.id',
      'users.email',
      'users.name',
      'doc_shares.role',
      'workspace_members.role as member_role',
    ])
    .where('doc_shares.doc_id', '=', docId)
    .orderBy('users.name')
    .execute();
  return rows.map((row) => ({
    userId: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    external: row.member_role === null,
  }));
}

/** Shares a document with a user found by email, or changes the role of an existing share. */
export async function shareDoc(
  ctx: ServiceContext,
  docId: string,
  principal: Principal,
  input: { email: string; role: ShareRole },
): Promise<ShareView> {
  const now = ctx.clock.now();
  const share = await ctx.db.transaction().execute(async (trx) => {
    const access = await requireDocAccess(trx, docId, principal, now, { manage: true });
    const workspace = await trx
      .selectFrom('workspaces')
      .select('allow_external_sharing')
      .where('id', '=', access.workspaceId)
      .forShare()
      .executeTakeFirstOrThrow();
    const user = await trx
      .selectFrom('users')
      .select(['id', 'email', 'name'])
      .where('email', '=', input.email.toLowerCase())
      .executeTakeFirst();
    if (!user) throw errors.userNotFound();
    if (user.id === access.ownerId) {
      throw errors.invalidState('That user already owns the document.', 422);
    }
    const member = await trx
      .selectFrom('workspace_members')
      .select('role')
      .where('workspace_id', '=', access.workspaceId)
      .where('user_id', '=', user.id)
      .executeTakeFirst();
    if (!member && !workspace.allow_external_sharing) throw errors.externalSharingDisabled();
    await trx
      .insertInto('doc_shares')
      .values({ doc_id: docId, user_id: user.id, role: input.role, created_at: now })
      .onConflict((oc) => oc.columns(['doc_id', 'user_id']).doUpdateSet({ role: input.role }))
      .execute();
    await bumpDocEpoch(trx, docId, now);
    return { userId: user.id, email: user.email, name: user.name, role: input.role, external: !member };
  });
  ctx.notifier.doc(docId, { kind: 'perm' });
  return share;
}

/** Changes the role of an existing share. */
export async function updateShare(
  ctx: ServiceContext,
  docId: string,
  principal: Principal,
  userId: string,
  input: { role: ShareRole },
): Promise<void> {
  const now = ctx.clock.now();
  await ctx.db.transaction().execute(async (trx) => {
    await requireDocAccess(trx, docId, principal, now, { manage: true });
    const updated = await trx
      .updateTable('doc_shares')
      .set({ role: input.role })
      .where('doc_id', '=', docId)
      .where('user_id', '=', userId)
      .executeTakeFirst();
    if (updated.numUpdatedRows === 0n) throw errors.notFound('Share not found.');
    await bumpDocEpoch(trx, docId, now);
  });
  ctx.notifier.doc(docId, { kind: 'perm' });
}

/** Removes a share. */
export async function deleteShare(
  ctx: ServiceContext,
  docId: string,
  principal: Principal,
  userId: string,
): Promise<void> {
  const now = ctx.clock.now();
  await ctx.db.transaction().execute(async (trx) => {
    await requireDocAccess(trx, docId, principal, now, { manage: true });
    const deleted = await trx
      .deleteFrom('doc_shares')
      .where('doc_id', '=', docId)
      .where('user_id', '=', userId)
      .executeTakeFirst();
    if (deleted.numDeletedRows === 0n) throw errors.notFound('Share not found.');
    await bumpDocEpoch(trx, docId, now);
  });
  ctx.notifier.doc(docId, { kind: 'perm' });
}

function linkView(row: {
  id: string;
  role: ShareRole;
  expires_at: Date | null;
  revoked_at: Date | null;
  created_by: string;
  created_at: Date;
}): LinkView {
  return {
    id: row.id,
    role: row.role,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

/** Lists a document's links, including revoked and expired ones. */
export async function listLinks(
  ctx: ServiceContext,
  docId: string,
  principal: Principal,
): Promise<LinkView[]> {
  await requireDocAccess(ctx.db, docId, principal, ctx.clock.now(), { manage: true });
  const rows = await ctx.db
    .selectFrom('doc_links')
    .select(['id', 'role', 'expires_at', 'revoked_at', 'created_by', 'created_at'])
    .where('doc_id', '=', docId)
    .orderBy('created_at', 'desc')
    .execute();
  return rows.map(linkView);
}

/** Creates a link and returns it with its token, which is not stored and not shown again. */
export async function createLink(
  ctx: ServiceContext,
  docId: string,
  principal: UserPrincipal,
  input: { role: ShareRole; expiresAt: Date | null },
): Promise<{ link: LinkView; token: string }> {
  const now = ctx.clock.now();
  if (input.expiresAt !== null && input.expiresAt.getTime() <= now.getTime()) {
    throw errors.validation([{ path: 'expiresAt', message: 'Must be in the future' }]);
  }
  const token = ctx.random.token();
  const link = await ctx.db.transaction().execute(async (trx) => {
    await requireDocAccess(trx, docId, principal, now, { manage: true });
    const row = await trx
      .insertInto('doc_links')
      .values({
        doc_id: docId,
        token_hash: sha256Hex(token),
        role: input.role,
        expires_at: input.expiresAt,
        created_by: principal.userId,
        created_at: now,
      })
      .returning(['id', 'role', 'expires_at', 'revoked_at', 'created_by', 'created_at'])
      .executeTakeFirstOrThrow();
    await bumpDocEpoch(trx, docId, now);
    return linkView(row);
  });
  ctx.notifier.doc(docId, { kind: 'perm' });
  return { link, token };
}

/** Revokes a link; revoking an already revoked link changes nothing. */
export async function revokeLink(
  ctx: ServiceContext,
  docId: string,
  principal: Principal,
  linkId: string,
): Promise<void> {
  const now = ctx.clock.now();
  const changed = await ctx.db.transaction().execute(async (trx) => {
    await requireDocAccess(trx, docId, principal, now, { manage: true });
    const link = await trx
      .selectFrom('doc_links')
      .select(['revoked_at'])
      .where('id', '=', linkId)
      .where('doc_id', '=', docId)
      .forUpdate()
      .executeTakeFirst();
    if (!link) throw errors.notFound('Link not found.');
    if (link.revoked_at !== null) return false;
    await trx.updateTable('doc_links').set({ revoked_at: now }).where('id', '=', linkId).execute();
    await bumpDocEpoch(trx, docId, now);
    return true;
  });
  if (changed) ctx.notifier.doc(docId, { kind: 'perm' });
}
