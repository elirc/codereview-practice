export type DocRole = 'viewer' | 'commenter' | 'editor' | 'owner';

const RANK: Record<DocRole, number> = { viewer: 1, commenter: 2, editor: 3, owner: 4 };

export function atLeast(role: DocRole | null, min: DocRole): boolean {
  return role !== null && RANK[role] >= RANK[min];
}

export const canEdit = (role: DocRole | null) => atLeast(role, 'editor');
export const canComment = (role: DocRole | null) => atLeast(role, 'commenter');
