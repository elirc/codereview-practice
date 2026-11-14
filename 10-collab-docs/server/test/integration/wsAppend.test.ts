import * as encoding from 'lib0/encoding';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { createDb } from '../../src/db/db.js';
import { encodeControl, encodeSyncStep2, encodeSyncUpdate } from '../../src/ws/codec.js';
import { TEST_DATABASE_URL } from '../helpers/env.js';
import { registerUser, type TestUser } from '../helpers/http.js';
import { freshDatabase, startInstance, stopInstances, type RunningInstance } from '../helpers/instance.js';
import { TestClient } from '../helpers/wsClient.js';

let server: RunningInstance;
let owner: TestUser;
let member: TestUser;
let docId: string;

async function setup(env: Record<string, string> = {}) {
  server = await startInstance({ env });
  owner = await registerUser(server.instance.app, 'Olive');
  member = await registerUser(server.instance.app, 'Mia');
  await owner.api.post(`/api/workspaces/${owner.personalWorkspaceId}/members`, {
    email: member.email,
  });
  const created = await owner.api.post(`/api/workspaces/${owner.personalWorkspaceId}/docs`, {
    title: 'Notes',
  });
  docId = created.body.doc.id;
}

async function rows() {
  return server.instance.db
    .selectFrom('doc_updates')
    .select(['seq', 'user_id'])
    .where('doc_id', '=', docId)
    .orderBy('seq')
    .execute();
}

async function headSeq(): Promise<number> {
  const row = await server.instance.db
    .selectFrom('docs')
    .select('head_seq')
    .where('id', '=', docId)
    .executeTakeFirstOrThrow();
  return row.head_seq;
}

/** An update that inserts text and encodes to exactly `size` bytes. */
function updateOfSize(size: number): Uint8Array {
  const build = (length: number) => {
    const doc = new Y.Doc();
    doc.clientID = 4242;
    doc.getText('content').insert(0, 'x'.repeat(length));
    return Y.encodeStateAsUpdate(doc);
  };
  let length = size - (build(1000).byteLength - 1000);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const update = build(length);
    if (update.byteLength === size) return update;
    length += size - update.byteLength;
  }
  throw new Error(`could not build an update of ${size} bytes`);
}

beforeEach(async () => {
  await freshDatabase();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await stopInstances();
});

describe('append path', () => {
  it('stores one row per update, attributed to the editor, and relays it to readers', async () => {
    await setup();
    await owner.api.patch(`/api/docs/${docId}`, { workspaceAccess: 'viewer' });
    const editor = await TestClient.join(server.url, docId, { token: owner.token });
    const reader = await TestClient.join(server.url, docId, { token: member.token });
    editor.append('hello');
    editor.append(' world');
    await reader.waitForText('hello world');
    expect(await rows()).toEqual([
      { seq: 1, user_id: owner.id },
      { seq: 2, user_id: owner.id },
    ]);
    await Promise.all([editor.close(), reader.close()]);
  });

  it('writes nothing for a reconnect that brings nothing new', async () => {
    await setup();
    const first = await TestClient.join(server.url, docId, { token: owner.token });
    const observer = await TestClient.join(server.url, docId, { token: owner.token });
    first.append('hello world');
    await observer.waitForText('hello world');
    first.text.delete(0, 6);
    await observer.waitForText('world');
    await first.close();
    const before = await headSeq();

    const again = await TestClient.join(server.url, docId, { token: owner.token, doc: first.doc });
    await again.waitFor(() => again.frames.some((frame) => frame.type === 'sync-step1'));
    observer.append('!');
    await again.waitForText('world!');
    expect(await headSeq()).toBe(before + 1);
    await Promise.all([again.close(), observer.close()]);
  });

  it('drops an empty update without writing', async () => {
    await setup();
    const editor = await TestClient.join(server.url, docId, { token: owner.token });
    const empty = new Y.Doc();
    editor.sendRaw(encodeSyncUpdate(Y.encodeStateAsUpdate(empty, Y.encodeStateVector(empty))));
    editor.append('after');
    const observer = await TestClient.join(server.url, docId, { token: owner.token });
    await observer.waitForText('after');
    expect((await rows()).map((row) => row.seq)).toEqual([1]);
    await Promise.all([editor.close(), observer.close()]);
  });

  it('accepts an update of exactly MAX_UPDATE_BYTES and refuses one byte more', async () => {
    await setup();
    const editor = await TestClient.join(server.url, docId, { token: owner.token });
    editor.sendRaw(encodeSyncUpdate(updateOfSize(262_144)));
    const observer = await TestClient.join(server.url, docId, { token: owner.token });
    await observer.waitFor(() => observer.text.length > 0);
    expect(await rows()).toHaveLength(1);

    editor.sendRaw(encodeSyncUpdate(updateOfSize(262_145)));
    expect((await editor.closed).code).toBe(4413);
    expect(await rows()).toHaveLength(1);
    await observer.close();
  });

  it('lets ws close frames over maxPayload with 1009', async () => {
    await setup();
    const editor = await TestClient.join(server.url, docId, { token: owner.token });
    editor.sendRaw(new Uint8Array(300_001));
    expect((await editor.closed).code).toBe(1009);
  });

  it('refuses updates once the document reaches its size cap but stays readable', async () => {
    await setup({ MAX_DOC_BYTES: '200' });
    const editor = await TestClient.join(server.url, docId, { token: owner.token });
    editor.append('x'.repeat(120));
    const observer = await TestClient.join(server.url, docId, { token: owner.token });
    await observer.waitFor(() => observer.text.length === 120);
    editor.append('y'.repeat(120));
    expect((await editor.closed).code).toBe(4413);
    expect(await rows()).toHaveLength(1);
    const reader = await TestClient.join(server.url, docId, { token: owner.token });
    await reader.waitForText('x'.repeat(120));
    await Promise.all([observer.close(), reader.close()]);
  });
});

