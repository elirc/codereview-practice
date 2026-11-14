export const WORKSPACE_ROLES = ['owner', 'admin', 'member'] as const;
export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number];

export const DOC_ROLES = ['viewer', 'commenter', 'editor', 'owner'] as const;
export type DocRole = (typeof DOC_ROLES)[number];

export const SHARE_ROLES = ['viewer', 'commenter', 'editor'] as const;
export type ShareRole = (typeof SHARE_ROLES)[number];

export const WORKSPACE_ACCESS = ['none', 'viewer', 'commenter', 'editor'] as const;
export type WorkspaceAccess = (typeof WORKSPACE_ACCESS)[number];

/** Returns true for workspace roles that manage members and settings. */
export function isWorkspaceManager(role: WorkspaceRole | null): boolean {
  return role === 'owner' || role === 'admin';
}

const RANK: Record<DocRole, number> = { viewer: 1, commenter: 2, editor: 3, owner: 4 };

/** Returns whether `role` is at least `min`; a missing role satisfies nothing. */
export function roleAtLeast(role: DocRole | null, min: DocRole): boolean {
  return role !== null && RANK[role] >= RANK[min];
}

/** Returns the higher of two roles. */
export function higherRole(a: DocRole | null, b: DocRole | null): DocRole | null {
  if (a === null) return b;
  if (b === null) return a;
  return RANK[a] >= RANK[b] ? a : b;
}

export interface LinkGrant {
  role: ShareRole;
  expiresAt: Date | null;
  revokedAt: Date | null;
}

/** Returns whether a link is unrevoked and `now` is before its expiry. */
export function linkIsActive(link: LinkGrant, now: Date): boolean {
  if (link.revokedAt !== null) return false;
  return link.expiresAt === null || now.getTime() < link.expiresAt.getTime();
}

/**
 * Returns the role a link grants: an active `viewer` link works for anyone,
 * `commenter` and `editor` links only for a signed-in user.
 */
export function linkRole(link: LinkGrant | null, authenticated: boolean, now: Date): ShareRole | null {
  if (link === null || !linkIsActive(link, now)) return null;
  if (link.role !== 'viewer' && !authenticated) return null;
  return link.role;
}

export interface RoleSources {
  authenticated: boolean;
  isDocOwner: boolean;
  workspaceRole: WorkspaceRole | null;
  shareRole: ShareRole | null;
  workspaceAccess: WorkspaceAccess;
  link: LinkGrant | null;
}

/** Returns the highest document role any source grants, or null for no access. */
export function effectiveRole(sources: RoleSources, now: Date): DocRole | null {
  let role: DocRole | null = null;
  if (sources.authenticated) {
    if (sources.isDocOwner) role = higherRole(role, 'owner');
    if (isWorkspaceManager(sources.workspaceRole)) role = higherRole(role, 'editor');
    role = higherRole(role, sources.shareRole);
    if (sources.workspaceRole !== null && sources.workspaceAccess !== 'none') {
      role = higherRole(role, sources.workspaceAccess);
    }
  }
  return higherRole(role, linkRole(sources.link, sources.authenticated, now));
}

/** Returns whether the principal may manage sharing, trash and ownership of a document. */
export function canManageDoc(sources: { isDocOwner: boolean; workspaceRole: WorkspaceRole | null }): boolean {
  return sources.isDocOwner || isWorkspaceManager(sources.workspaceRole);
}

export const canEdit = (role: DocRole | null): boolean => roleAtLeast(role, 'editor');

export const canComment = (role: DocRole | null): boolean => roleAtLeast(role, 'commenter');

/** Returns whether a role may resolve or reopen a thread. */
export function canResolveThread(role: DocRole | null, isThreadAuthor: boolean): boolean {
  return canEdit(role) || (role === 'commenter' && isThreadAuthor);
}

/** Returns whether a connection may publish presence. */
export function canSendPresence(role: DocRole | null, authenticated: boolean): boolean {
  return role !== null && authenticated;
}
