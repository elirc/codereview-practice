import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerUser, type TestUser } from '../helpers/http.js';
import {
  connectionsClosed,
  freshDatabase,
  startInstance,
  stopInstances,
  type RunningInstance,
} from '../helpers/instance.js';
import { TestClient } from '../helpers/wsClient.js';

let server: RunningInstance;
let owner: TestUser;
let member: TestUser;
let outsider: TestUser;
let docId: string;

async function share(user: TestUser, role: string) {
  const response = await owner.api.post(`/api/docs/${docId}/shares`, { email: user.email, role });
  expect(response.status).toBe(201);
}

async function link(role: string): Promise<string> {
  const response = await owner.api.post(`/api/docs/${docId}/links`, { role });
  return response.body.token;
}

beforeEach(async () => {
  await freshDatabase();
  server = await startInstance();
  const app = server.instance.app;
  owner = await registerUser(app, 'Olive');
  member = await registerUser(app, 'Mia');
  outsider = await registerUser(app, 'Otto');
  await owner.api.post(`/api/workspaces/${owner.personalWorkspaceId}/members`, {
    email: member.email,
  });
  const created = await owner.api.post(`/api/workspaces/${owner.personalWorkspaceId}/docs`, {
    title: 'Notes',
  });
  docId = created.body.doc.id;
});

afterEach(async () => {
  await stopInstances();
});

