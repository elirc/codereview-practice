import { beforeEach, describe, expect, it } from 'vitest';
import { call, errorCode, useTestContext } from './support/context.js';
import { seedTwoOrgs, type Fixture } from './support/fixtures.js';

describe('bulk status update', () => {
  const ctx = useTestContext();
  let f: Fixture;

  beforeEach(async () => {
    f = await seedTwoOrgs(ctx);
  });

  it('moves every selected issue to the new status', async () => {
    ctx.clock.advance(60_000);
    const res = await call(ctx, 'POST', '/api/orgs/acme/issues/bulk-status', {
      cookie: f.users.mia.cookie,
      body: { issueIds: [f.acme.issues['ENG-1'], f.acme.issues['ENG-2']], status: 'done' },
    });
    expect(res.statusCode).toBe(200);
    const items = res.json().items as { identifier: string; status: string; updatedAt: string }[];
    expect(items.map((i) => i.identifier).sort()).toEqual(['ENG-1', 'ENG-2']);
    expect(items.every((i) => i.status === 'done')).toBe(true);
    expect(items.every((i) => i.updatedAt === ctx.clock.now().toISOString())).toBe(true);
  });

  it('refuses issues in archived projects', async () => {
    const res = await call(ctx, 'POST', '/api/orgs/acme/issues/bulk-status', {
      cookie: f.users.mia.cookie,
      body: { issueIds: [f.acme.issues['ENG-1'], f.acme.issues['OPS-1']], status: 'done' },
    });
    expect(res.statusCode).toBe(422);
    expect(errorCode(res)).toBe('project_archived');
  });

  it('is not available to viewers', async () => {
    const res = await call(ctx, 'POST', '/api/orgs/acme/issues/bulk-status', {
      cookie: f.users.vic.cookie,
      body: { issueIds: [f.acme.issues['ENG-1']], status: 'done' },
    });
    expect(res.statusCode).toBe(403);
  });
});
