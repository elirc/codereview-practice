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
