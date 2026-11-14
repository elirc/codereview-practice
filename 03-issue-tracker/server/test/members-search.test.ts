import { beforeEach, describe, expect, it } from 'vitest';
import { call, useTestContext } from './support/context.js';
import { seedTwoOrgs, type Fixture } from './support/fixtures.js';

describe('member search', () => {
  const ctx = useTestContext();
  let f: Fixture;

  beforeEach(async () => {
    f = await seedTwoOrgs(ctx);
  });

  async function names(q: string) {
    const res = await call(ctx, 'GET', `/api/orgs/acme/members?q=${encodeURIComponent(q)}`, {
      cookie: f.users.mia.cookie,
    });
    expect(res.statusCode).toBe(200);
    return res.json().items.map((m: { name: string }) => m.name) as string[];
  }

  it('matches part of a name, ignoring case', async () => {
    expect(await names('member')).toEqual(['Mia Member', 'Tom Member']);
  });

  it('matches part of an email address', async () => {
    expect(await names('both.test')).toEqual(['Dana Dual']);
  });

  it('only searches the current org', async () => {
    expect(await names('gina')).toEqual([]);
  });
});
