import { beforeEach, describe, expect, it } from 'vitest';
import { call, errorCode, useTestContext, type TestContext } from './support/context.js';
import { insertIssue, seedTwoOrgs, type Fixture } from './support/fixtures.js';

interface Item {
  identifier: string;
  priority: number;
  id: string;
}

/** Follows nextCursor until the list is exhausted, returning every page. */
async function collectPages(
  ctx: TestContext,
  cookie: string,
  path: string,
  between?: (pageIndex: number) => Promise<void>,
): Promise<Item[][]> {
  const pages: Item[][] = [];
  let cursor: string | null = null;
  do {
    const separator = path.includes('?') ? '&' : '?';
    const url: string = cursor ? `${path}${separator}cursor=${cursor}` : path;
    const res = await call(ctx, 'GET', url, { cookie });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { items: Item[]; nextCursor: string | null };
    pages.push(body.items);
    cursor = body.nextCursor;
    if (between) await between(pages.length);
  } while (cursor);
  return pages;
}

describe('issue list pagination', () => {
  const ctx = useTestContext();
  let f: Fixture;
  const base = Date.parse('2026-03-05T00:00:00.000Z');

  beforeEach(async () => {
    f = await seedTwoOrgs(ctx);
  });

  async function addIssues(count: number, at: (i: number) => Date, priority = (_i: number) => 0) {
    for (let i = 0; i < count; i++) {
      await insertIssue(ctx, f.acme, 'ENG', {
        title: `Bulk ${i}`,
        reporterId: f.users.alice.id,
        createdAt: at(i),
        priority: priority(i),
      });
    }
  }

  it('pages by creation time, newest first, without duplicates or gaps', async () => {
    await addIssues(5, (i) => new Date(base + i * 1000));
    const pages = await collectPages(ctx, f.users.mia.cookie, '/api/orgs/acme/issues?limit=3');
    expect(pages.map((p) => p.length)).toEqual([3, 3, 2]);
    expect(pages.flat().map((i) => i.identifier)).toEqual([
      'ENG-7',
      'ENG-6',
      'ENG-5',
      'ENG-4',
      'ENG-3',
      'OPS-1',
      'ENG-2',
      'ENG-1',
    ]);
  });

  it('breaks ties on identical timestamps by id', async () => {
    const same = new Date(base);
    await addIssues(6, () => same);
    const pages = await collectPages(
      ctx,
      f.users.mia.cookie,
      '/api/orgs/acme/issues?projectKey=ENG&limit=2',
    );
    const all = pages.flat();
    expect(all).toHaveLength(8);
    expect(new Set(all.map((i) => i.id)).size).toBe(8);
    const tied = all.slice(0, 6).map((i) => i.id);
    expect(tied).toEqual([...tied].sort().reverse());
  });

  it('keeps microsecond precision in cursors', async () => {
    for (const micros of ['000001', '000002', '000003']) {
      await ctx.db
        .insertInto('issues')
        .values({
          org_id: f.acme.id,
          project_id: f.acme.projects.ENG,
          number: 100 + Number(micros),
          title: `Micro ${micros}`,
          reporter_id: f.users.alice.id,
          created_at: `2026-03-06T00:00:00.${micros}Z`,
          updated_at: `2026-03-06T00:00:00.${micros}Z`,
        })
        .execute();
    }
    const pages = await collectPages(
      ctx,
      f.users.mia.cookie,
      '/api/orgs/acme/issues?projectKey=ENG&limit=1',
    );
    expect(pages.flat().map((i) => i.identifier)).toEqual([
      'ENG-103',
      'ENG-102',
      'ENG-101',
      'ENG-2',
      'ENG-1',
    ]);
  });

  it('sorts by priority with id as the tie-breaker', async () => {
    await addIssues(
      6,
      (i) => new Date(base + i * 1000),
      (i) => i % 3,
    );
    const pages = await collectPages(
      ctx,
      f.users.mia.cookie,
      '/api/orgs/acme/issues?projectKey=ENG&sort=priority&limit=3',
    );
    const all = pages.flat();
    expect(all).toHaveLength(8);
    const priorities = all.map((i) => i.priority);
    expect(priorities).toEqual([...priorities].sort((a, b) => b - a));
    for (let i = 1; i < all.length; i++) {
      if (all[i].priority === all[i - 1].priority) {
        expect(all[i].id < all[i - 1].id).toBe(true);
      }
    }
  });

  it('sorts by last update', async () => {
    ctx.clock.advance(60_000);
    await call(ctx, 'PATCH', '/api/orgs/acme/projects/ENG/issues/1', {
      cookie: f.users.mia.cookie,
      body: { version: 1, priority: 3 },
    });
    const pages = await collectPages(
      ctx,
      f.users.mia.cookie,
      '/api/orgs/acme/issues?sort=updated&limit=2',
    );
    expect(pages.flat().map((i) => i.identifier)).toEqual(['ENG-1', 'OPS-1', 'ENG-2']);
  });

  it('neither skips nor repeats rows when issues are created between fetches', async () => {
    await addIssues(4, (i) => new Date(base + i * 1000));
    const before = (await collectPages(ctx, f.users.mia.cookie, '/api/orgs/acme/issues?limit=100'))
      .flat()
      .map((i) => i.identifier);

    let inserted = 0;
    const pages = await collectPages(
      ctx,
      f.users.mia.cookie,
      '/api/orgs/acme/issues?limit=2',
      async () => {
        inserted += 1;
        await insertIssue(ctx, f.acme, 'ENG', {
          title: `Late arrival ${inserted}`,
          reporterId: f.users.alice.id,
          createdAt: new Date(base + 100_000 + inserted * 1000),
        });
      },
    );
    const seen = pages.flat().map((i) => i.identifier);
    expect(seen).toEqual(before);
  });

  it('returns no cursor when exactly limit rows exist and one more page for limit + 1', async () => {
    await ctx.db.deleteFrom('issues').where('org_id', '=', f.acme.id).execute();
    const rows = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        org_id: f.acme.id,
        project_id: f.acme.projects.ENG,
        number: 1000 + i,
        title: `Row ${i}`,
        reporter_id: f.users.alice.id,
        created_at: new Date(base + i * 1000),
        updated_at: new Date(base + i * 1000),
      }));
    await ctx.db.insertInto('issues').values(rows(100)).execute();

    const exact = await call(ctx, 'GET', '/api/orgs/acme/issues?limit=100', {
      cookie: f.users.mia.cookie,
    });
    expect(exact.json().items).toHaveLength(100);
    expect(exact.json().nextCursor).toBeNull();

    await ctx.db
      .insertInto('issues')
      .values({ ...rows(1)[0], number: 2000, created_at: new Date(base - 1000) })
      .execute();
    const first = await call(ctx, 'GET', '/api/orgs/acme/issues?limit=100', {
      cookie: f.users.mia.cookie,
    });
    expect(first.json().nextCursor).toEqual(expect.any(String));
    const second = await call(
      ctx,
      'GET',
      `/api/orgs/acme/issues?limit=100&cursor=${first.json().nextCursor}`,
      { cookie: f.users.mia.cookie },
    );
    expect(second.json().items.map((i: Item) => i.identifier)).toEqual(['ENG-2000']);
    expect(second.json().nextCursor).toBeNull();
  });

  it('rejects tampered cursors and cursors from another sort', async () => {
    const garbage = Buffer.from(JSON.stringify({ hello: 'world' })).toString('base64url');
    for (const cursor of [garbage, 'not-a-cursor', 'eyJzIjoiY3JlYXRlZCJ9']) {
      const res = await call(ctx, 'GET', `/api/orgs/acme/issues?cursor=${cursor}`, {
        cookie: f.users.mia.cookie,
      });
      expect(res.statusCode).toBe(400);
      expect(errorCode(res)).toBe('invalid_cursor');
    }

    const page = await call(ctx, 'GET', '/api/orgs/acme/issues?limit=1', {
      cookie: f.users.mia.cookie,
    });
    const mismatch = await call(
      ctx,
      'GET',
      `/api/orgs/acme/issues?sort=updated&cursor=${page.json().nextCursor}`,
      { cookie: f.users.mia.cookie },
    );
    expect(mismatch.statusCode).toBe(400);
    expect(errorCode(mismatch)).toBe('invalid_cursor');
  });

  it('scopes a reused cursor to the org it is presented to', async () => {
    await addIssues(2, (i) => new Date(base + i * 1000));
    const acmePage = await call(ctx, 'GET', '/api/orgs/acme/issues?limit=1', {
      cookie: f.users.dana.cookie,
    });
    const res = await call(
      ctx,
      'GET',
      `/api/orgs/globex/issues?limit=100&cursor=${acmePage.json().nextCursor}`,
      { cookie: f.users.dana.cookie },
    );
    expect(res.statusCode).toBe(200);
    const ids = res.json().items.map((i: Item) => i.id);
    const globexIds = Object.values(f.globex.issues);
    expect(ids.length).toBeGreaterThan(0);
    expect(ids.every((id: string) => globexIds.includes(id))).toBe(true);
  });
});

