import { beforeEach, describe, expect, it } from 'vitest';
import { call, useTestContext } from './support/context.js';
import { seedTwoOrgs, type Fixture } from './support/fixtures.js';

const ENG1 = '/api/orgs/acme/projects/ENG/issues/1';

describe('schema strictness', () => {
  const ctx = useTestContext();
  let f: Fixture;

  beforeEach(async () => {
    f = await seedTwoOrgs(ctx);
  });

  describe('unknown properties are rejected', () => {
    type Case = { name: string; method: 'POST' | 'PATCH' | 'PUT'; path: string; body: object };
    const cases: Case[] = [
      {
        name: 'issue patch with number',
        method: 'PATCH',
        path: ENG1,
        body: { version: 1, number: 9 },
      },
      {
        name: 'issue patch with reporterId',
        method: 'PATCH',
        path: ENG1,
        body: { version: 1, reporterId: '00000000-0000-0000-0000-000000000000' },
      },
      {
        name: 'issue patch with orgId',
        method: 'PATCH',
        path: ENG1,
        body: { version: 1, orgId: '00000000-0000-0000-0000-000000000000' },
      },
      {
        name: 'label replacement with version bump',
        method: 'PUT',
        path: `${ENG1}/labels`,
        body: { version: 1, labelIds: [], bump: true },
      },
      {
        name: 'comment with author',
        method: 'POST',
        path: `${ENG1}/comments`,
        body: { body: 'x', authorId: '00000000-0000-0000-0000-000000000000' },
      },
      {
        name: 'member with org',
        method: 'POST',
        path: '/api/orgs/acme/members',
        body: { email: 'gus@globex.test', role: 'member', orgId: 'x' },
      },
      {
        name: 'project with counter',
        method: 'POST',
        path: '/api/orgs/acme/projects',
        body: { key: 'NEW', name: 'New', nextIssueNumber: 1 },
      },
      {
        name: 'label with org',
        method: 'POST',
        path: '/api/orgs/acme/labels',
        body: { name: 'New', color: '#000000', orgId: 'x' },
      },
    ];

    for (const c of cases) {
      it(c.name, async () => {
        const res = await call(ctx, c.method, c.path, {
          cookie: f.users.alice.cookie,
          body: c.body,
        });
        expect(res.statusCode).toBe(400);
        expect(res.json().error.code).toBe('validation_failed');
        expect(res.json().error.details.fields[0].path).toMatch(/^body\./);
      });
    }

    it('leaves the issue unchanged', async () => {
      await call(ctx, 'PATCH', ENG1, {
        cookie: f.users.alice.cookie,
        body: { version: 1, title: 'Should not apply', number: 9 },
      });
      const issue = await call(ctx, 'GET', ENG1, { cookie: f.users.alice.cookie });
      expect(issue.json()).toMatchObject({
        title: 'Login button misaligned',
        number: 1,
        version: 1,
      });
    });
  });

  describe('responses contain only declared fields', () => {
    it('issue detail', async () => {
      const res = await call(ctx, 'GET', ENG1, { cookie: f.users.alice.cookie });
      expect(Object.keys(res.json()).sort()).toEqual([
        'assignee',
        'createdAt',
        'description',
        'id',
        'identifier',
        'labels',
        'number',
        'priority',
        'projectKey',
        'reporter',
        'status',
        'title',
        'updatedAt',
        'version',
      ]);
      expect(Object.keys(res.json().reporter).sort()).toEqual(['id', 'name']);
    });

    it('issue list items', async () => {
      const res = await call(ctx, 'GET', '/api/orgs/acme/issues', { cookie: f.users.alice.cookie });
      expect(Object.keys(res.json()).sort()).toEqual(['items', 'nextCursor']);
      const keys = Object.keys(res.json().items[0]);
      expect(keys).not.toContain('description');
      expect(keys).not.toContain('sort_value');
      expect(keys).not.toContain('search');
    });

    it('comments, projects and labels', async () => {
      const comments = await call(ctx, 'GET', `${ENG1}/comments`, { cookie: f.users.alice.cookie });
      expect(Object.keys(comments.json().items[0]).sort()).toEqual([
        'author',
        'body',
        'createdAt',
        'editedAt',
        'id',
      ]);
      const projects = await call(ctx, 'GET', '/api/orgs/acme/projects', {
        cookie: f.users.alice.cookie,
      });
      expect(Object.keys(projects.json().items[0]).sort()).toEqual([
        'archivedAt',
        'createdAt',
        'id',
        'key',
        'name',
      ]);
      const labels = await call(ctx, 'GET', '/api/orgs/acme/labels', {
        cookie: f.users.alice.cookie,
      });
      expect(Object.keys(labels.json().items[0]).sort()).toEqual(['color', 'id', 'name']);
    });
  });
});
