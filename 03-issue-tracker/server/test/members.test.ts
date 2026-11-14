import { beforeEach, describe, expect, it } from 'vitest';
import { call, createUser, errorCode, useTestContext } from './support/context.js';
import { seedTwoOrgs, type Fixture } from './support/fixtures.js';

describe('memberships', () => {
  const ctx = useTestContext();
  let f: Fixture;

  beforeEach(async () => {
    f = await seedTwoOrgs(ctx);
  });

  async function roleOf(orgId: string, userId: string) {
    const row = await ctx.db
      .selectFrom('memberships')
      .select('role')
      .where('org_id', '=', orgId)
      .where('user_id', '=', userId)
      .executeTakeFirst();
    return row?.role;
  }

  describe('listing', () => {
    it('pages through members in join order', async () => {
      const first = await call(ctx, 'GET', '/api/orgs/acme/members?limit=4', {
        cookie: f.users.vic.cookie,
      });
      expect(first.statusCode).toBe(200);
      const page1 = first.json();
      expect(page1.items.map((m: { name: string }) => m.name)).toEqual([
        'Alice Owner',
        'Adam Admin',
        'Mia Member',
        'Vic Viewer',
      ]);
      expect(page1.nextCursor).toEqual(expect.any(String));

      const second = await call(
        ctx,
        'GET',
        `/api/orgs/acme/members?limit=4&cursor=${page1.nextCursor}`,
        { cookie: f.users.vic.cookie },
      );
      const page2 = second.json();
      expect(page2.items.map((m: { name: string }) => m.name)).toEqual([
        'Tom Member',
        'Dana Dual',
      ]);
      expect(page2.nextCursor).toBeNull();
    });

    it('returns only declared member fields', async () => {
      const res = await call(ctx, 'GET', '/api/orgs/acme/members', { cookie: f.users.mia.cookie });
      expect(Object.keys(res.json().items[0]).sort()).toEqual([
        'email',
        'joinedAt',
        'name',
        'role',
        'userId',
      ]);
    });

    it('rejects a cursor from another list', async () => {
      const issueCursor = Buffer.from(
        JSON.stringify({ s: 'created', v: '2026-03-02T09:00:00.000000Z', id: f.users.mia.id }),
      ).toString('base64url');
      const res = await call(ctx, 'GET', `/api/orgs/acme/members?cursor=${issueCursor}`, {
        cookie: f.users.mia.cookie,
      });
      expect(res.statusCode).toBe(400);
      expect(errorCode(res)).toBe('invalid_cursor');
    });
  });

  describe('adding', () => {
    it('adds an existing user by email', async () => {
      const newcomer = await createUser(ctx, 'newcomer@example.com', 'Newcomer');
      const res = await call(ctx, 'POST', '/api/orgs/acme/members', {
        cookie: f.users.adam.cookie,
        body: { email: 'NEWCOMER@example.com', role: 'member' },
      });
      expect(res.statusCode).toBe(201);
      expect(res.json()).toMatchObject({ userId: newcomer.id, role: 'member' });
    });

    it('reports unknown emails and existing members', async () => {
      const unknown = await call(ctx, 'POST', '/api/orgs/acme/members', {
        cookie: f.users.adam.cookie,
        body: { email: 'ghost@example.com', role: 'member' },
      });
      expect(unknown.statusCode).toBe(422);
      expect(errorCode(unknown)).toBe('user_not_found');

      const existing = await call(ctx, 'POST', '/api/orgs/acme/members', {
        cookie: f.users.adam.cookie,
        body: { email: 'mia@acme.test', role: 'viewer' },
      });
      expect(existing.statusCode).toBe(409);
      expect(errorCode(existing)).toBe('already_member');
    });

    it('lets only owners add someone as owner', async () => {
      const byAdmin = await call(ctx, 'POST', '/api/orgs/acme/members', {
        cookie: f.users.adam.cookie,
        body: { email: 'gus@globex.test', role: 'owner' },
      });
      expect(byAdmin.statusCode).toBe(403);

      const byOwner = await call(ctx, 'POST', '/api/orgs/acme/members', {
        cookie: f.users.alice.cookie,
        body: { email: 'gus@globex.test', role: 'owner' },
      });
      expect(byOwner.statusCode).toBe(201);
    });
  });

  describe('changing roles', () => {
    it('lets an admin change a member role', async () => {
      const res = await call(ctx, 'PATCH', `/api/orgs/acme/members/${f.users.tom.id}`, {
        cookie: f.users.adam.cookie,
        body: { role: 'admin' },
      });
      expect(res.statusCode).toBe(200);
      expect(await roleOf(f.acme.id, f.users.tom.id)).toBe('admin');
    });

    it('stops an admin from demoting or removing an owner', async () => {
      const demote = await call(ctx, 'PATCH', `/api/orgs/acme/members/${f.users.alice.id}`, {
        cookie: f.users.adam.cookie,
        body: { role: 'member' },
      });
      expect(demote.statusCode).toBe(403);

      const remove = await call(ctx, 'DELETE', `/api/orgs/acme/members/${f.users.alice.id}`, {
        cookie: f.users.adam.cookie,
      });
      expect(remove.statusCode).toBe(403);
      expect(await roleOf(f.acme.id, f.users.alice.id)).toBe('owner');
    });

    it('stops an admin from granting ownership', async () => {
      const res = await call(ctx, 'PATCH', `/api/orgs/acme/members/${f.users.tom.id}`, {
        cookie: f.users.adam.cookie,
        body: { role: 'owner' },
      });
      expect(res.statusCode).toBe(403);
    });

    it('refuses to demote the last owner', async () => {
      const res = await call(ctx, 'PATCH', '/api/orgs/acme/members/me', {
        cookie: f.users.alice.cookie,
        body: { role: 'admin' },
      });
      expect(res.statusCode).toBe(422);
      expect(errorCode(res)).toBe('last_owner');
    });

    it('allows an owner to step down once another owner exists', async () => {
      await call(ctx, 'PATCH', `/api/orgs/acme/members/${f.users.adam.id}`, {
        cookie: f.users.alice.cookie,
        body: { role: 'owner' },
      });
      const res = await call(ctx, 'PATCH', '/api/orgs/acme/members/me', {
        cookie: f.users.alice.cookie,
        body: { role: 'admin' },
      });
      expect(res.statusCode).toBe(200);
      expect(await roleOf(f.acme.id, f.users.adam.id)).toBe('owner');
    });

    it('unassigns issues when a member is made a viewer', async () => {
      const res = await call(ctx, 'PATCH', `/api/orgs/acme/members/${f.users.mia.id}`, {
        cookie: f.users.adam.cookie,
        body: { role: 'viewer' },
      });
      expect(res.statusCode).toBe(200);
      const issue = await ctx.db
        .selectFrom('issues')
        .select(['assignee_id', 'version'])
        .where('id', '=', f.acme.issues['ENG-1'])
        .executeTakeFirstOrThrow();
      expect(issue).toEqual({ assignee_id: null, version: 2 });
    });

    it('returns 404 for users who are not members of this org', async () => {
      const res = await call(ctx, 'PATCH', `/api/orgs/acme/members/${f.users.gina.id}`, {
        cookie: f.users.alice.cookie,
        body: { role: 'member' },
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe('removing', () => {
    it('unassigns the removed member and keeps their comments', async () => {
      const res = await call(ctx, 'DELETE', `/api/orgs/acme/members/${f.users.mia.id}`, {
        cookie: f.users.adam.cookie,
      });
      expect(res.statusCode).toBe(204);
      expect(await roleOf(f.acme.id, f.users.mia.id)).toBeUndefined();

      const issue = await ctx.db
        .selectFrom('issues')
        .select(['assignee_id', 'version', 'updated_at'])
        .where('id', '=', f.acme.issues['ENG-1'])
        .executeTakeFirstOrThrow();
      expect(issue.assignee_id).toBeNull();
      expect(issue.version).toBe(2);

      const comments = await ctx.db
        .selectFrom('comments')
        .select('author_id')
        .where('issue_id', '=', f.acme.issues['ENG-1'])
        .execute();
      expect(comments).toEqual([{ author_id: f.users.mia.id }]);

      const globexIssue = await ctx.db
        .selectFrom('issues')
        .select('assignee_id')
        .where('id', '=', f.globex.issues['ENG-1'])
        .executeTakeFirstOrThrow();
      expect(globexIssue.assignee_id).toBe(f.users.gus.id);
    });

    it('lets any member leave', async () => {
      const res = await call(ctx, 'DELETE', '/api/orgs/acme/members/me', {
        cookie: f.users.vic.cookie,
      });
      expect(res.statusCode).toBe(204);
      expect(await roleOf(f.acme.id, f.users.vic.id)).toBeUndefined();
    });

    it('does not let the last owner leave', async () => {
      const res = await call(ctx, 'DELETE', '/api/orgs/acme/members/me', {
        cookie: f.users.alice.cookie,
      });
      expect(res.statusCode).toBe(422);
      expect(errorCode(res)).toBe('last_owner');
    });

    it('does not let members remove other members', async () => {
      const res = await call(ctx, 'DELETE', `/api/orgs/acme/members/${f.users.tom.id}`, {
        cookie: f.users.mia.cookie,
      });
      expect(res.statusCode).toBe(403);
    });
  });
});
