import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ApiClient, registerUser, type TestUser } from '../helpers/http.js';
import { createHttpTestApp, type HttpTestApp } from '../helpers/httpApp.js';

let t: HttpTestApp;
let owner: TestUser;
let member: TestUser;
let outsider: TestUser;
let workspaceId: string;

async function createDoc(user: TestUser, title = 'Plan', workspaceAccess?: string) {
  const response = await user.api.post(`/api/workspaces/${workspaceId}/docs`, {
    title,
    ...(workspaceAccess ? { workspaceAccess } : {}),
  });
  expect(response.status).toBe(201);
  return response.body.doc as { id: string };
}

async function docEpoch(docId: string): Promise<number> {
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
});

afterEach(async () => {
  await t.close();
});

describe('documents', () => {
  it('lets any member create a document they own', async () => {
    const doc = await createDoc(member);
    const fetched = await member.api.get(`/api/docs/${doc.id}`);
    expect(fetched.body.doc).toEqual(
      expect.objectContaining({ title: 'Plan', ownerId: member.id, role: 'owner', canManage: true }),
    );
  });

  it('refuses document creation in a workspace the caller is not in', async () => {
    const response = await outsider.api.post(`/api/workspaces/${workspaceId}/docs`, {
      title: 'Nope',
    });
    expect(response.status).toBe(404);
  });

  it('applies workspace access to members and gives workspace admins editor', async () => {
    const doc = await createDoc(member, 'Shared', 'commenter');
    const asOwner = await owner.api.get(`/api/docs/${doc.id}`);
    expect(asOwner.body.doc.role).toBe('editor');
    expect(asOwner.body.doc.canManage).toBe(true);

    const other = await registerUser(t.app, 'Nia');
    await owner.api.post(`/api/workspaces/${workspaceId}/members`, { email: other.email });
    expect((await other.api.get(`/api/docs/${doc.id}`)).body.doc.role).toBe('commenter');
    expect((await outsider.api.get(`/api/docs/${doc.id}`)).status).toBe(404);
  });

  it('lists only documents the caller can open, with their role', async () => {
    const privateDoc = await createDoc(owner, 'Private');
    const openDoc = await createDoc(owner, 'Open', 'viewer');
    const list = await member.api.get(`/api/workspaces/${workspaceId}/docs`);
    expect(list.status).toBe(200);
    const ids = list.body.docs.map((doc: { id: string }) => doc.id);
    expect(ids).toContain(openDoc.id);
    expect(ids).not.toContain(privateDoc.id);
    expect(list.body.docs[0].role).toBe('viewer');
  });

  it('separates renaming (editor) from changing workspace access (manager)', async () => {
    const doc = await createDoc(owner, 'Draft', 'editor');
    const before = await docEpoch(doc.id);
    const rename = await member.api.patch(`/api/docs/${doc.id}`, { title: 'Renamed' });
    expect(rename.status).toBe(200);
    expect(rename.body.doc.title).toBe('Renamed');
    expect(await docEpoch(doc.id)).toBe(before);
    expect(t.notifier.docEvents).toContainEqual({
      docId: doc.id,
      event: { kind: 'meta', title: 'Renamed' },
    });

    const access = await member.api.patch(`/api/docs/${doc.id}`, { workspaceAccess: 'viewer' });
    expect(access.status).toBe(403);

    const byOwner = await owner.api.patch(`/api/docs/${doc.id}`, { workspaceAccess: 'viewer' });
    expect(byOwner.status).toBe(200);
    expect(await docEpoch(doc.id)).toBe(before + 1);
    expect(t.notifier.docEvents).toContainEqual({ docId: doc.id, event: { kind: 'perm' } });

    const viewerRename = await member.api.patch(`/api/docs/${doc.id}`, { title: 'Again' });
    expect(viewerRename.status).toBe(403);
  });

  it('transfers only to workspace members', async () => {
    const doc = await createDoc(owner);
    const refused = await owner.api.post(`/api/docs/${doc.id}/transfer`, { userId: outsider.id });
    expect(refused.status).toBe(422);
    expect(refused.body.error.code).toBe('not_a_member');

    const moved = await owner.api.post(`/api/docs/${doc.id}/transfer`, { userId: member.id });
    expect(moved.status).toBe(200);
    expect(moved.body.doc.ownerId).toBe(member.id);
    expect(moved.body.doc.role).toBe('editor');
  });
});

