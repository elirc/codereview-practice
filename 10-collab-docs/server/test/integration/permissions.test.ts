import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import type { ControlEvent, DocEvent } from '../../src/services/notifier.js';
import { encodeSyncStep1, encodeSyncUpdate } from '../../src/ws/codec.js';
import { ApiClient, registerUser, type TestUser } from '../helpers/http.js';
import { freshDatabase, startInstance, stopInstances, type RunningInstance } from '../helpers/instance.js';
import { TestClient } from '../helpers/wsClient.js';

let server: RunningInstance;
let owner: TestUser;
let member: TestUser;
let outsider: TestUser;
let workspaceId: string;
let docId: string;

async function rowCount(): Promise<number> {
  const rows = await server.instance.db
    .selectFrom('doc_updates')
    .select('seq')
    .where('doc_id', '=', docId)
    .execute();
  return rows.length;
}

/** Drops access-related notifications, both on this instance and on the bus. */
function silenceAccessMessages() {
  const registry = server.instance.registry;
  const doc = registry.doc.bind(registry);
  vi.spyOn(registry, 'doc').mockImplementation((docId: string, event: DocEvent) => {
    if (event.kind === 'perm' || event.kind === 'trashed') return;
    doc(docId, event);
  });
  vi.spyOn(registry, 'control').mockImplementation((_event: ControlEvent) => undefined);
}

function insertUpdate(text: string): Uint8Array {
  const doc = new Y.Doc();
  doc.getText('content').insert(0, text);
  return Y.encodeStateAsUpdate(doc);
}

beforeEach(async () => {
  await freshDatabase();
  server = await startInstance();
  owner = await registerUser(server.instance.app, 'Olive');
  member = await registerUser(server.instance.app, 'Mia');
  outsider = await registerUser(server.instance.app, 'Otto');
  workspaceId = owner.personalWorkspaceId;
  await owner.api.post(`/api/workspaces/${workspaceId}/members`, { email: member.email });
  const created = await owner.api.post(`/api/workspaces/${workspaceId}/docs`, { title: 'Live' });
  docId = created.body.doc.id;
});

afterEach(async () => {
  vi.restoreAllMocks();
  await stopInstances();
});

