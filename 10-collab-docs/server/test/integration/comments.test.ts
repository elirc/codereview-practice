import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { toBase64 } from '../../src/lib/bytes.js';
import { registerUser, type TestUser } from '../helpers/http.js';
import { freshDatabase, startInstance, stopInstances, type RunningInstance } from '../helpers/instance.js';
import { TestClient } from '../helpers/wsClient.js';

let server: RunningInstance;
let owner: TestUser;
let commenter: TestUser;
let viewer: TestUser;
let docId: string;
let editor: TestClient;

function anchorFor(text: Y.Text, start: number, end: number) {
  return {
    start: toBase64(Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(text, start, 0))),
    end: toBase64(Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(text, end, -1))),
  };
}

async function threads(user: TestUser = owner) {
  const response = await user.api.get(`/api/docs/${docId}/threads`);
  expect(response.status).toBe(200);
  return response.body.threads;
}

beforeEach(async () => {
  await freshDatabase();
  server = await startInstance();
  owner = await registerUser(server.instance.app, 'Olive');
  commenter = await registerUser(server.instance.app, 'Cleo');
  viewer = await registerUser(server.instance.app, 'Vic');
  const workspaceId = owner.personalWorkspaceId;
  for (const user of [commenter, viewer]) {
    await owner.api.post(`/api/workspaces/${workspaceId}/members`, { email: user.email });
  }
  const created = await owner.api.post(`/api/workspaces/${workspaceId}/docs`, { title: 'Doc' });
  docId = created.body.doc.id;
  await owner.api.post(`/api/docs/${docId}/shares`, { email: commenter.email, role: 'commenter' });
  await owner.api.post(`/api/docs/${docId}/shares`, { email: viewer.email, role: 'viewer' });
  editor = await TestClient.join(server.url, docId, { token: owner.token });
  const observer = await TestClient.join(server.url, docId, { token: owner.token });
  editor.append('hello world');
  await observer.waitForText('hello world');
  await observer.close();
});

afterEach(async () => {
  await editor.close();
  await stopInstances();
});

describe('threads', () => {
  it('lets a commenter create a thread whose quote comes from the server', async () => {
    const response = await commenter.api.post(`/api/docs/${docId}/threads`, {
      anchor: anchorFor(editor.text, 6, 11),
      body: 'Which world?',
    });
    expect(response.status).toBe(201);
    expect(response.body.thread).toEqual(
      expect.objectContaining({
        quotedText: 'world',
        status: 'open',
        range: { start: 6, end: 11 },
        detached: false,
        createdBy: commenter.id,
      }),
    );
    expect(response.body.thread.comments).toEqual([
      expect.objectContaining({ body: 'Which world?', authorName: 'Cleo' }),
    ]);
  });

  it('refuses threads from viewers', async () => {
    const response = await viewer.api.post(`/api/docs/${docId}/threads`, {
      anchor: anchorFor(editor.text, 0, 5),
      body: 'Hi',
    });
    expect(response.status).toBe(403);
  });

  it('refuses an empty range and malformed anchors', async () => {
    const empty = await owner.api.post(`/api/docs/${docId}/threads`, {
      anchor: anchorFor(editor.text, 3, 3),
      body: 'Nothing here',
    });
    expect(empty.status).toBe(422);
    expect(empty.body.error.code).toBe('empty_anchor');
    const malformed = await owner.api.post(`/api/docs/${docId}/threads`, {
      anchor: { start: 'not base64!', end: 'AAAA' },
      body: 'Broken',
    });
    expect(malformed.status).toBe(400);
  });

  it('answers anchor_unknown until the edit reaches the server', async () => {
    editor.autoSend = false;
    editor.append(' and more');
    const request = { anchor: anchorFor(editor.text, 12, 20), body: 'More what?' };
    const early = await owner.api.post(`/api/docs/${docId}/threads`, request);
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe('anchor_unknown');

    const observer = await TestClient.join(server.url, docId, { token: owner.token });
    editor.flush();
    await observer.waitForText('hello world and more');
    const later = await owner.api.post(`/api/docs/${docId}/threads`, request);
    expect(later.status).toBe(201);
    expect(later.body.thread.quotedText).toBe('and more');
    await observer.close();
  });

  it('follows edits and reports detached threads with their quote', async () => {
    const created = await owner.api.post(`/api/docs/${docId}/threads`, {
      anchor: anchorFor(editor.text, 6, 11),
      body: 'Watch this',
    });
    const id = created.body.thread.id;
    const observer = await TestClient.join(server.url, docId, { token: owner.token });
    editor.type(0, '>> ');
    await observer.waitForText('>> hello world');
    expect((await threads()).find((t: { id: string }) => t.id === id).range).toEqual({
      start: 9,
      end: 14,
    });

    editor.text.delete(9, 5);
    await observer.waitForText('>> hello ');
    const detached = (await threads()).find((t: { id: string }) => t.id === id);
    expect(detached.detached).toBe(true);
    expect(detached.quotedText).toBe('world');
    await observer.close();
  });

  it('resolves threads against the database when no room is open here', async () => {
    await owner.api.post(`/api/docs/${docId}/threads`, {
      anchor: anchorFor(editor.text, 0, 5),
      body: 'Greeting',
    });
    await editor.close();
    const closed = new Promise<void>((resolve) => {
      const check = () => (server.instance.collab.connections.size === 0 ? resolve() : undefined);
      server.instance.collab.on('connection-closed', check);
      check();
    });
    await closed;
    server.clock.advance(60_000);
    await server.instance.registry.sweepIdle(server.clock.now());
    expect(server.instance.registry.get(docId)).toBeUndefined();
    const [thread] = await threads(viewer);
    expect(thread.range).toEqual({ start: 0, end: 5 });
    expect(thread.detached).toBe(false);
  });
});