describe('connecting', () => {
  it('greets with hello, then a SyncStep1 for editors', async () => {
    const client = await TestClient.join(server.url, docId, { token: owner.token });
    expect(client.hello).toEqual({
      type: 'hello',
      role: 'owner',
      connectionId: expect.any(String),
      userId: owner.id,
    });
    await client.waitFor(() => client.frames.some((frame) => frame.type === 'sync-step1'));
    expect(client.frames[0].type).toBe('control');
    await client.close();
  });

  it('never sends a SyncStep1 to read-only roles', async () => {
    await share(member, 'commenter');
    const client = await TestClient.join(server.url, docId, { token: member.token });
    expect(client.role).toBe('commenter');
    await client.waitFor(() => client.frames.some((frame) => frame.type === 'sync-step2'));
    expect(client.frames.some((frame) => frame.type === 'sync-step1')).toBe(false);
    await client.close();
  });

  it('resolves roles from shares, workspace access and links', async () => {
    await owner.api.patch(`/api/docs/${docId}`, { workspaceAccess: 'commenter' });
    const viaWorkspace = await TestClient.join(server.url, docId, { token: member.token });
    expect(viaWorkspace.role).toBe('commenter');

    const editorLink = await link('editor');
    const viaLink = await TestClient.join(server.url, docId, {
      token: outsider.token,
      link: editorLink,
    });
    expect(viaLink.role).toBe('editor');

    const viewerLink = await link('viewer');
    const anonymous = await TestClient.join(server.url, docId, { link: viewerLink });
    expect(anonymous.hello?.userId).toBeNull();
    expect(anonymous.role).toBe('viewer');
    await Promise.all([viaWorkspace.close(), viaLink.close(), anonymous.close()]);
  });

  it('refuses a commenter link without a session', async () => {
    const commenterLink = await link('commenter');
    expect(await TestClient.refusedStatus(server.url, docId, { link: commenterLink })).toBe(404);
  });

  it('answers no access, trashed and unknown documents with the same 404', async () => {
    const trashed = await owner.api.post(`/api/workspaces/${owner.personalWorkspaceId}/docs`, {
      title: 'Gone',
    });
    await owner.api.post(`/api/docs/${trashed.body.doc.id}/trash`, {});
    const statuses = await Promise.all([
      TestClient.refusedStatus(server.url, docId, { token: outsider.token }),
      TestClient.refusedStatus(server.url, trashed.body.doc.id, { token: owner.token }),
      TestClient.refusedStatus(server.url, '00000000-0000-4000-8000-000000000000', {
        token: owner.token,
      }),
      TestClient.refusedStatus(server.url, 'not-a-uuid', { token: owner.token }),
    ]);
    expect(statuses).toEqual([404, 404, 404, 404]);
  });

  it('refuses expired and revoked links', async () => {
    const expiresAt = new Date(server.clock.now().getTime() + 1000).toISOString();
    const timed = await owner.api.post(`/api/docs/${docId}/links`, { role: 'viewer', expiresAt });
    server.clock.advance(1000);
    expect(await TestClient.refusedStatus(server.url, docId, { link: timed.body.token })).toBe(404);

    const plain = await owner.api.post(`/api/docs/${docId}/links`, { role: 'viewer' });
    await owner.api.delete(`/api/docs/${docId}/links/${plain.body.link.id}`);
    expect(await TestClient.refusedStatus(server.url, docId, { link: plain.body.token })).toBe(404);
  });

  it('refuses a foreign or missing Origin before the handshake', async () => {
    expect(
      await TestClient.refusedStatus(server.url, docId, {
        token: owner.token,
        origin: 'https://evil.example',
      }),
    ).toBe(403);
    expect(await TestClient.refusedStatus(server.url, docId, { token: owner.token, origin: null })).toBe(
      403,
    );
    expect(server.instance.registry.all()).toHaveLength(0);
  });

  it('limits connections per user and document on one instance', async () => {
    const clients: TestClient[] = [];
    for (let i = 0; i < 8; i += 1) {
      clients.push(await TestClient.join(server.url, docId, { token: owner.token }));
    }
    expect(await TestClient.refusedStatus(server.url, docId, { token: owner.token })).toBe(429);
    const released = connectionsClosed(server.instance);
    await clients[0].close();
    await released;
    const again = await TestClient.join(server.url, docId, { token: owner.token });
    expect(again.role).toBe('owner');
    await Promise.all([...clients.slice(1), again].map((client) => client.close()));
  });

  it('limits anonymous connections per document on one instance', async () => {
    const limited = await startInstance({ env: { MAX_ANONYMOUS_CONNECTIONS_PER_DOC: '2' } });
    const viewerLink = await link('viewer');
    const first = await TestClient.join(limited.url, docId, { link: viewerLink });
    const second = await TestClient.join(limited.url, docId, { link: viewerLink });
    expect(await TestClient.refusedStatus(limited.url, docId, { link: viewerLink })).toBe(429);
    const signedIn = await TestClient.join(limited.url, docId, { token: owner.token });
    expect(signedIn.role).toBe('owner');
    await Promise.all([first.close(), second.close(), signedIn.close()]);
  });

  it('opens one room with one load for simultaneous first connections', async () => {
    const load = vi.spyOn(server.instance.store, 'load');
    const [first, second] = await Promise.all([
      TestClient.join(server.url, docId, { token: owner.token }),
      TestClient.join(server.url, docId, { token: member.token, link: await link('viewer') }),
    ]);
    expect(load).toHaveBeenCalledTimes(1);
    expect(server.instance.registry.all()).toHaveLength(1);
    await Promise.all([first.close(), second.close()]);
  });

  it('closes an idle room and reopens it with everything written meanwhile', async () => {
    const writer = await TestClient.join(server.url, docId, { token: owner.token });
    const observer = await TestClient.join(server.url, docId, { token: owner.token });
    writer.append('first');
    await observer.waitForText('first');
    const closedBoth = connectionsClosed(server.instance, 2);
    await Promise.all([writer.close(), observer.close()]);
    await closedBoth;
    server.clock.advance(30_000);
    expect(await server.instance.registry.sweepIdle(server.clock.now())).toBe(1);
    expect(server.instance.registry.get(docId)).toBeUndefined();

    const reader = await TestClient.join(server.url, docId, { token: owner.token });
    await reader.waitForText('first');
    await reader.close();
  });
});
