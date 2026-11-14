import { describe, expect, it } from 'vitest';
import {
  canManageDoc,
  canResolveThread,
  effectiveRole,
  higherRole,
  linkRole,
  roleAtLeast,
  type LinkGrant,
  type RoleSources,
  type ShareRole,
  type WorkspaceAccess,
  type WorkspaceRole,
} from '../../src/domain/roles.js';

const now = new Date('2026-03-02T09:00:00.000Z');

const none: RoleSources = {
  authenticated: true,
  isDocOwner: false,
  workspaceRole: null,
  shareRole: null,
  workspaceAccess: 'none',
  link: null,
};

function link(role: ShareRole, extra: Partial<LinkGrant> = {}): LinkGrant {
  return { role, expiresAt: null, revokedAt: null, ...extra };
}

describe('role ordering', () => {
  it('orders viewer < commenter < editor < owner', () => {
    expect(roleAtLeast('owner', 'editor')).toBe(true);
    expect(roleAtLeast('editor', 'editor')).toBe(true);
    expect(roleAtLeast('commenter', 'editor')).toBe(false);
    expect(roleAtLeast(null, 'viewer')).toBe(false);
    expect(higherRole('viewer', 'commenter')).toBe('commenter');
    expect(higherRole(null, 'viewer')).toBe('viewer');
    expect(higherRole('owner', null)).toBe('owner');
  });
});

describe('effectiveRole', () => {
  it('grants nothing when no source applies', () => {
    expect(effectiveRole(none, now)).toBeNull();
  });

  it('makes the document owner owner', () => {
    expect(effectiveRole({ ...none, isDocOwner: true, workspaceRole: 'member' }, now)).toBe('owner');
  });

  it('makes workspace owners and admins editors', () => {
    for (const workspaceRole of ['owner', 'admin'] as WorkspaceRole[]) {
      expect(effectiveRole({ ...none, workspaceRole }, now)).toBe('editor');
    }
    expect(effectiveRole({ ...none, workspaceRole: 'member' }, now)).toBeNull();
  });

  it('applies workspace access to members only', () => {
    for (const access of ['viewer', 'commenter', 'editor'] as WorkspaceAccess[]) {
      expect(effectiveRole({ ...none, workspaceRole: 'member', workspaceAccess: access }, now)).toBe(
        access,
      );
      expect(effectiveRole({ ...none, workspaceAccess: access }, now)).toBeNull();
    }
  });

  it('uses the share role', () => {
    expect(effectiveRole({ ...none, shareRole: 'commenter' }, now)).toBe('commenter');
  });

  it('takes the highest of every combination of sources', () => {
    const shareRoles: Array<ShareRole | null> = [null, 'viewer', 'commenter', 'editor'];
    const accesses: WorkspaceAccess[] = ['none', 'viewer', 'commenter', 'editor'];
    const memberRoles: Array<WorkspaceRole | null> = [null, 'member', 'admin', 'owner'];
    const linkRoles: Array<ShareRole | null> = [null, 'viewer', 'commenter', 'editor'];
    const rank = { viewer: 1, commenter: 2, editor: 3, owner: 4 } as const;
    for (const shareRole of shareRoles)
      for (const workspaceAccess of accesses)
        for (const workspaceRole of memberRoles)
          for (const linkGrant of linkRoles)
            for (const isDocOwner of [false, true]) {
              const candidates: Array<keyof typeof rank> = [];
              if (isDocOwner) candidates.push('owner');
              if (workspaceRole === 'owner' || workspaceRole === 'admin') candidates.push('editor');
              if (shareRole) candidates.push(shareRole);
              if (workspaceRole && workspaceAccess !== 'none') candidates.push(workspaceAccess);
              if (linkGrant) candidates.push(linkGrant);
              const expected = candidates.length
                ? candidates.reduce((a, b) => (rank[a] >= rank[b] ? a : b))
                : null;
              const actual = effectiveRole(
                {
                  authenticated: true,
                  isDocOwner,
                  workspaceRole,
                  shareRole,
                  workspaceAccess,
                  link: linkGrant ? link(linkGrant) : null,
                },
                now,
              );
              expect(actual).toBe(expected);
            }
  });

  it('keeps the higher of a viewer share and an editor link', () => {
    const sources = { ...none, shareRole: 'viewer' as const, link: link('editor') };
    expect(effectiveRole(sources, now)).toBe('editor');
    const revoked = { ...sources, link: link('editor', { revokedAt: now }) };
    expect(effectiveRole(revoked, now)).toBe('viewer');
  });
});

describe('links', () => {
  it('is valid strictly before expiresAt', () => {
    const expiresAt = new Date(now.getTime() + 1);
    expect(linkRole(link('viewer', { expiresAt }), true, now)).toBe('viewer');
    expect(linkRole(link('viewer', { expiresAt: now }), true, now)).toBeNull();
    expect(linkRole(link('viewer', { expiresAt: new Date(now.getTime() - 1) }), true, now)).toBeNull();
  });

  it('never applies once revoked', () => {
    expect(linkRole(link('editor', { revokedAt: new Date(0) }), true, now)).toBeNull();
  });

  it('lets anonymous callers use viewer links only', () => {
    expect(linkRole(link('viewer'), false, now)).toBe('viewer');
    expect(linkRole(link('commenter'), false, now)).toBeNull();
    expect(linkRole(link('editor'), false, now)).toBeNull();
    const anonymous = { ...none, authenticated: false };
    expect(effectiveRole({ ...anonymous, link: link('viewer') }, now)).toBe('viewer');
    expect(effectiveRole({ ...anonymous, link: link('commenter') }, now)).toBeNull();
  });

  it('ignores every non-link source for anonymous callers', () => {
    const anonymous: RoleSources = {
      authenticated: false,
      isDocOwner: false,
      workspaceRole: null,
      shareRole: null,
      workspaceAccess: 'editor',
      link: null,
    };
    expect(effectiveRole(anonymous, now)).toBeNull();
  });
});

describe('derived permissions', () => {
  it('lets owners and workspace admins manage', () => {
    expect(canManageDoc({ isDocOwner: true, workspaceRole: 'member' })).toBe(true);
    expect(canManageDoc({ isDocOwner: false, workspaceRole: 'admin' })).toBe(true);
    expect(canManageDoc({ isDocOwner: false, workspaceRole: 'member' })).toBe(false);
  });

  it('lets commenters resolve only their own threads', () => {
    expect(canResolveThread('commenter', true)).toBe(true);
    expect(canResolveThread('commenter', false)).toBe(false);
    expect(canResolveThread('editor', false)).toBe(true);
    expect(canResolveThread('viewer', true)).toBe(false);
  });
});
