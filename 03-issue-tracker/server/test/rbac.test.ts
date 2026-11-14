import { beforeEach, describe, expect, it } from 'vitest';
import type { Role } from '../src/lib/permissions.js';
import { call, useTestContext } from './support/context.js';
import { insertComment, seedTwoOrgs, type Fixture } from './support/fixtures.js';

type Method = 'POST' | 'PATCH' | 'PUT' | 'DELETE';

interface Scenario {
  f: Fixture;
  actorId: string;
  ownCommentId: string;
  otherCommentId: string;
}

interface WriteRoute {
  name: string;
  method: Method;
  path: (s: Scenario) => string;
  body?: (s: Scenario) => unknown;
  allowed: Role[];
}

const ENG1 = '/api/orgs/acme/projects/ENG/issues/1';
const MEMBER_AND_UP: Role[] = ['member', 'admin', 'owner'];
const ADMIN_AND_UP: Role[] = ['admin', 'owner'];
const OWNER_ONLY: Role[] = ['owner'];

const WRITE_ROUTES: WriteRoute[] = [
  {
    name: 'create issue',
    method: 'POST',
    path: () => '/api/orgs/acme/projects/ENG/issues',
    body: () => ({ title: 'New issue' }),
    allowed: MEMBER_AND_UP,
  },
  {
    name: 'edit issue fields',
    method: 'PATCH',
    path: () => ENG1,
    body: () => ({ version: 1, title: 'Edited', priority: 3 }),
    allowed: MEMBER_AND_UP,
  },
  {
    name: 'replace issue labels',
    method: 'PUT',
    path: () => `${ENG1}/labels`,
    body: (s) => ({ version: 1, labelIds: [s.f.acme.labels.Bug] }),
    allowed: MEMBER_AND_UP,
  },
  { name: 'delete issue', method: 'DELETE', path: () => ENG1, allowed: ADMIN_AND_UP },
  {
    name: 'add comment',
    method: 'POST',
    path: () => `${ENG1}/comments`,
    body: () => ({ body: 'A comment' }),
    allowed: MEMBER_AND_UP,
  },
  {
    name: 'edit own comment',
    method: 'PATCH',
    path: (s) => `${ENG1}/comments/${s.ownCommentId}`,
    body: () => ({ body: 'Edited comment' }),
    allowed: MEMBER_AND_UP,
  },
  {
    name: 'delete own comment',
    method: 'DELETE',
    path: (s) => `${ENG1}/comments/${s.ownCommentId}`,
    allowed: MEMBER_AND_UP,
  },
  {
    name: "delete someone else's comment",
    method: 'DELETE',
    path: (s) => `${ENG1}/comments/${s.otherCommentId}`,
    allowed: ADMIN_AND_UP,
  },
  {
    name: 'create project',
    method: 'POST',
    path: () => '/api/orgs/acme/projects',
    body: () => ({ key: 'NEW', name: 'New' }),
    allowed: ADMIN_AND_UP,
  },
  {
    name: 'rename project',
    method: 'PATCH',
    path: () => '/api/orgs/acme/projects/ENG',
    body: () => ({ name: 'Engineering' }),
    allowed: ADMIN_AND_UP,
  },
  {
    name: 'archive project',
    method: 'POST',
    path: () => '/api/orgs/acme/projects/ENG/archive',
    allowed: ADMIN_AND_UP,
  },
  {
    name: 'create label',
    method: 'POST',
    path: () => '/api/orgs/acme/labels',
    body: () => ({ name: 'Docs', color: '#00aa00' }),
    allowed: ADMIN_AND_UP,
  },
  {
    name: 'edit label',
    method: 'PATCH',
    path: (s) => `/api/orgs/acme/labels/${s.f.acme.labels.Bug}`,
    body: () => ({ name: 'Defect' }),
    allowed: ADMIN_AND_UP,
  },
  {
    name: 'delete label',
    method: 'DELETE',
    path: (s) => `/api/orgs/acme/labels/${s.f.acme.labels.Bug}`,
    allowed: ADMIN_AND_UP,
  },
  {
    name: 'add member',
    method: 'POST',
    path: () => '/api/orgs/acme/members',
    body: () => ({ email: 'gus@globex.test', role: 'member' }),
    allowed: ADMIN_AND_UP,
  },
  {
    name: 'change member role',
    method: 'PATCH',
    path: (s) => `/api/orgs/acme/members/${s.f.users.tom.id}`,
    body: () => ({ role: 'viewer' }),
    allowed: ADMIN_AND_UP,
  },
  {
    name: 'remove member',
    method: 'DELETE',
    path: (s) => `/api/orgs/acme/members/${s.f.users.tom.id}`,
    allowed: ADMIN_AND_UP,
  },
  {
    name: 'grant owner',
    method: 'PATCH',
    path: (s) => `/api/orgs/acme/members/${s.f.users.tom.id}`,
    body: () => ({ role: 'owner' }),
    allowed: OWNER_ONLY,
  },
  {
    name: 'add member as owner',
    method: 'POST',
    path: () => '/api/orgs/acme/members',
    body: () => ({ email: 'gus@globex.test', role: 'owner' }),
    allowed: OWNER_ONLY,
  },
  {
    name: 'rename org',
    method: 'PATCH',
    path: () => '/api/orgs/acme',
    body: () => ({ name: 'Acme Corp' }),
    allowed: OWNER_ONLY,
  },
  { name: 'delete org', method: 'DELETE', path: () => '/api/orgs/acme', allowed: OWNER_ONLY },
];

const ACTORS: Record<Role, 'vic' | 'mia' | 'adam' | 'alice'> = {
  viewer: 'vic',
  member: 'mia',
  admin: 'adam',
  owner: 'alice',
};

describe('role-based access to write routes', () => {
  const ctx = useTestContext();
  let scenario: Scenario;
  let f: Fixture;

  beforeEach(async () => {
    f = await seedTwoOrgs(ctx);
    scenario = { f, actorId: '', ownCommentId: '', otherCommentId: '' };
    scenario.otherCommentId = await insertComment(ctx, f.acme, 'ENG-1', f.users.tom.id, 'by tom');
  });

  for (const route of WRITE_ROUTES) {
    for (const role of Object.keys(ACTORS) as Role[]) {
      const allowed = route.allowed.includes(role);
      it(`${route.name} as ${role} is ${allowed ? 'allowed' : 'forbidden'}`, async () => {
        const actor = f.users[ACTORS[role]];
        scenario.actorId = actor.id;
        scenario.ownCommentId = await insertComment(ctx, f.acme, 'ENG-1', actor.id, 'mine');
        const res = await call(ctx, route.method, route.path(scenario), {
          cookie: actor.cookie,
          body: route.body?.(scenario),
        });
        if (allowed) {
          expect(res.statusCode, res.body).toBeLessThan(300);
        } else {
          expect(res.statusCode, res.body).toBe(403);
          expect(res.json().error.code).toBe('forbidden');
        }
      });
    }
  }

  it('reports 404 rather than 403 when the target does not exist', async () => {
    const res = await call(ctx, 'PATCH', '/api/orgs/acme/projects/ENG/issues/999', {
      cookie: f.users.vic.cookie,
      body: { version: 1, title: 'x' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('never accepts a viewer as assignee', async () => {
    const res = await call(ctx, 'PATCH', ENG1, {
      cookie: f.users.alice.cookie,
      body: { version: 1, assigneeId: f.users.vic.id },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('invalid_reference');
  });
});
