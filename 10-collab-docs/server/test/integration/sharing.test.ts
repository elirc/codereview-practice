import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ApiClient, registerUser, type TestUser } from '../helpers/http.js';
import { createHttpTestApp, type HttpTestApp } from '../helpers/httpApp.js';

let t: HttpTestApp;
let owner: TestUser;
let member: TestUser;
let outsider: TestUser;
let workspaceId: string;
let docId: string;

async function docEpoch(): Promise<number> {
  const row = await t.db
    .selectFrom('docs')
    .select('perm_epoch')
    .where('id', '=', docId)
    .executeTakeFirstOrThrow();
  return row.perm_epoch;
}

beforeEach(async () => {
  t = await createHttpTestApp();
  owner = await registerUser(t.app, 'Olive');
  member = await registerUser(t.app, 'Mia');
  outsider = await registerUser(t.app, 'Otto');
  workspaceId = (await owner.api.post('/api/workspaces', { name: 'Team' })).body.workspace.id;
  await owner.api.post(`/api/workspaces/${workspaceId}/members`, { email: member.email });
  docId = (await owner.api.post(`/api/workspaces/${workspaceId}/docs`, { title: 'Spec' })).body.doc
    .id;
});

afterEach(async () => {
  await t.close();
});

describe('shares', () => {
  it('shares by email, bumps the document epoch and announces it', async () => {
    const before = await docEpoch();
    const response = await owner.api.post(`/api/docs/${docId}/shares`, {
      email: member.email,
      role: 'commenter',
    });
    expect(response.status).toBe(201);
    expect(response.body.share).toEqual(
      expect.objectContaining({ userId: member.id, role: 'commenter', external: false }),
    );
    expect(await docEpoch()).toBe(before + 1);
    expect(t.notifier.docEvents).toContainEqual({ docId, event: { kind: 'perm' } });
    expect((await member.api.get(`/api/docs/${docId}`)).body.doc.role).toBe('commenter');
  });

  it('reports unknown emails', async () => {
    const response = await owner.api.post(`/api/docs/${docId}/shares`, {
      email: 'ghost@example.com',
      role: 'viewer',
    });
    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe('user_not_found');
  });

  it('refuses sharing with the current owner', async () => {
    const response = await owner.api.post(`/api/docs/${docId}/shares`, {
      email: owner.email,
      role: 'editor',
    });
    expect(response.status).toBe(422);
  });

  it('never grants owner through a share', async () => {
    const response = await owner.api.post(`/api/docs/${docId}/shares`, {
      email: member.email,
      role: 'owner',
    });
    expect(response.status).toBe(400);
  });

  it('refuses non-members while external sharing is off', async () => {
    const response = await owner.api.post(`/api/docs/${docId}/shares`, {
      email: outsider.email,
      role: 'viewer',
    });
    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe('external_sharing_disabled');
  });

  it('removes external shares when external sharing is turned off', async () => {
    await owner.api.patch(`/api/workspaces/${workspaceId}`, { allowExternalSharing: true });
    const external = await owner.api.post(`/api/docs/${docId}/shares`, {
      email: outsider.email,
      role: 'editor',
    });
    expect(external.body.share.external).toBe(true);
    await owner.api.post(`/api/docs/${docId}/shares`, { email: member.email, role: 'viewer' });
    expect((await outsider.api.get(`/api/docs/${docId}`)).status).toBe(200);

    await owner.api.patch(`/api/workspaces/${workspaceId}`, { allowExternalSharing: false });
    expect((await outsider.api.get(`/api/docs/${docId}`)).status).toBe(404);
    const shares = await owner.api.get(`/api/docs/${docId}/shares`);
    expect(shares.body.shares.map((s: { userId: string }) => s.userId)).toEqual([member.id]);
    expect(t.notifier.controlEvents).toContainEqual({ kind: 'workspace_perm', workspaceId });
  });

  it('updates and deletes shares, and only managers may', async () => {
    await owner.api.post(`/api/docs/${docId}/shares`, { email: member.email, role: 'editor' });
    const byEditor = await member.api.delete(`/api/docs/${docId}/shares/${member.id}`);
    expect(byEditor.status).toBe(403);

    expect(
      (await owner.api.patch(`/api/docs/${docId}/shares/${member.id}`, { role: 'viewer' })).status,
    ).toBe(204);
    expect((await member.api.get(`/api/docs/${docId}`)).body.doc.role).toBe('viewer');
    expect((await owner.api.delete(`/api/docs/${docId}/shares/${member.id}`)).status).toBe(204);
    expect((await member.api.get(`/api/docs/${docId}`)).status).toBe(404);
    expect((await owner.api.delete(`/api/docs/${docId}/shares/${member.id}`)).status).toBe(404);
  });
});

describe('links', () => {
  it('returns the token once and stores only its hash', async () => {
    const created = await owner.api.post(`/api/docs/${docId}/links`, { role: 'viewer' });
    expect(created.status).toBe(201);
    expect(created.body.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const rows = await t.db.selectFrom('doc_links').select('token_hash').execute();
    expect(rows[0].token_hash).not.toContain(created.body.token);
    const listed = await owner.api.get(`/api/docs/${docId}/links`);
    expect(listed.body.links[0]).not.toHaveProperty('token');
  });

  it('gives no access after expiry or revocation', async () => {
    const expiresAt = new Date(t.clock.now().getTime() + 60_000).toISOString();
    const timed = await owner.api.post(`/api/docs/${docId}/links`, { role: 'viewer', expiresAt });
    const anonymous = new ApiClient(t.app);
    const url = `/api/docs/${docId}?link=${timed.body.token}`;
    expect((await anonymous.get(url)).status).toBe(200);
    t.clock.advance(60_000);
    expect((await anonymous.get(url)).status).toBe(404);

    const plain = await owner.api.post(`/api/docs/${docId}/links`, { role: 'viewer' });
    const before = await docEpoch();
    const revoke = await owner.api.delete(`/api/docs/${docId}/links/${plain.body.link.id}`);
    expect(revoke.status).toBe(204);
    expect(await docEpoch()).toBe(before + 1);
    expect((await anonymous.get(`/api/docs/${docId}?link=${plain.body.token}`)).status).toBe(404);
  });

  it('refuses an expiry in the past', async () => {
    const response = await owner.api.post(`/api/docs/${docId}/links`, {
      role: 'viewer',
      expiresAt: new Date(t.clock.now().getTime() - 1000).toISOString(),
    });
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('validation_failed');
  });

  it('does not let a link holder manage the document', async () => {
    const editorLink = await owner.api.post(`/api/docs/${docId}/links`, { role: 'editor' });
    const response = await outsider.api.get(`/api/docs/${docId}/shares?link=${editorLink.body.token}`);
    expect(response.status).toBe(403);
  });
});
