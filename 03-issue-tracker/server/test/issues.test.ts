import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { call, errorCode, useTestContext } from './support/context.js';
import { seedTwoOrgs, type Fixture } from './support/fixtures.js';

const ENG1 = '/api/orgs/acme/projects/ENG/issues/1';

describe('issues', () => {
  const ctx = useTestContext();
  let f: Fixture;

  beforeEach(async () => {
    f = await seedTwoOrgs(ctx);
  });

  async function issueRow(id: string) {
    return ctx.db
      .selectFrom('issues')
      .select(['title', 'status', 'version', 'assignee_id', 'updated_at', 'number'])
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
  }

  describe('creating', () => {
    it('allocates the next number and records the reporter', async () => {
      const res = await call(ctx, 'POST', '/api/orgs/acme/projects/ENG/issues', {
        cookie: f.users.mia.cookie,
        body: {
          title: '  Add dark mode  ',
          priority: 1,
          assigneeId: f.users.tom.id,
          labelIds: [f.acme.labels.Feature],
        },
      });
      expect(res.statusCode).toBe(201);
      expect(res.json()).toEqual({
        id: expect.any(String),
        identifier: 'ENG-3',
        projectKey: 'ENG',
        number: 3,
        title: 'Add dark mode',
        description: '',
        status: 'backlog',
        priority: 1,
        assignee: { id: f.users.tom.id, name: 'Tom Member' },
        reporter: { id: f.users.mia.id, name: 'Mia Member' },
        labels: [{ id: f.acme.labels.Feature, name: 'Feature', color: '#3366cc' }],
        version: 1,
        createdAt: ctx.clock.now().toISOString(),
        updatedAt: ctx.clock.now().toISOString(),
      });
    });

    it('never reuses a number after a delete', async () => {
      await call(ctx, 'DELETE', '/api/orgs/acme/projects/ENG/issues/2', {
        cookie: f.users.adam.cookie,
      });
      const res = await call(ctx, 'POST', '/api/orgs/acme/projects/ENG/issues', {
        cookie: f.users.mia.cookie,
        body: { title: 'After delete' },
      });
      expect(res.json().identifier).toBe('ENG-3');
    });

    it('refuses new issues in an archived project', async () => {
      const res = await call(ctx, 'POST', '/api/orgs/acme/projects/OPS/issues', {
        cookie: f.users.mia.cookie,
        body: { title: 'Nope' },
      });
      expect(res.statusCode).toBe(422);
      expect(errorCode(res)).toBe('project_archived');
    });

    it('rejects viewers and outsiders as assignees with one indistinguishable error', async () => {
      const bodies = [f.users.vic.id, f.users.gus.id, randomUUID()].map(async (assigneeId) => {
        const res = await call(ctx, 'POST', '/api/orgs/acme/projects/ENG/issues', {
          cookie: f.users.mia.cookie,
          body: { title: 'Assigned', assigneeId },
        });
        expect(res.statusCode).toBe(422);
        const { requestId: _requestId, ...error } = res.json().error;
        return error;
      });
      const [viewer, foreign, random] = await Promise.all(bodies);
      expect(viewer).toEqual({
        code: 'invalid_reference',
        message: expect.any(String),
        details: { field: 'assigneeId' },
      });
      expect(foreign).toEqual(viewer);
      expect(random).toEqual(viewer);
    });

    it('rejects labels from another org', async () => {
      const res = await call(ctx, 'POST', '/api/orgs/acme/projects/ENG/issues', {
        cookie: f.users.mia.cookie,
        body: { title: 'Labelled', labelIds: [f.acme.labels.Bug, f.globex.labels.Bug] },
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().error.details).toEqual({ field: 'labelIds' });
      const project = await ctx.db
        .selectFrom('projects')
        .select('next_issue_number')
        .where('id', '=', f.acme.projects.ENG)
        .executeTakeFirstOrThrow();
      expect(project.next_issue_number).toBe(3);
    });

    it('rejects client-controlled fields', async () => {
      const extras = [{ orgId: f.globex.id }, { reporterId: f.users.vic.id }, { number: 99 }];
      for (const extra of extras) {
        const res = await call(ctx, 'POST', '/api/orgs/acme/projects/ENG/issues', {
          cookie: f.users.mia.cookie,
          body: { title: 'Sneaky', ...extra },
        });
        expect(res.statusCode).toBe(400);
        expect(errorCode(res)).toBe('validation_failed');
      }
    });
  });

  describe('reading', () => {
    it('returns the issue with labels, assignee summary and version', async () => {
      const res = await call(ctx, 'GET', ENG1, { cookie: f.users.vic.cookie });
      expect(res.statusCode).toBe(200);
      const issue = res.json();
      expect(issue).toMatchObject({
        identifier: 'ENG-1',
        assignee: { id: f.users.mia.id, name: 'Mia Member' },
        version: 1,
      });
      expect(Object.keys(issue.assignee)).toEqual(['id', 'name']);
    });

    it('keeps archived issues readable', async () => {
      const res = await call(ctx, 'GET', '/api/orgs/acme/projects/OPS/issues/1', {
        cookie: f.users.vic.cookie,
      });
      expect(res.statusCode).toBe(200);
    });

    it('does not resolve numbers or keys that only exist in another org', async () => {
      const missingNumber = await call(ctx, 'GET', '/api/orgs/acme/projects/ENG/issues/3', {
        cookie: f.users.dana.cookie,
      });
      const missingProject = await call(ctx, 'GET', '/api/orgs/acme/projects/MKT/issues/1', {
        cookie: f.users.dana.cookie,
      });
      expect(missingNumber.statusCode).toBe(404);
      expect(missingProject.statusCode).toBe(404);
    });
  });

  describe('patching', () => {
    it('applies a partial update and bumps the version', async () => {
      ctx.clock.advance(60_000);
      const res = await call(ctx, 'PATCH', ENG1, {
        cookie: f.users.mia.cookie,
        body: { version: 1, status: 'in_progress', assigneeId: null },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        status: 'in_progress',
        assignee: null,
        title: 'Login button misaligned',
        version: 2,
        updatedAt: ctx.clock.now().toISOString(),
      });
    });

    it('answers a stale version with 409 and the current issue, changing nothing', async () => {
      await call(ctx, 'PATCH', ENG1, {
        cookie: f.users.mia.cookie,
        body: { version: 1, title: 'First edit' },
      });
      const stale = await call(ctx, 'PATCH', ENG1, {
        cookie: f.users.tom.cookie,
        body: { version: 1, status: 'done' },
      });
      expect(stale.statusCode).toBe(409);
      expect(errorCode(stale)).toBe('version_conflict');
      expect(stale.json().error.details.current).toMatchObject({
        title: 'First edit',
        status: 'backlog',
        version: 2,
      });
      expect(await issueRow(f.acme.issues['ENG-1'])).toMatchObject({
        status: 'backlog',
        version: 2,
      });
    });

    it('treats a no-op patch as success without bumping the version', async () => {
      const before = await issueRow(f.acme.issues['ENG-1']);
      ctx.clock.advance(60_000);
      const res = await call(ctx, 'PATCH', ENG1, {
        cookie: f.users.mia.cookie,
        body: { version: 1, title: 'Login button misaligned', status: 'backlog' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().version).toBe(1);
      expect(await issueRow(f.acme.issues['ENG-1'])).toEqual(before);
    });

    it('still requires a matching version for a no-op patch', async () => {
      const res = await call(ctx, 'PATCH', ENG1, {
        cookie: f.users.mia.cookie,
        body: { version: 7 },
      });
      expect(res.statusCode).toBe(409);
    });

    it('rejects assignees from another org', async () => {
      const res = await call(ctx, 'PATCH', ENG1, {
        cookie: f.users.mia.cookie,
        body: { version: 1, assigneeId: f.users.gus.id },
      });
      expect(res.statusCode).toBe(422);
      expect(errorCode(res)).toBe('invalid_reference');
    });

    it('treats issues in archived projects as read-only', async () => {
      const res = await call(ctx, 'PATCH', '/api/orgs/acme/projects/OPS/issues/1', {
        cookie: f.users.mia.cookie,
        body: { version: 1, title: 'Edited' },
      });
      expect(res.statusCode).toBe(422);
      expect(errorCode(res)).toBe('project_archived');
    });
  });

  describe('moving', () => {
    it('gives the issue a new identifier in the target project', async () => {
      await insertProjectViaApi('WEB');
      await call(ctx, 'PUT', `${ENG1}/labels`, {
        cookie: f.users.mia.cookie,
        body: { version: 1, labelIds: [f.acme.labels.Bug] },
      });

      const res = await call(ctx, 'PATCH', ENG1, {
        cookie: f.users.mia.cookie,
        body: { version: 2, projectKey: 'WEB' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ identifier: 'WEB-1', version: 3 });

      const old = await call(ctx, 'GET', ENG1, { cookie: f.users.mia.cookie });
      expect(old.statusCode).toBe(404);
      const moved = await call(ctx, 'GET', '/api/orgs/acme/projects/WEB/issues/1', {
        cookie: f.users.mia.cookie,
      });
      expect(moved.json().labels.map((l: { name: string }) => l.name)).toEqual(['Bug']);
      const comments = await ctx.db
        .selectFrom('comments')
        .select('id')
        .where('issue_id', '=', f.acme.issues['ENG-1'])
        .execute();
      expect(comments).toHaveLength(1);
    });

    it('rejects unknown, foreign and archived targets', async () => {
      const foreign = await call(ctx, 'PATCH', ENG1, {
        cookie: f.users.mia.cookie,
        body: { version: 1, projectKey: 'MKT' },
      });
      expect(foreign.statusCode).toBe(422);
      expect(foreign.json().error.details).toEqual({ field: 'projectKey' });

      const archived = await call(ctx, 'PATCH', ENG1, {
        cookie: f.users.mia.cookie,
        body: { version: 1, projectKey: 'OPS' },
      });
      expect(archived.statusCode).toBe(422);
      expect(errorCode(archived)).toBe('project_archived');
    });

    async function insertProjectViaApi(key: string) {
      const res = await call(ctx, 'POST', '/api/orgs/acme/projects', {
        cookie: f.users.adam.cookie,
        body: { key, name: key },
      });
      expect(res.statusCode).toBe(201);
    }
  });

  describe('labels', () => {
    it('replaces the full label set and bumps the version', async () => {
      const res = await call(ctx, 'PUT', `${ENG1}/labels`, {
        cookie: f.users.mia.cookie,
        body: { version: 1, labelIds: [f.acme.labels.Feature, f.acme.labels.Bug] },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().labels.map((l: { name: string }) => l.name)).toEqual(['Bug', 'Feature']);
      expect(res.json().version).toBe(2);

      const cleared = await call(ctx, 'PUT', `${ENG1}/labels`, {
        cookie: f.users.mia.cookie,
        body: { version: 2, labelIds: [] },
      });
      expect(cleared.json()).toMatchObject({ labels: [], version: 3 });
    });

    it('applies nothing when any label belongs to another org', async () => {
      await call(ctx, 'PUT', `${ENG1}/labels`, {
        cookie: f.users.mia.cookie,
        body: { version: 1, labelIds: [f.acme.labels.Bug] },
      });
      const res = await call(ctx, 'PUT', `${ENG1}/labels`, {
        cookie: f.users.mia.cookie,
        body: { version: 2, labelIds: [f.acme.labels.Feature, f.globex.labels.Bug] },
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().error.details).toEqual({ field: 'labelIds' });

      const after = await call(ctx, 'GET', ENG1, { cookie: f.users.mia.cookie });
      expect(after.json().labels.map((l: { name: string }) => l.name)).toEqual(['Bug']);
      expect(after.json().version).toBe(2);
    });

    it('does not bump the version when the set is unchanged', async () => {
      const res = await call(ctx, 'PUT', `${ENG1}/labels`, {
        cookie: f.users.mia.cookie,
        body: { version: 1, labelIds: [] },
      });
      expect(res.json().version).toBe(1);
    });

    it('rejects more than twenty labels and duplicates', async () => {
      const many = Array.from({ length: 21 }, () => randomUUID());
      const tooMany = await call(ctx, 'PUT', `${ENG1}/labels`, {
        cookie: f.users.mia.cookie,
        body: { version: 1, labelIds: many },
      });
      expect(tooMany.statusCode).toBe(400);
      const dupes = await call(ctx, 'PUT', `${ENG1}/labels`, {
        cookie: f.users.mia.cookie,
        body: { version: 1, labelIds: [f.acme.labels.Bug, f.acme.labels.Bug] },
      });
      expect(dupes.statusCode).toBe(400);
    });
  });

  describe('deleting', () => {
    it('deletes the issue with its comments and label links', async () => {
      await call(ctx, 'PUT', `${ENG1}/labels`, {
        cookie: f.users.mia.cookie,
        body: { version: 1, labelIds: [f.acme.labels.Bug] },
      });
      const res = await call(ctx, 'DELETE', ENG1, { cookie: f.users.adam.cookie });
      expect(res.statusCode).toBe(204);
      const id = f.acme.issues['ENG-1'];
      const comments = await ctx.db
        .selectFrom('comments')
        .select('id')
        .where('issue_id', '=', id)
        .execute();
      const links = await ctx.db
        .selectFrom('issue_labels')
        .select('label_id')
        .where('issue_id', '=', id)
        .execute();
      expect(comments).toEqual([]);
      expect(links).toEqual([]);
    });

    it('is reserved for admins and owners', async () => {
      const res = await call(ctx, 'DELETE', ENG1, { cookie: f.users.mia.cookie });
      expect(res.statusCode).toBe(403);
    });
  });
});
