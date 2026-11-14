import { beforeEach, describe, expect, it } from 'vitest';
import { call, useTestContext } from './support/context.js';
import { insertIssue, seedTwoOrgs, type Fixture } from './support/fixtures.js';

describe('issue search', () => {
  const ctx = useTestContext();
  let f: Fixture;

  beforeEach(async () => {
    f = await seedTwoOrgs(ctx);
  });

  async function search(q: string, extra = '', org = 'acme', cookie = f.users.dana.cookie) {
    const res = await call(
      ctx,
      'GET',
      `/api/orgs/${org}/issues?q=${encodeURIComponent(q)}${extra}`,
      { cookie },
    );
    expect(res.statusCode).toBe(200);
    return res.json().items.map((i: { identifier: string }) => i.identifier) as string[];
  }

  it('treats KEY-n as an identifier lookup in the current org', async () => {
    expect(await search('ENG-2')).toEqual(['ENG-2']);
    expect(await search('ENG-3')).toEqual([]);
    expect(await search('ENG-3', '', 'globex')).toEqual(['ENG-3']);
    expect(await search('MKT-1')).toEqual([]);
  });

  it('matches identifiers case-insensitively', async () => {
    expect(await search('eng-1')).toEqual(['ENG-1']);
    expect(await search('  Ops-1  ')).toEqual(['OPS-1']);
  });

  it('handles identifiers with numbers too large to exist', async () => {
    expect(await search('ENG-99999999999999')).toEqual([]);
  });

  it('finds words in titles and descriptions', async () => {
    expect(await search('crash')).toEqual(['ENG-2']);
    expect(await search('footer')).toEqual(['ENG-1']);
    expect(await search('screens overlap')).toEqual(['ENG-1']);
  });

  it('ranks by the list sort rather than relevance', async () => {
    await insertIssue(ctx, f.acme, 'ENG', {
      title: 'Another crash',
      description: 'crash crash crash',
      reporterId: f.users.alice.id,
      createdAt: new Date(Date.parse('2026-01-01T00:00:00.000Z')),
    });
    expect(await search('crash')).toEqual(['ENG-2', 'ENG-3']);
    expect(await search('crash', '&limit=1')).toEqual(['ENG-2']);
  });

  it('never returns results from another org', async () => {
    expect(await search('globex')).toEqual([]);
    expect(await search('globex', '', 'globex')).toHaveLength(3);
  });

  it('copes with quotes, wildcards, operators and backslashes', async () => {
    for (const q of ["it's", '100%', ':*', 'crash:*', '\\', '"unbalanced', "'; drop table", '&|!()']) {
      await search(q);
    }
    expect(await search('"login button')).toEqual(['ENG-1']);
  });

  it('returns nothing for queries made only of stop words or punctuation', async () => {
    expect(await search('the and of')).toEqual([]);
    expect(await search('!!!')).toEqual([]);
  });

  it('combines with the other filters', async () => {
    await call(ctx, 'PATCH', '/api/orgs/acme/projects/ENG/issues/2', {
      cookie: f.users.mia.cookie,
      body: { version: 1, status: 'done' },
    });
    expect(await search('crash', '&status=done')).toEqual(['ENG-2']);
    expect(await search('crash', '&status=todo')).toEqual([]);
    expect(await search('login', `&assigneeId=${f.users.mia.id}`)).toEqual(['ENG-1']);
    expect(await search('ENG-1', '&projectKey=OPS')).toEqual([]);
  });

  it('rejects blank queries', async () => {
    const res = await call(ctx, 'GET', '/api/orgs/acme/issues?q=%20%20', {
      cookie: f.users.dana.cookie,
    });
    expect(res.statusCode).toBe(400);
  });
});