describe('trash', () => {
  it('hides a trashed document from everyone and restores it', async () => {
    const doc = await createDoc(owner, 'Old', 'editor');
    const before = await docEpoch(doc.id);
    expect((await member.api.post(`/api/docs/${doc.id}/trash`, {})).status).toBe(403);
    expect((await owner.api.post(`/api/docs/${doc.id}/trash`, {})).status).toBe(204);
    expect(await docEpoch(doc.id)).toBe(before + 1);
    expect(t.notifier.docEvents).toContainEqual({ docId: doc.id, event: { kind: 'trashed' } });

    expect((await owner.api.get(`/api/docs/${doc.id}`)).status).toBe(404);
    expect((await member.api.get(`/api/docs/${doc.id}`)).status).toBe(404);

    const trash = await owner.api.get(`/api/workspaces/${workspaceId}/docs?trashed=true`);
    expect(trash.body.docs.map((d: { id: string }) => d.id)).toEqual([doc.id]);
    const memberTrash = await member.api.get(`/api/workspaces/${workspaceId}/docs?trashed=true`);
    expect(memberTrash.body.docs).toEqual([]);

    expect((await owner.api.post(`/api/docs/${doc.id}/trash`, {})).status).toBe(409);
    const restored = await owner.api.post(`/api/docs/${doc.id}/restore`, {});
    expect(restored.status).toBe(200);
    expect(restored.body.doc.trashedAt).toBeNull();
    expect((await member.api.get(`/api/docs/${doc.id}`)).status).toBe(200);
  });

  it('responds with the same 404 for trashed, inaccessible and unknown documents', async () => {
    const trashed = await createDoc(owner, 'Trashed', 'viewer');
    await owner.api.post(`/api/docs/${trashed.id}/trash`, {});
    const privateDoc = await createDoc(owner, 'Private');
    const responses = await Promise.all([
      member.api.get(`/api/docs/${trashed.id}`),
      member.api.get(`/api/docs/${privateDoc.id}`),
      member.api.get('/api/docs/00000000-0000-4000-8000-000000000000'),
    ]);
    for (const response of responses) {
      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe('not_found');
      expect(response.body.error.message).toBe('Document not found.');
    }
  });
});

describe('member removal', () => {
  it('deletes their shares, hands their documents to the workspace owner and bumps the epoch', async () => {
    const theirs = await createDoc(member, 'Mine');
    const ownerDoc = await createDoc(owner, 'Owner doc');
    await owner.api.post(`/api/docs/${ownerDoc.id}/shares`, { email: member.email, role: 'editor' });
    await member.api.post(`/api/docs/${theirs.id}/shares`, { email: owner.email, role: 'viewer' });

    const removed = await owner.api.delete(`/api/workspaces/${workspaceId}/members/${member.id}`);
    expect(removed.status).toBe(204);

    const doc = await t.db
      .selectFrom('docs')
      .select('owner_id')
      .where('id', '=', theirs.id)
      .executeTakeFirstOrThrow();
    expect(doc.owner_id).toBe(owner.id);
    const shares = await t.db.selectFrom('doc_shares').selectAll().execute();
    expect(shares).toEqual([]);
    expect((await member.api.get(`/api/docs/${ownerDoc.id}`)).status).toBe(404);
    expect(t.notifier.controlEvents).toContainEqual({ kind: 'workspace_perm', workspaceId });
  });

  it('keeps their shares when external sharing is on', async () => {
    await owner.api.patch(`/api/workspaces/${workspaceId}`, { allowExternalSharing: true });
    const ownerDoc = await createDoc(owner, 'Owner doc');
    await owner.api.post(`/api/docs/${ownerDoc.id}/shares`, { email: member.email, role: 'viewer' });
    await owner.api.delete(`/api/workspaces/${workspaceId}/members/${member.id}`);
    const fetched = await member.api.get(`/api/docs/${ownerDoc.id}`);
    expect(fetched.status).toBe(200);
    expect(fetched.body.doc.role).toBe('viewer');
  });
});

describe('anonymous access', () => {
  it('allows anonymous reads only through a viewer link', async () => {
    const doc = await createDoc(owner, 'Public');
    const viewerLink = await owner.api.post(`/api/docs/${doc.id}/links`, { role: 'viewer' });
    const commenterLink = await owner.api.post(`/api/docs/${doc.id}/links`, { role: 'commenter' });
    const anonymous = new ApiClient(t.app);
    expect((await anonymous.get(`/api/docs/${doc.id}`)).status).toBe(404);
    const viaViewer = await anonymous.get(`/api/docs/${doc.id}?link=${viewerLink.body.token}`);
    expect(viaViewer.status).toBe(200);
    expect(viaViewer.body.doc.role).toBe('viewer');
    expect(
      (await anonymous.get(`/api/docs/${doc.id}?link=${commenterLink.body.token}`)).status,
    ).toBe(404);
    const signedIn = await outsider.api.get(`/api/docs/${doc.id}?link=${commenterLink.body.token}`);
    expect(signedIn.body.doc.role).toBe('commenter');
  });
});
