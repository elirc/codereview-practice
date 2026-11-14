import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeClock } from '../helpers/env.js';
import { registerUser, type TestUser } from '../helpers/http.js';
import { freshDatabase, startInstance, stopInstances, type RunningInstance } from '../helpers/instance.js';
import { TestClient } from '../helpers/wsClient.js';

let a: RunningInstance;
let b: RunningInstance;
let owner: TestUser;
let member: TestUser;
let docId: string;

beforeEach(async () => {
  await freshDatabase();
  const clock = new FakeClock();
  a = await startInstance({ clock });
  b = await startInstance({ clock });
  owner = await registerUser(a.instance.app, 'Olive');
  member = await registerUser(a.instance.app, 'Mia');
  await owner.api.post(`/api/workspaces/${owner.personalWorkspaceId}/members`, {
    email: member.email,
  });
  const created = await owner.api.post(`/api/workspaces/${owner.personalWorkspaceId}/docs`, {
    title: 'Presence',
    workspaceAccess: 'viewer',
  });
  docId = created.body.doc.id;
});

afterEach(async () => {
  await stopInstances();
});

describe('presence', () => {
  it('relays presence across instances with the server-assigned identity', async () => {
    const author = await TestClient.join(a.url, docId, { token: member.token });
    const watcher = await TestClient.join(b.url, docId, { token: owner.token });
    author.sendPresence(
      { user: { id: owner.id, name: 'Not Mia', color: '#00aa00' }, cursor: { anchor: 0, head: 0 } },
      1,
    );
    await watcher.waitFor(() => watcher.presence().has(author.doc.clientID));
    expect(watcher.presence().get(author.doc.clientID)).toEqual({
      user: { id: member.id, name: 'Mia', color: '#00aa00' },
      cursor: { anchor: 0, head: 0 },
    });
    await Promise.all([author.close(), watcher.close()]);
  });

  it('sends current presence to a newly joined connection', async () => {
    const author = await TestClient.join(a.url, docId, { token: member.token });
    const local = await TestClient.join(a.url, docId, { token: owner.token });
    author.sendPresence({ user: { color: 'blue' } }, 1);
    await local.waitFor(() => local.presence().has(author.doc.clientID));
    const late = await TestClient.join(a.url, docId, { token: owner.token });
    expect(late.presence().get(author.doc.clientID)).toEqual({
      user: { id: member.id, name: 'Mia', color: 'blue' },
    });
    await Promise.all([author.close(), local.close(), late.close()]);
  });

  it('closes a connection that names a second client id and never relays it', async () => {
    const author = await TestClient.join(a.url, docId, { token: member.token });
    const watcher = await TestClient.join(a.url, docId, { token: owner.token });
    author.sendPresence({}, 1);
    await watcher.waitFor(() => watcher.presence().has(author.doc.clientID));
    author.sendPresence({ user: { name: 'Impostor' } }, 1, 999_999);
    expect((await author.closed).code).toBe(4403);
    await watcher.waitFor(() => watcher.presence().size === 0);
    expect(watcher.presence().has(999_999)).toBe(false);
    await watcher.close();
  });

  it('refuses a client id already used by another connection', async () => {
    const first = await TestClient.join(a.url, docId, { token: member.token });
    const second = await TestClient.join(a.url, docId, { token: owner.token });
    first.sendPresence({}, 1);
    await second.waitFor(() => second.presence().has(first.doc.clientID));
    second.sendPresence({}, 5, first.doc.clientID);
    expect((await second.closed).code).toBe(4403);
    await first.close();
  });

  it('refuses presence from an anonymous viewer link', async () => {
    const link = await owner.api.post(`/api/docs/${docId}/links`, { role: 'viewer' });
    const anonymous = await TestClient.join(a.url, docId, { link: link.body.token });
    expect(anonymous.role).toBe('viewer');
    anonymous.sendPresence({}, 1);
    expect((await anonymous.closed).code).toBe(4403);
  });

  it('removes presence on every instance when a connection drops without a close frame', async () => {
    const author = await TestClient.join(a.url, docId, { token: member.token });
    const watcher = await TestClient.join(b.url, docId, { token: owner.token });
    author.sendPresence({}, 1);
    await watcher.waitFor(() => watcher.presence().has(author.doc.clientID));
    await author.terminate();
    await watcher.waitFor(() => !watcher.presence().has(author.doc.clientID));
    expect(a.instance.registry.get(docId)!.awareness.getStates().has(author.doc.clientID)).toBe(false);
    await watcher.close();
  });

  it('terminates connections that stop answering pings', async () => {
    const client = await TestClient.join(a.url, docId, { token: owner.token });
    const connection = [...a.instance.collab.connections][0];
    connection.alive = false;
    a.instance.collab.pingOnce();
    expect((await client.closed).code).toBe(1006);
  });
});
