import { describe, expect, it } from 'vitest';
import { can, canManageMember, type Action, type Role } from '../../src/lib/permissions.js';

const ROLES: Role[] = ['viewer', 'member', 'admin', 'owner'];

const EXPECTED: Record<Action, Role[]> = {
  'issue.create': ['member', 'admin', 'owner'],
  'issue.update': ['member', 'admin', 'owner'],
  'comment.create': ['member', 'admin', 'owner'],
  'comment.editOwn': ['member', 'admin', 'owner'],
  'comment.deleteOwn': ['member', 'admin', 'owner'],
  'comment.deleteAny': ['admin', 'owner'],
  'issue.delete': ['admin', 'owner'],
  'project.manage': ['admin', 'owner'],
  'label.manage': ['admin', 'owner'],
  'member.manage': ['admin', 'owner'],
  'member.grantOwner': ['owner'],
  'org.update': ['owner'],
  'org.delete': ['owner'],
};

describe('permission table', () => {
  for (const [action, allowed] of Object.entries(EXPECTED) as [Action, Role[]][]) {
    it(`allows ${action} for ${allowed.join(', ')} only`, () => {
      expect(ROLES.filter((role) => can(role, action))).toEqual(allowed);
    });
  }
});

describe('canManageMember', () => {
  it('lets admins move members between non-owner roles', () => {
    expect(canManageMember('admin', 'member', 'admin')).toBe(true);
    expect(canManageMember('admin', 'viewer', 'member')).toBe(true);
    expect(canManageMember('admin', 'member', null)).toBe(true);
  });

  it('stops admins from touching owners or granting ownership', () => {
    expect(canManageMember('admin', 'owner', 'admin')).toBe(false);
    expect(canManageMember('admin', 'owner', null)).toBe(false);
    expect(canManageMember('admin', 'member', 'owner')).toBe(false);
  });

  it('lets owners grant and revoke ownership', () => {
    expect(canManageMember('owner', 'member', 'owner')).toBe(true);
    expect(canManageMember('owner', 'owner', 'member')).toBe(true);
    expect(canManageMember('owner', 'owner', null)).toBe(true);
  });

  it('never lets members or viewers manage anyone', () => {
    expect(canManageMember('member', 'viewer', 'member')).toBe(false);
    expect(canManageMember('viewer', 'viewer', null)).toBe(false);
  });
});
