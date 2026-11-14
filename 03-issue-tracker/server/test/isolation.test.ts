import { beforeEach, describe, expect, it } from 'vitest';
import { call, errorCode, useTestContext } from './support/context.js';
import { seedTwoOrgs, type Fixture } from './support/fixtures.js';

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

interface RouteCase {
  name: string;
  method: Method;
  /** Path below /api/orgs/:slug. */
  path: (f: Fixture) => string;
  body?: (f: Fixture) => unknown;
}

const ENG1 = '/projects/ENG/issues/1';

/** Every tenant route, addressed at acme's own resources. */
const TENANT_ROUTES: RouteCase[] = [
  { name: 'get org', method: 'GET', path: () => '' },
  { name: 'rename org', method: 'PATCH', path: () => '', body: () => ({ name: 'Taken' }) },
  { name: 'delete org', method: 'DELETE', path: () => '' },
  { name: 'list members', method: 'GET', path: () => '/members' },
  {
    name: 'add member',
    method: 'POST',
    path: () => '/members',
    body: () => ({ email: 'gina@globex.test', role: 'admin' }),
  },
  {
    name: 'change member role',
    method: 'PATCH',
    path: (f) => `/members/${f.users.mia.id}`,
    body: () => ({ role: 'admin' }),
  },
  { name: 'remove member', method: 'DELETE', path: (f) => `/members/${f.users.mia.id}` },
  { name: 'list projects', method: 'GET', path: () => '/projects' },
  {
    name: 'create project',
    method: 'POST',
    path: () => '/projects',
    body: () => ({ key: 'NEW', name: 'New' }),
  },
  {
    name: 'rename project',
    method: 'PATCH',
    path: () => '/projects/ENG',
    body: () => ({ name: 'Renamed' }),
  },
  { name: 'archive project', method: 'POST', path: () => '/projects/ENG/archive' },
  { name: 'list labels', method: 'GET', path: () => '/labels' },
  {
    name: 'create label',
    method: 'POST',
    path: () => '/labels',
    body: () => ({ name: 'New', color: '#000000' }),
  },
  {
    name: 'edit label',
    method: 'PATCH',
    path: (f) => `/labels/${f.acme.labels.Bug}`,
    body: () => ({ color: '#000000' }),
  },
  { name: 'delete label', method: 'DELETE', path: (f) => `/labels/${f.acme.labels.Bug}` },
  { name: 'list issues', method: 'GET', path: () => '/issues' },
  { name: 'search issues', method: 'GET', path: () => '/issues?q=ENG-1' },
  {
    name: 'create issue',
    method: 'POST',
    path: () => '/projects/ENG/issues',
    body: () => ({ title: 'Intruder' }),
  },
  { name: 'get issue', method: 'GET', path: () => ENG1 },
  {
    name: 'patch issue',
    method: 'PATCH',
    path: () => ENG1,
    body: () => ({ version: 1, title: 'Intruder' }),
  },
  {
    name: 'replace labels',
    method: 'PUT',
    path: () => `${ENG1}/labels`,
    body: () => ({ version: 1, labelIds: [] }),
  },
  { name: 'delete issue', method: 'DELETE', path: () => ENG1 },
  { name: 'list comments', method: 'GET', path: () => `${ENG1}/comments` },
  {
    name: 'add comment',
    method: 'POST',
    path: () => `${ENG1}/comments`,
    body: () => ({ body: 'Intruder' }),
  },
  {
    name: 'edit comment',
    method: 'PATCH',
    path: (f) => `${ENG1}/comments/${f.acme.comments['ENG-1:I can reproduce this.']}`,
    body: () => ({ body: 'Intruder' }),
  },
  {
    name: 'delete comment',
    method: 'DELETE',
    path: (f) => `${ENG1}/comments/${f.acme.comments['ENG-1:I can reproduce this.']}`,
  },
];

function withoutRequestId(body: { error: Record<string, unknown> }) {
  const { requestId: _requestId, ...rest } = body.error;
  return rest;
}

