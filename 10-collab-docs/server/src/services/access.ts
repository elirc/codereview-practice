import type { Db } from '../db/db.js';
import {
  canManageDoc,
  effectiveRole,
  linkRole,
  roleAtLeast,
  type DocRole,
  type LinkGrant,
  type WorkspaceAccess,
  type WorkspaceRole,
  type ShareRole,
} from '../domain/roles.js';
import { errors } from '../http/errors.js';
import { sha256Hex } from '../lib/random.js';

export type LinkRef = { token: string } | { id: string };

export interface Principal {
  userId: string | null;
  link: LinkRef | null;
}

export type UserPrincipal = Principal & { userId: string };

export interface DocAccess {
  docId: string;
  workspaceId: string;
  ownerId: string;
  title: string;
  workspaceAccess: WorkspaceAccess;
  role: DocRole;
  canManage: boolean;
  isDocOwner: boolean;
  workspaceRole: WorkspaceRole | null;
  docEpoch: number;
  workspaceEpoch: number;
  linkId: string | null;
  linkExpiresAt: Date | null;
  trashedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export type AccessResult =
  | { kind: 'ok'; access: DocAccess }
  | { kind: 'none' }
  | { kind: 'trashed' }
  | { kind: 'missing' };

export interface AccessOptions {
  /** Resolve roles on a trashed document instead of reporting it as trashed. */
  allowTrashed?: boolean;
}

/** Resolves the principal's effective role on a document from current database state. */
export async function resolveDocAccess(
  db: Db,
  docId: string,
  principal: Principal,
  now: Date,
  options: AccessOptions = {},
): Promise<AccessResult> {
  const doc = await db
    .selectFrom('docs')
    .innerJoin('workspaces', 'workspaces.id', 'docs.workspace_id')
    .select([
      'docs.id',
      'docs.workspace_id',
      'docs.owner_id',
      'docs.title',
      'docs.workspace_access',
      'docs.perm_epoch',
      'docs.trashed_at',
      'docs.created_at',
      'docs.updated_at',
      'workspaces.perm_epoch as workspace_epoch',
    ])
    .where('docs.id', '=', docId)
    .executeTakeFirst();
  if (!doc) return { kind: 'missing' };

  let workspaceRole: WorkspaceRole | null = null;
  let shareRole: ShareRole | null = null;
  if (principal.userId !== null) {
    const member = await db
      .selectFrom('workspace_members')
      .select('role')
      .where('workspace_id', '=', doc.workspace_id)
      .where('user_id', '=', principal.userId)
      .executeTakeFirst();
    workspaceRole = member?.role ?? null;
    const share = await db
      .selectFrom('doc_shares')
      .select('role')
      .where('doc_id', '=', docId)
      .where('user_id', '=', principal.userId)
      .executeTakeFirst();
    shareRole = share?.role ?? null;
  }

  let link: (LinkGrant & { id: string }) | null = null;
  if (principal.link !== null) {
    const ref = principal.link;
    const query = db
      .selectFrom('doc_links')
      .select(['id', 'role', 'expires_at', 'revoked_at'])
      .where('doc_id', '=', docId);
    const row = await ('token' in ref
      ? query.where('token_hash', '=', sha256Hex(ref.token))
      : query.where('id', '=', ref.id)
    ).executeTakeFirst();
    if (row) {
      link = { id: row.id, role: row.role, expiresAt: row.expires_at, revokedAt: row.revoked_at };
    }
  }

  const authenticated = principal.userId !== null;
  const isDocOwner = authenticated && doc.owner_id === principal.userId;
  const role = effectiveRole(
    { authenticated, isDocOwner, workspaceRole, shareRole, workspaceAccess: doc.workspace_access, link },
    now,
  );
  if (role === null) return { kind: 'none' };
  if (doc.trashed_at !== null && !options.allowTrashed) return { kind: 'trashed' };

  const linkCounts = link !== null && linkRole(link, authenticated, now) !== null;
  return {
    kind: 'ok',
    access: {
      docId: doc.id,
      workspaceId: doc.workspace_id,
      ownerId: doc.owner_id,
      title: doc.title,
      workspaceAccess: doc.workspace_access,
      role,
      canManage: canManageDoc({ isDocOwner, workspaceRole }),
      isDocOwner,
      workspaceRole,
      docEpoch: doc.perm_epoch,
      workspaceEpoch: doc.workspace_epoch,
      linkId: linkCounts && link ? link.id : null,
      linkExpiresAt: linkCounts && link ? link.expiresAt : null,
      trashedAt: doc.trashed_at,
      createdAt: doc.created_at,
      updatedAt: doc.updated_at,
    },
  };
}

export interface Requirement extends AccessOptions {
  /** Minimum document role. */
  min?: DocRole;
  /** Require the right to manage sharing, trash and ownership. */
  manage?: boolean;
}

/**
 * Returns the principal's access to a document, throwing `not_found` when
 * they have none and `forbidden` when it falls short of the requirement.
 */
export async function requireDocAccess(
  db: Db,
  docId: string,
  principal: Principal,
  now: Date,
  requirement: Requirement = {},
): Promise<DocAccess> {
  const result = await resolveDocAccess(db, docId, principal, now, requirement);
  if (result.kind !== 'ok') throw errors.notFound('Document not found.');
  const { access } = result;
  if (requirement.min && !roleAtLeast(access.role, requirement.min)) throw errors.forbidden();
  if (requirement.manage && !access.canManage) throw errors.forbidden();
  return access;
}
