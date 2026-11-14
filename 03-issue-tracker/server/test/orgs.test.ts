import { beforeEach, describe, expect, it } from 'vitest';
import { call, errorCode, useTestContext } from './support/context.js';
import { seedTwoOrgs, type Fixture } from './support/fixtures.js';

function withoutRequestId(body: { error: Record<string, unknown> }) {
  const { requestId: _requestId, ...rest } = body.error;
  return rest;
}

describe('organisations', () => {
  const ctx = useTestContext();
  let f: Fixture;

  beforeEach(async () => {
    f = await seedTwoOrgs(ctx);
  });

  it('makes the creator the owner', async () => {
    const res = await call(ctx, 'POST', '/api/orgs', {
      cookie: f.users.gus.cookie,
      body: { slug: 'initech', name: 'Initech' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ slug: 'initech', name: 'Initech', role: 'owner' });

    const me = await call(ctx, 'GET', '/api/auth/me', { cookie: f.users.gus.cookie });
    expect(me.json().memberships).toContainEqual({
      orgSlug: 'initech',
      orgName: 'Initech',
      role: 'owner',
    });
  });

  it('rejects a slug that is already taken', async () => {
    const res = await call(ctx, 'POST', '/api/orgs', {
      cookie: f.users.gus.cookie,
      body: { slug: 'acme', name: 'Another Acme' },
    });
    expect(res.statusCode).toBe(409);
    expect(errorCode(res)).toBe('slug_taken');
  });

  it('validates the slug format', async () => {
    for (const slug of ['A-Upper', '-leading', 'x', 'has space']) {
      const res = await call(ctx, 'POST', '/api/orgs', {
        cookie: f.users.gus.cookie,
        body: { slug, name: 'Bad' },
      });
      expect(res.statusCode).toBe(400);
    }
  });

  it('requires authentication to create an org', async () => {
    const res = await call(ctx, 'POST', '/api/orgs', { body: { slug: 'nope', name: 'Nope' } });
    expect(res.statusCode).toBe(401);
  });

  it('shows the org and the caller role to any member', async () => {
    const res = await call(ctx, 'GET', '/api/orgs/acme', { cookie: f.users.vic.cookie });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ id: f.acme.id, slug: 'acme', name: 'ACME', role: 'viewer' });
  });

  it('hides orgs from non-members exactly like orgs that do not exist', async () => {
    const foreign = await call(ctx, 'GET', '/api/orgs/acme', { cookie: f.users.gina.cookie });
    const missing = await call(ctx, 'GET', '/api/orgs/no-such-org', {
      cookie: f.users.gina.cookie,
    });
    expect(foreign.statusCode).toBe(404);
    expect(missing.statusCode).toBe(404);
    expect(withoutRequestId(foreign.json())).toEqual(withoutRequestId(missing.json()));

    const foreignMembers = await call(ctx, 'GET', '/api/orgs/acme/members', {
      cookie: f.users.gina.cookie,
    });
    expect(foreignMembers.statusCode).toBe(404);
    expect(withoutRequestId(foreignMembers.json())).toEqual(withoutRequestId(missing.json()));
  });

  it('lets only the owner rename the org', async () => {
    const byAdmin = await call(ctx, 'PATCH', '/api/orgs/acme', {
      cookie: f.users.adam.cookie,
      body: { name: 'Acme Corp' },
    });
    expect(byAdmin.statusCode).toBe(403);

    const byOwner = await call(ctx, 'PATCH', '/api/orgs/acme', {
      cookie: f.users.alice.cookie,
      body: { name: 'Acme Corp' },
    });
    expect(byOwner.statusCode).toBe(200);
    expect(byOwner.json().name).toBe('Acme Corp');
  });

  it('does not allow the slug to change through PATCH', async () => {
    const res = await call(ctx, 'PATCH', '/api/orgs/acme', {
      cookie: f.users.alice.cookie,
      body: { name: 'Acme', slug: 'acme-two' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('lets only the owner delete the org, removing its data', async () => {
    const byAdmin = await call(ctx, 'DELETE', '/api/orgs/acme', { cookie: f.users.adam.cookie });
    expect(byAdmin.statusCode).toBe(403);

    const byOwner = await call(ctx, 'DELETE', '/api/orgs/acme', { cookie: f.users.alice.cookie });
    expect(byOwner.statusCode).toBe(204);

    const after = await call(ctx, 'GET', '/api/orgs/acme', { cookie: f.users.alice.cookie });
    expect(after.statusCode).toBe(404);
    const issues = await ctx.db
      .selectFrom('issues')
      .select('id')
      .where('org_id', '=', f.acme.id)
      .execute();
    expect(issues).toHaveLength(0);
    const globexIssues = await ctx.db
      .selectFrom('issues')
      .select('id')
      .where('org_id', '=', f.globex.id)
      .execute();
    expect(globexIssues).toHaveLength(4);
  });
});