describe('tenant isolation', () => {
  const ctx = useTestContext();
  let f: Fixture;

  beforeEach(async () => {
    f = await seedTwoOrgs(ctx);
  });

  async function acmeSnapshot() {
    const [issues, comments, labels, members, projects, org] = await Promise.all([
      ctx.db.selectFrom('issues').selectAll().where('org_id', '=', f.acme.id).execute(),
      ctx.db.selectFrom('comments').selectAll().where('org_id', '=', f.acme.id).execute(),
      ctx.db.selectFrom('labels').selectAll().where('org_id', '=', f.acme.id).execute(),
      ctx.db.selectFrom('memberships').selectAll().where('org_id', '=', f.acme.id).execute(),
      ctx.db.selectFrom('projects').selectAll().where('org_id', '=', f.acme.id).execute(),
      ctx.db.selectFrom('orgs').selectAll().where('id', '=', f.acme.id).execute(),
    ]);
    return { issues, comments, labels, members, projects, org };
  }

  describe('a member of another org', () => {
    for (const route of TENANT_ROUTES) {
      it(`gets the not-found response for: ${route.name}`, async () => {
        const before = await acmeSnapshot();
        const options = { cookie: f.users.gina.cookie, body: route.body?.(f) };
        const foreign = await call(ctx, route.method, `/api/orgs/acme${route.path(f)}`, options);
        const missing = await call(ctx, route.method, `/api/orgs/nowhere${route.path(f)}`, options);
        expect(foreign.statusCode).toBe(404);
        expect(missing.statusCode).toBe(404);
        expect(withoutRequestId(foreign.json())).toEqual(withoutRequestId(missing.json()));
        expect(await acmeSnapshot()).toEqual(before);
      });
    }
  });

  describe('a member using their own org slug with foreign ids', () => {
    const notFoundCases: RouteCase[] = [
      {
        name: 'issue number only in the other org',
        method: 'GET',
        path: () => '/projects/ENG/issues/3',
      },
      {
        name: 'project key only in the other org',
        method: 'GET',
        path: () => '/projects/MKT/issues/1',
      },
      {
        name: 'patch of a foreign issue number',
        method: 'PATCH',
        path: () => '/projects/ENG/issues/3',
        body: () => ({ version: 1, title: 'x' }),
      },
      {
        name: 'label replacement on a foreign issue number',
        method: 'PUT',
        path: () => '/projects/ENG/issues/3/labels',
        body: () => ({ version: 1, labelIds: [] }),
      },
      {
        name: 'delete of a foreign issue number',
        method: 'DELETE',
        path: () => '/projects/ENG/issues/3',
      },
      {
        name: 'comments of a foreign issue',
        method: 'GET',
        path: () => '/projects/ENG/issues/3/comments',
      },
      {
        name: 'new issue in a foreign project',
        method: 'POST',
        path: () => '/projects/MKT/issues',
        body: () => ({ title: 'x' }),
      },
      {
        name: 'foreign comment under an own issue',
        method: 'PATCH',
        path: (f) => `${ENG1}/comments/${f.globex.comments['ENG-1:Globex comment']}`,
        body: () => ({ body: 'x' }),
      },
      {
        name: 'delete of a foreign comment',
        method: 'DELETE',
        path: (f) => `${ENG1}/comments/${f.globex.comments['ENG-1:Globex comment']}`,
      },
      {
        name: 'edit of a foreign label',
        method: 'PATCH',
        path: (f) => `/labels/${f.globex.labels.Bug}`,
        body: () => ({ name: 'x' }),
      },
      {
        name: 'delete of a foreign label',
        method: 'DELETE',
        path: (f) => `/labels/${f.globex.labels.Bug}`,
      },
      {
        name: 'role change for a foreign user',
        method: 'PATCH',
        path: (f) => `/members/${f.users.gina.id}`,
        body: () => ({ role: 'member' }),
      },
      {
        name: 'removal of a foreign user',
        method: 'DELETE',
        path: (f) => `/members/${f.users.gus.id}`,
      },
      {
        name: 'rename of a foreign project',
        method: 'PATCH',
        path: () => '/projects/MKT',
        body: () => ({ name: 'x' }),
      },
      { name: 'archive of a foreign project', method: 'POST', path: () => '/projects/MKT/archive' },
    ];

    for (const route of notFoundCases) {
      it(`gets 404 for the ${route.name}`, async () => {
        const res = await call(ctx, route.method, `/api/orgs/acme${route.path(f)}`, {
          cookie: f.users.alice.cookie,
          body: route.body?.(f),
        });
        expect(res.statusCode).toBe(404);
        expect(errorCode(res)).toBe('not_found');
      });
    }

    const referenceCases: (RouteCase & { field: string })[] = [
      {
        name: 'assignee from the other org',
        method: 'PATCH',
        path: () => ENG1,
        body: (f) => ({ version: 1, assigneeId: f.users.gus.id }),
        field: 'assigneeId',
      },
      {
        name: 'label from the other org on replace',
        method: 'PUT',
        path: () => `${ENG1}/labels`,
        body: (f) => ({ version: 1, labelIds: [f.globex.labels.Bug] }),
        field: 'labelIds',
      },
      {
        name: 'label from the other org on create',
        method: 'POST',
        path: () => '/projects/ENG/issues',
        body: (f) => ({ title: 'x', labelIds: [f.globex.labels.Bug] }),
        field: 'labelIds',
      },
      {
        name: 'assignee from the other org on create',
        method: 'POST',
        path: () => '/projects/ENG/issues',
        body: (f) => ({ title: 'x', assigneeId: f.users.gina.id }),
        field: 'assigneeId',
      },
      {
        name: 'move target only in the other org',
        method: 'PATCH',
        path: () => ENG1,
        body: () => ({ version: 1, projectKey: 'MKT' }),
        field: 'projectKey',
      },
    ];

    for (const route of referenceCases) {
      it(`gets 422 invalid_reference for an ${route.name}`, async () => {
        const res = await call(ctx, route.method, `/api/orgs/acme${route.path(f)}`, {
          cookie: f.users.alice.cookie,
          body: route.body?.(f),
        });
        expect(res.statusCode).toBe(422);
        expect(res.json().error).toMatchObject({
          code: 'invalid_reference',
          details: { field: route.field },
        });
      });
    }
  });

  it('does not reveal other orgs in responses', async () => {
    const members = await call(ctx, 'GET', '/api/orgs/acme/members?limit=100', {
      cookie: f.users.dana.cookie,
    });
    const emails = members.json().items.map((m: { email: string }) => m.email);
    expect(emails).not.toContain('gina@globex.test');
    expect(emails).not.toContain('gus@globex.test');

    const issue = await call(ctx, 'GET', `/api/orgs/acme${ENG1}`, { cookie: f.users.dana.cookie });
    const text = issue.body;
    expect(text).not.toContain(f.globex.id);
    expect(text).not.toContain(f.acme.id);

    const me = await call(ctx, 'GET', '/api/auth/me', { cookie: f.users.mia.cookie });
    expect(me.json().memberships).toEqual([{ orgSlug: 'acme', orgName: 'ACME', role: 'member' }]);
  });
});
