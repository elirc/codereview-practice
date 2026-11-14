import { beforeEach, describe, expect, it } from 'vitest';
import { call, errorCode, useTestContext } from './support/context.js';
import { seedTwoOrgs, type Fixture } from './support/fixtures.js';

describe('projects', () => {
  const ctx = useTestContext();
  let f: Fixture;

  beforeEach(async () => {
    f = await seedTwoOrgs(ctx);
  });

  it('lists the org projects, including archived ones', async () => {
    const res = await call(ctx, 'GET', '/api/orgs/acme/projects', { cookie: f.users.vic.cookie });
    expect(res.statusCode).toBe(200);
    const items = res.json().items as { key: string; archivedAt: string | null }[];
    expect(items.map((p) => p.key)).toEqual(['ENG', 'OPS']);
    expect(items[0].archivedAt).toBeNull();
    expect(items[1].archivedAt).toEqual(expect.any(String));
  });

  it('creates a project with a unique upper-case key', async () => {
    const created = await call(ctx, 'POST', '/api/orgs/acme/projects', {
      cookie: f.users.adam.cookie,
      body: { key: 'MKT', name: 'Marketing' },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ key: 'MKT', name: 'Marketing', archivedAt: null });

    const duplicate = await call(ctx, 'POST', '/api/orgs/acme/projects', {
      cookie: f.users.adam.cookie,
      body: { key: 'ENG', name: 'Engineering again' },
    });
    expect(duplicate.statusCode).toBe(409);
    expect(errorCode(duplicate)).toBe('project_key_taken');
  });

  it('validates the key format', async () => {
    for (const key of ['eng', 'E', 'TOOLONGX', 'EN1']) {
      const res = await call(ctx, 'POST', '/api/orgs/acme/projects', {
        cookie: f.users.adam.cookie,
        body: { key, name: 'Bad' },
      });
      expect(res.statusCode).toBe(400);
    }
  });

  it('renames a project but never changes its key', async () => {
    const renamed = await call(ctx, 'PATCH', '/api/orgs/acme/projects/ENG', {
      cookie: f.users.adam.cookie,
      body: { name: 'Engineering' },
    });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json()).toMatchObject({ key: 'ENG', name: 'Engineering' });

    const rekey = await call(ctx, 'PATCH', '/api/orgs/acme/projects/ENG', {
      cookie: f.users.adam.cookie,
      body: { name: 'Engineering', key: 'ENGG' },
    });
    expect(rekey.statusCode).toBe(400);
  });

  it('archives a project', async () => {
    const res = await call(ctx, 'POST', '/api/orgs/acme/projects/ENG/archive', {
      cookie: f.users.alice.cookie,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().archivedAt).toBe(ctx.clock.now().toISOString());
  });

  it('does not resolve a project key that exists only in another org', async () => {
    const res = await call(ctx, 'PATCH', '/api/orgs/acme/projects/MKT', {
      cookie: f.users.alice.cookie,
      body: { name: 'Mine now' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('forbids members from managing projects', async () => {
    const res = await call(ctx, 'POST', '/api/orgs/acme/projects', {
      cookie: f.users.mia.cookie,
      body: { key: 'NEW', name: 'New' },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('labels', () => {
  const ctx = useTestContext();
  let f: Fixture;

  beforeEach(async () => {
    f = await seedTwoOrgs(ctx);
  });

  it('lists labels alphabetically', async () => {
    const res = await call(ctx, 'GET', '/api/orgs/acme/labels', { cookie: f.users.vic.cookie });
    expect(res.json().items.map((l: { name: string }) => l.name)).toEqual(['Bug', 'Feature']);
  });

  it('creates a label and normalises its colour', async () => {
    const res = await call(ctx, 'POST', '/api/orgs/acme/labels', {
      cookie: f.users.adam.cookie,
      body: { name: 'Docs', color: '#AABBCC' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ name: 'Docs', color: '#aabbcc' });
  });

  it('treats names case-insensitively within an org only', async () => {
    const clash = await call(ctx, 'POST', '/api/orgs/acme/labels', {
      cookie: f.users.adam.cookie,
      body: { name: 'bug', color: '#000000' },
    });
    expect(clash.statusCode).toBe(409);
    expect(errorCode(clash)).toBe('label_exists');

    const otherOrg = await call(ctx, 'POST', '/api/orgs/globex/labels', {
      cookie: f.users.gina.cookie,
      body: { name: 'Feature', color: '#000000' },
    });
    expect(otherOrg.statusCode).toBe(201);
  });

  it('rejects a rename that collides with another label', async () => {
    const res = await call(ctx, 'PATCH', `/api/orgs/acme/labels/${f.acme.labels.Feature}`, {
      cookie: f.users.adam.cookie,
      body: { name: 'BUG' },
    });
    expect(res.statusCode).toBe(409);
    expect(errorCode(res)).toBe('label_exists');
  });

  it('removes a deleted label from issues', async () => {
    await ctx.db
      .insertInto('issue_labels')
      .values({
        org_id: f.acme.id,
        issue_id: f.acme.issues['ENG-1'],
        label_id: f.acme.labels.Bug,
      })
      .execute();
    const res = await call(ctx, 'DELETE', `/api/orgs/acme/labels/${f.acme.labels.Bug}`, {
      cookie: f.users.adam.cookie,
    });
    expect(res.statusCode).toBe(204);
    const links = await ctx.db.selectFrom('issue_labels').selectAll().execute();
    expect(links).toEqual([]);
  });

  it('does not resolve another org label id', async () => {
    const patch = await call(ctx, 'PATCH', `/api/orgs/acme/labels/${f.globex.labels.Bug}`, {
      cookie: f.users.alice.cookie,
      body: { color: '#111111' },
    });
    expect(patch.statusCode).toBe(404);

    const del = await call(ctx, 'DELETE', `/api/orgs/acme/labels/${f.globex.labels.Bug}`, {
      cookie: f.users.alice.cookie,
    });
    expect(del.statusCode).toBe(404);
  });
});
