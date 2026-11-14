import type { MembershipRole } from '../db/types.js';
import { forbidden } from './errors.js';

export type Role = MembershipRole;

export type Action =
  | 'org.update'
  | 'org.delete'
  | 'member.manage'
  | 'member.grantOwner'
  | 'project.manage'
  | 'label.manage'
  | 'issue.create'
  | 'issue.update'
  | 'issue.delete'
  | 'comment.create'
  | 'comment.editOwn'
  | 'comment.deleteOwn'
  | 'comment.deleteAny';

const RANK: Record<Role, number> = { viewer: 0, member: 1, admin: 2, owner: 3 };

const MINIMUM_ROLE: Record<Action, Role> = {
  'org.update': 'owner',
  'org.delete': 'owner',
  'member.manage': 'admin',
  'member.grantOwner': 'owner',
  'project.manage': 'admin',
  'label.manage': 'admin',
  'issue.create': 'member',
  'issue.update': 'member',
  'issue.delete': 'admin',
  'comment.create': 'member',
  'comment.editOwn': 'member',
  'comment.deleteOwn': 'member',
  'comment.deleteAny': 'admin',
};

/** Every role may read everything in its org; this covers writes only. */
export function can(role: Role, action: Action): boolean {
  return RANK[role] >= RANK[MINIMUM_ROLE[action]];
}

export function assertCan(role: Role, action: Action): void {
  if (!can(role, action)) {
    throw forbidden();
  }
}

/**
 * Whether `actor` may move a member from `targetRole` to `nextRole`, where `null` means
 * removing them. Anything that grants or takes away `owner` needs an owner.
 */
export function canManageMember(actor: Role, targetRole: Role, nextRole: Role | null): boolean {
  if (!can(actor, 'member.manage')) return false;
  const touchesOwner = targetRole === 'owner' || nextRole === 'owner';
  return !touchesOwner || can(actor, 'member.grantOwner');
}
