import { beforeEach, describe, expect, it } from 'vitest';
import { call, errorCode, useTestContext } from './support/context.js';
import { insertComment, seedTwoOrgs, type Fixture } from './support/fixtures.js';

const ENG1_COMMENTS = '/api/orgs/acme/projects/ENG/issues/1/comments';
const ENG2_COMMENTS = '/api/orgs/acme/projects/ENG/issues/2/comments';

describe('comments', () => {
  const ctx = useTestContext();
  let f: Fixture;
  let miaComment: string;

  beforeEach(async () => {
    f = await seedTwoOrgs(ctx);
    miaComment = f.acme.comments['ENG-1:I can reproduce this.'];
  });

  async function issueState(identifier: string) {
    return ctx.db
      .selectFrom('issues')
      .select(['version', 'updated_at'])
      .where('id', '=', f.acme.issues[identifier])
      .executeTakeFirstOrThrow();
  }

  it('lists comments oldest first with cursor pagination', async () => {
    for (const body of ['second', 'third']) {
      ctx.clock.advance(1000);
      await insertComment(ctx, f.acme, 'ENG-1', f.users.tom.id, body);
    }
    const first = await call(ctx, 'GET', `${ENG1_COMMENTS}?limit=2`, {
      cookie: f.users.vic.cookie,
    });
    expect(first.json().items.map((c: { body: string }) => c.body)).toEqual([
      'I can reproduce this.',
      'second',
    ]);
    const second = await call(
      ctx,
      'GET',
      `${ENG1_COMMENTS}?limit=2&cursor=${first.json().nextCursor}`,
      { cookie: f.users.vic.cookie },
    );
    expect(second.json()).toMatchObject({ items: [{ body: 'third' }], nextCursor: null });
    expect(second.json().items[0].author).toEqual({ id: f.users.tom.id, name: 'Tom Member' });
  });

  it('adds a comment and touches the issue without bumping its version', async () => {
    ctx.clock.advance(5000);
    const res = await call(ctx, 'POST', ENG1_COMMENTS, {
      cookie: f.users.tom.cookie,
      body: { body: 'Fixed in staging.' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      body: 'Fixed in staging.',
      author: { id: f.users.tom.id },
      editedAt: null,
    });
    expect(await issueState('ENG-1')).toEqual({ version: 1, updated_at: ctx.clock.now() });
  });

  it('does not let viewers comment', async () => {
    const res = await call(ctx, 'POST', ENG1_COMMENTS, {
      cookie: f.users.vic.cookie,
      body: { body: 'Hello' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('refuses comments on issues in archived projects', async () => {
    const res = await call(ctx, 'POST', '/api/orgs/acme/projects/OPS/issues/1/comments', {
      cookie: f.users.mia.cookie,
      body: { body: 'Hello' },
    });
    expect(res.statusCode).toBe(422);
    expect(errorCode(res)).toBe('project_archived');
  });

  it('lets the author edit and records the edit time', async () => {
    ctx.clock.advance(7000);
    const res = await call(ctx, 'PATCH', `${ENG1_COMMENTS}/${miaComment}`, {
      cookie: f.users.mia.cookie,
      body: { body: 'I can reproduce this on Firefox.' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      body: 'I can reproduce this on Firefox.',
      editedAt: ctx.clock.now().toISOString(),
    });
    expect(await issueState('ENG-1')).toEqual({ version: 1, updated_at: ctx.clock.now() });
  });

  it('does not let anyone else edit, including admins and owners', async () => {
    for (const user of [f.users.tom, f.users.adam, f.users.alice]) {
      const res = await call(ctx, 'PATCH', `${ENG1_COMMENTS}/${miaComment}`, {
        cookie: user.cookie,
        body: { body: 'Rewritten' },
      });
      expect(res.statusCode).toBe(403);
    }
  });

  it('lets the author or an admin delete', async () => {
    const byOther = await call(ctx, 'DELETE', `${ENG1_COMMENTS}/${miaComment}`, {
      cookie: f.users.tom.cookie,
    });
    expect(byOther.statusCode).toBe(403);

    const byAdmin = await call(ctx, 'DELETE', `${ENG1_COMMENTS}/${miaComment}`, {
      cookie: f.users.adam.cookie,
    });
    expect(byAdmin.statusCode).toBe(204);

    const own = await insertComment(ctx, f.acme, 'ENG-1', f.users.tom.id, 'mine');
    const byAuthor = await call(ctx, 'DELETE', `${ENG1_COMMENTS}/${own}`, {
      cookie: f.users.tom.cookie,
    });
    expect(byAuthor.statusCode).toBe(204);
  });

  it('returns 404 for a comment addressed through the wrong issue', async () => {
    const patch = await call(ctx, 'PATCH', `${ENG2_COMMENTS}/${miaComment}`, {
      cookie: f.users.mia.cookie,
      body: { body: 'Moved?' },
    });
    const del = await call(ctx, 'DELETE', `${ENG2_COMMENTS}/${miaComment}`, {
      cookie: f.users.alice.cookie,
    });
    expect(patch.statusCode).toBe(404);
    expect(del.statusCode).toBe(404);
  });

  it('returns 404 for a comment from another org', async () => {
    const globexComment = f.globex.comments['ENG-1:Globex comment'];
    const res = await call(ctx, 'DELETE', `${ENG1_COMMENTS}/${globexComment}`, {
      cookie: f.users.alice.cookie,
    });
    expect(res.statusCode).toBe(404);
  });
});