describe('issue list filters', () => {
  const ctx = useTestContext();
  let f: Fixture;

  beforeEach(async () => {
    f = await seedTwoOrgs(ctx);
  });

  async function identifiers(query: string, cookie = f.users.mia.cookie) {
    const res = await call(ctx, 'GET', `/api/orgs/acme/issues${query}`, { cookie });
    expect(res.statusCode).toBe(200);
    return res.json().items.map((i: Item) => i.identifier);
  }

  it('lists only the current org', async () => {
    expect(await identifiers('')).toEqual(['OPS-1', 'ENG-2', 'ENG-1']);
  });

  it('filters by project, status and assignee', async () => {
    await call(ctx, 'PATCH', '/api/orgs/acme/projects/ENG/issues/2', {
      cookie: f.users.mia.cookie,
      body: { version: 1, status: 'todo' },
    });
    expect(await identifiers('?projectKey=ENG')).toEqual(['ENG-2', 'ENG-1']);
    expect(await identifiers('?status=todo')).toEqual(['ENG-2']);
    expect(await identifiers('?status=todo&status=backlog')).toEqual(['OPS-1', 'ENG-2', 'ENG-1']);
    expect(await identifiers(`?assigneeId=${f.users.mia.id}`)).toEqual(['ENG-1']);
    expect(await identifiers('?assigneeId=none')).toEqual(['OPS-1', 'ENG-2']);
    expect(await identifiers('?projectKey=MKT')).toEqual([]);
  });

  it('requires every requested label', async () => {
    const bug = f.acme.labels.Bug;
    const feature = f.acme.labels.Feature;
    await call(ctx, 'PUT', '/api/orgs/acme/projects/ENG/issues/1/labels', {
      cookie: f.users.mia.cookie,
      body: { version: 1, labelIds: [bug, feature] },
    });
    await call(ctx, 'PUT', '/api/orgs/acme/projects/ENG/issues/2/labels', {
      cookie: f.users.mia.cookie,
      body: { version: 1, labelIds: [bug] },
    });
    expect(await identifiers(`?labelId=${bug}`)).toEqual(['ENG-2', 'ENG-1']);
    expect(await identifiers(`?labelId=${bug}&labelId=${feature}`)).toEqual(['ENG-1']);
    expect(await identifiers(`?labelId=${f.globex.labels.Bug}`)).toEqual([]);
  });

  it('rejects unknown query parameters', async () => {
    const res = await call(ctx, 'GET', `/api/orgs/acme/issues?orgId=${f.globex.id}`, {
      cookie: f.users.mia.cookie,
    });
    expect(res.statusCode).toBe(400);
  });
});