describe('replies and resolution', () => {
  async function createThread(user: TestUser) {
    const response = await user.api.post(`/api/docs/${docId}/threads`, {
      anchor: anchorFor(editor.text, 0, 5),
      body: 'First',
    });
    expect(response.status).toBe(201);
    return response.body.thread as { id: string; comments: Array<{ id: string }> };
  }

  it('lets a commenter resolve their own thread but not another one', async () => {
    const own = await createThread(commenter);
    const others = await createThread(owner);
    expect((await commenter.api.post(`/api/threads/${own.id}/resolve`, {})).status).toBe(204);
    expect((await commenter.api.post(`/api/threads/${others.id}/resolve`, {})).status).toBe(403);
    expect((await owner.api.post(`/api/threads/${others.id}/resolve`, {})).status).toBe(204);
    expect((await owner.api.post(`/api/threads/${others.id}/resolve`, {})).status).toBe(409);
    expect((await commenter.api.post(`/api/threads/${own.id}/reopen`, {})).status).toBe(204);
  });

  it('reopens a resolved thread on reply', async () => {
    const thread = await createThread(owner);
    await owner.api.post(`/api/threads/${thread.id}/resolve`, {});
    const replied = await commenter.api.post(`/api/threads/${thread.id}/comments`, { body: 'But…' });
    expect(replied.status).toBe(201);
    const [listed] = await threads();
    expect(listed.status).toBe('open');
    expect(listed.resolvedBy).toBeNull();
    expect(listed.comments.map((c: { body: string }) => c.body)).toEqual(['First', 'But…']);
  });

  it('lets only the author edit or delete a comment and keeps deleted rows', async () => {
    const thread = await createThread(commenter);
    const first = thread.comments[0].id;
    expect((await owner.api.patch(`/api/comments/${first}`, { body: 'Hijack' })).status).toBe(403);
    expect((await commenter.api.patch(`/api/comments/${first}`, { body: 'Edited' })).status).toBe(204);
    expect((await commenter.api.delete(`/api/comments/${first}`)).status).toBe(204);
    const [listed] = await threads();
    expect(listed.id).toBe(thread.id);
    expect(listed.comments[0]).toEqual(
      expect.objectContaining({ body: '', deletedAt: expect.any(String), editedAt: expect.any(String) }),
    );
    expect((await commenter.api.patch(`/api/comments/${first}`, { body: 'Again' })).status).toBe(409);
  });

  it('tells connected clients that comments changed', async () => {
    const reader = await TestClient.join(server.url, docId, { token: viewer.token });
    const seen = reader.controls.length;
    await createThread(owner);
    expect(await reader.waitForControl('comments_changed', seen)).toEqual({ type: 'comments_changed' });
    await reader.close();
  });

  it('validates reply length', async () => {
    const thread = await createThread(owner);
    const tooLong = await owner.api.post(`/api/threads/${thread.id}/comments`, {
      body: 'x'.repeat(4001),
    });
    expect(tooLong.status).toBe(400);
    const empty = await owner.api.post(`/api/threads/${thread.id}/comments`, { body: '' });
    expect(empty.status).toBe(400);
  });
});