describe('inbound frame checks', () => {
  it('closes a viewer that sends an update or SyncStep2, even an empty one', async () => {
    await setup();
    await owner.api.post(`/api/docs/${docId}/shares`, { email: member.email, role: 'viewer' });
    const empty = new Y.Doc();
    const emptyUpdate = Y.encodeStateAsUpdate(empty, Y.encodeStateVector(empty));
    for (const frame of [encodeSyncUpdate(emptyUpdate), encodeSyncStep2(emptyUpdate)]) {
      const viewer = await TestClient.join(server.url, docId, { token: member.token });
      viewer.sendRaw(frame);
      expect((await viewer.closed).code).toBe(4403);
    }
    expect(await headSeq()).toBe(0);
  });

  it('refuses content from a commenter', async () => {
    await setup();
    await owner.api.post(`/api/docs/${docId}/shares`, { email: member.email, role: 'commenter' });
    const commenter = await TestClient.join(server.url, docId, { token: member.token });
    const doc = new Y.Doc();
    doc.getText('content').insert(0, 'sneaky');
    commenter.sendRaw(encodeSyncUpdate(Y.encodeStateAsUpdate(doc)));
    expect((await commenter.closed).code).toBe(4403);
    expect(await rows()).toHaveLength(0);
  });

  it('closes malformed updates, text frames and client control frames with 4400', async () => {
    await setup();
    const garbage = encoding.createEncoder();
    encoding.writeVarUint(garbage, 0);
    encoding.writeVarUint(garbage, 2);
    encoding.writeVarUint8Array(garbage, new Uint8Array([5]));
    const frames: Array<[Uint8Array | string, boolean]> = [
      [encoding.toUint8Array(garbage), true],
      ['hello', false],
      [encodeControl({ type: 'comments_changed' }), true],
    ];
    for (const [frame, binary] of frames) {
      const editor = await TestClient.join(server.url, docId, { token: owner.token });
      editor.sendRaw(frame, binary);
      expect((await editor.closed).code).toBe(4400);
    }
    expect(server.instance.registry.get(docId)?.doc.getText('content').toString() ?? '').toBe('');
    expect(await headSeq()).toBe(0);
  });

  it('closes the 101st frame within one second with 4429', async () => {
    await setup({ WS_RATE_BURST: '100', WS_RATE_PER_SEC: '50' });
    const editor = await TestClient.join(server.url, docId, { token: owner.token });
    const syncStep1 = new Uint8Array([0, 0, 1, 0]);
    // The client already sent one SyncStep1 on open; these are frames 2 to 101.
    for (let i = 0; i < 100; i += 1) editor.sendRaw(syncStep1);
    expect((await editor.closed).code).toBe(4429);
  });
});

describe('shutdown', () => {
  it('persists accepted updates before closing sockets with 1001', async () => {
    await setup();
    const editor = await TestClient.join(server.url, docId, { token: owner.token });
    const store = server.instance.store;
    const original = store.append.bind(store);
    let reached!: () => void;
    const appendStarted = new Promise<void>((resolve) => {
      reached = resolve;
    });
    let openGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    vi.spyOn(store, 'append').mockImplementation(async (input) => {
      reached();
      await gate;
      return original(input);
    });

    editor.append('last words');
    await appendStarted;
    const closing = server.instance.close();
    openGate();
    expect((await editor.closed).code).toBe(1001);
    await closing;

    const db = createDb(TEST_DATABASE_URL, 1);
    const stored = await db.selectFrom('doc_updates').select('seq').where('doc_id', '=', docId).execute();
    await db.destroy();
    expect(stored).toHaveLength(1);
  });
});
