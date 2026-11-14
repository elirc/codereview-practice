import { beforeEach, describe, expect, it } from 'vitest';
import { call, useTestContext } from './support/context.js';
import { seedTwoOrgs, type Fixture } from './support/fixtures.js';

const ENG1 = '/api/orgs/acme/projects/ENG/issues/1';

describe('concurrent writes', () => {
  const ctx = useTestContext();
  let f: Fixture;

  beforeEach(async () => {
    f = await seedTwoOrgs(ctx);
  });

  async function ownerCount(orgId: string): Promise<number> {
    const rows = await ctx.db
      .selectFrom('memberships')
      .select('user_id')
      .where('org_id', '=', orgId)
      .where('role', '=', 'owner')
      .execute();
    return rows.length;
  }

  it('gives concurrently created issues distinct consecutive numbers', async () => {
    const responses = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        call(ctx, 'POST', '/api/orgs/acme/projects/ENG/issues', {
          cookie: i % 2 === 0 ? f.users.mia.cookie : f.users.tom.cookie,
          body: { title: `Parallel ${i}` },
        }),
      ),
    );
    expect(responses.map((r) => r.statusCode)).toEqual(Array(10).fill(201));
    const numbers = responses.map((r) => r.json().number as number).sort((a, b) => a - b);
    expect(numbers).toEqual([3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });

  it('lets exactly one of two patches with the same version through', async () => {
    const [a, b] = await Promise.all([
      call(ctx, 'PATCH', ENG1, {
        cookie: f.users.mia.cookie,
        body: { version: 1, status: 'done' },
      }),
      call(ctx, 'PATCH', ENG1, {
        cookie: f.users.tom.cookie,
        body: { version: 1, title: 'Race' },
      }),
    ]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409]);
    const loser = a.statusCode === 409 ? a : b;
    expect(loser.json().error.details.current.version).toBe(2);

    const row = await ctx.db
      .selectFrom('issues')
      .select(['version', 'status', 'title'])
      .where('id', '=', f.acme.issues['ENG-1'])
      .executeTakeFirstOrThrow();
    expect(row.version).toBe(2);
    const statusChanged = row.status === 'done';
    const titleChanged = row.title === 'Race';
    expect(statusChanged !== titleChanged).toBe(true);
  });

  it('lets exactly one of two label replacements with the same version through', async () => {
    const [a, b] = await Promise.all([
      call(ctx, 'PUT', `${ENG1}/labels`, {
        cookie: f.users.mia.cookie,
        body: { version: 1, labelIds: [f.acme.labels.Bug] },
      }),
      call(ctx, 'PUT', `${ENG1}/labels`, {
        cookie: f.users.tom.cookie,
        body: { version: 1, labelIds: [f.acme.labels.Feature] },
      }),
    ]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409]);
    const links = await ctx.db
      .selectFrom('issue_labels')
      .select('label_id')
      .where('issue_id', '=', f.acme.issues['ENG-1'])
      .execute();
    expect(links).toHaveLength(1);
  });

  it('never leaves an org without an owner when two owners demote each other', async () => {
    await ctx.db
      .updateTable('memberships')
      .set({ role: 'owner' })
      .where('org_id', '=', f.acme.id)
      .where('user_id', '=', f.users.adam.id)
      .execute();

    const [a, b] = await Promise.all([
      call(ctx, 'PATCH', `/api/orgs/acme/members/${f.users.adam.id}`, {
        cookie: f.users.alice.cookie,
        body: { role: 'member' },
      }),
      call(ctx, 'PATCH', `/api/orgs/acme/members/${f.users.alice.id}`, {
        cookie: f.users.adam.cookie,
        body: { role: 'member' },
      }),
    ]);
    const successes = [a, b].filter((r) => r.statusCode === 200);
    expect(successes.length).toBeLessThanOrEqual(1);
    expect(await ownerCount(f.acme.id)).toBeGreaterThanOrEqual(1);
  });

  it('never leaves an org without an owner when both owners leave at once', async () => {
    await ctx.db
      .updateTable('memberships')
      .set({ role: 'owner' })
      .where('org_id', '=', f.acme.id)
      .where('user_id', '=', f.users.adam.id)
      .execute();

    const results = await Promise.all([
      call(ctx, 'DELETE', '/api/orgs/acme/members/me', { cookie: f.users.alice.cookie }),
      call(ctx, 'DELETE', '/api/orgs/acme/members/me', { cookie: f.users.adam.cookie }),
    ]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([204, 422]);
    expect(await ownerCount(f.acme.id)).toBe(1);
  });
});