describe('permission changes while connected', () => {
  it('closes an editor whose share is deleted', async () => {
    await owner.api.post(`/api/docs/${docId}/shares`, { email: member.email, role: 'editor' });
    const editor = await TestClient.join(server.url, docId, { token: member.token });
    await owner.api.delete(`/api/docs/${docId}/shares/${member.id}`);
    expect((await editor.closed).code).toBe(4403);
  });

  it('refuses the next update after a revoke without any bus message', async () => {
    await owner.api.post(`/api/docs/${docId}/shares`, { email: member.email, role: 'editor' });
    const editor = await TestClient.join(server.url, docId, { token: member.token });
    silenceAccessMessages();
    await owner.api.delete(`/api/docs/${docId}/shares/${member.id}`);
    editor.sendRaw(encodeSyncUpdate(insertUpdate('after revoke')));
    expect((await editor.closed).code).toBe(4403);
    expect(await rowCount()).toBe(0);
  });

  it('closes revoked connections at the sweep without any bus message', async () => {
    await owner.api.post(`/api/docs/${docId}/shares`, { email: member.email, role: 'viewer' });
    const viewer = await TestClient.join(server.url, docId, { token: member.token });
    silenceAccessMessages();
    await owner.api.delete(`/api/docs/${docId}/shares/${member.id}`);
    await server.instance.collab.monitor.sweep(server.clock.now());
    expect((await viewer.closed).code).toBe(4403);
  });

  it('promotes a viewer to editor with a role message and a SyncStep1', async () => {
    await owner.api.post(`/api/docs/${docId}/shares`, { email: member.email, role: 'viewer' });
    const client = await TestClient.join(server.url, docId, { token: member.token });
    const seen = client.controls.length;
    await owner.api.patch(`/api/docs/${docId}/shares/${member.id}`, { role: 'editor' });
    expect(await client.waitForControl('role', seen)).toEqual({ type: 'role', role: 'editor' });
    await client.waitFor(() => client.frames.some((frame) => frame.type === 'sync-step1'));
    client.append('now editing');
    const reader = await TestClient.join(server.url, docId, { token: owner.token });
    await reader.waitForText('now editing');
    await Promise.all([client.close(), reader.close()]);
  });

  it('drops to the share role when the editor link is revoked, without disconnecting', async () => {
    await owner.api.patch(`/api/workspaces/${workspaceId}`, { allowExternalSharing: true });
    await owner.api.post(`/api/docs/${docId}/shares`, { email: outsider.email, role: 'viewer' });
    const link = await owner.api.post(`/api/docs/${docId}/links`, { role: 'editor' });
    const client = await TestClient.join(server.url, docId, {
      token: outsider.token,
      link: link.body.token,
    });
    expect(client.role).toBe('editor');
    const seen = client.controls.length;
    await owner.api.delete(`/api/docs/${docId}/links/${link.body.link.id}`);
    expect(await client.waitForControl('role', seen)).toEqual({ type: 'role', role: 'viewer' });
    expect(client.isOpen()).toBe(true);
    await client.close();
  });

  it('loses access at the next frame once the link has expired', async () => {
    const expiresAt = new Date(server.clock.now().getTime() + 60_000).toISOString();
    const link = await owner.api.post(`/api/docs/${docId}/links`, { role: 'editor', expiresAt });
    const client = await TestClient.join(server.url, docId, {
      token: outsider.token,
      link: link.body.token,
    });
    server.clock.advance(60_000);
    client.sendRaw(encodeSyncStep1(new Uint8Array([0])));
    expect((await client.closed).code).toBe(4403);
  });

  it('loses access at the sweep once the link has expired', async () => {
    const expiresAt = new Date(server.clock.now().getTime() + 60_000).toISOString();
    const link = await owner.api.post(`/api/docs/${docId}/links`, { role: 'viewer', expiresAt });
    const client = await TestClient.join(server.url, docId, { link: link.body.token });
    server.clock.advance(60_000);
    await server.instance.collab.monitor.sweep(server.clock.now());
    expect((await client.closed).code).toBe(4403);
  });

  it('closes sockets of the logged-out session with 4401 and leaves other sessions open', async () => {
    const login = await new ApiClient(server.instance.app).post('/api/auth/login', {
      email: owner.email,
      password: 'correct horse battery',
    });
    const secondToken = login.cookies.find((cookie) => cookie.name === 'cd_session')!.value;
    const tabOne = await TestClient.join(server.url, docId, { token: owner.token });
    const tabTwo = await TestClient.join(server.url, docId, { token: secondToken });
    await owner.api.post('/api/auth/logout', {});
    expect((await tabOne.closed).code).toBe(4401);
    expect(tabTwo.isOpen()).toBe(true);
    await tabTwo.close();
  });

  it('closes a connection whose session expires at its next frame', async () => {
    const client = await TestClient.join(server.url, docId, { token: owner.token });
    server.clock.advance(14 * 86_400_000);
    client.sendRaw(encodeSyncStep1(new Uint8Array([0])));
    expect((await client.closed).code).toBe(4401);
  });

  it('disconnects a removed member from every document of the workspace', async () => {
    await owner.api.patch(`/api/docs/${docId}`, { workspaceAccess: 'editor' });
    const other = await owner.api.post(`/api/workspaces/${workspaceId}/docs`, {
      title: 'Second',
      workspaceAccess: 'viewer',
    });
    const first = await TestClient.join(server.url, docId, { token: member.token });
    const second = await TestClient.join(server.url, other.body.doc.id, { token: member.token });
    await owner.api.delete(`/api/workspaces/${workspaceId}/members/${member.id}`);
    expect((await first.closed).code).toBe(4403);
    expect((await second.closed).code).toBe(4403);
  });

  it('disconnects external users when external sharing is turned off', async () => {
    await owner.api.patch(`/api/workspaces/${workspaceId}`, { allowExternalSharing: true });
    await owner.api.post(`/api/docs/${docId}/shares`, { email: outsider.email, role: 'editor' });
    const external = await TestClient.join(server.url, docId, { token: outsider.token });
    await owner.api.patch(`/api/workspaces/${workspaceId}`, { allowExternalSharing: false });
    expect((await external.closed).code).toBe(4403);
  });

  it('does not store an update that reaches the append path after trashing', async () => {
    const editor = await TestClient.join(server.url, docId, { token: owner.token });
    silenceAccessMessages();
    await owner.api.post(`/api/docs/${docId}/trash`, {});
    editor.sendRaw(encodeSyncUpdate(insertUpdate('too late')));
    expect((await editor.closed).code).toBe(4404);
    expect(await rowCount()).toBe(0);
  });
});

describe('reconnecting', () => {
  it('merges offline edits once and shows them to other clients', async () => {
    const editor = await TestClient.join(server.url, docId, { token: owner.token });
    editor.append('online ');
    const other = await TestClient.join(server.url, docId, { token: owner.token });
    await other.waitForText('online ');
    await editor.close();

    editor.append('offline');
    const back = await TestClient.join(server.url, docId, { token: owner.token, doc: editor.doc });
    await other.waitForText('online offline');
    expect(back.text.toString()).toBe('online offline');
    expect(await rowCount()).toBe(2);
    await Promise.all([back.close(), other.close()]);
  });

  it('tells a client demoted while offline its role first and accepts none of its offline edits', async () => {
    await owner.api.post(`/api/docs/${docId}/shares`, { email: member.email, role: 'editor' });
    const editor = await TestClient.join(server.url, docId, { token: member.token });
    await editor.close();
    editor.append('written while offline');
    await owner.api.patch(`/api/docs/${docId}/shares/${member.id}`, { role: 'viewer' });

    const back = await TestClient.join(server.url, docId, { token: member.token, doc: editor.doc });
    expect(back.frames[0]).toEqual({
      type: 'control',
      message: expect.objectContaining({ type: 'hello', role: 'viewer' }),
    });
    expect(back.frames.some((frame) => frame.type === 'sync-step1')).toBe(false);

    const writer = await TestClient.join(server.url, docId, { token: owner.token });
    writer.append('owner text');
    await back.waitFor(() => back.text.toString().includes('owner text'));
    expect(await rowCount()).toBe(1);
    await Promise.all([back.close(), writer.close()]);
  });
});
