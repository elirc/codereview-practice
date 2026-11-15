import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  addsNothing,
  appliesCleanly,
  classifyInbound,
  tryApplyUpdate,
} from '../../src/collab/updates.js';

function synced(): { server: Y.Doc; client: Y.Doc } {
  const client = new Y.Doc();
  client.getText('content').insert(0, 'hello world');
  client.getText('content').delete(0, 6);
  const server = new Y.Doc();
  Y.applyUpdate(server, Y.encodeStateAsUpdate(client));
  return { server, client };
}

describe('appliesCleanly', () => {
  it('accepts a real update and refuses truncated bytes', () => {
    const doc = new Y.Doc();
    doc.getText('content').insert(0, 'hello');
    const update = Y.encodeStateAsUpdate(doc);
    expect(appliesCleanly(update)).toBe(true);
    expect(appliesCleanly(update.subarray(0, update.length - 3))).toBe(false);
    expect(tryApplyUpdate(new Y.Doc(), update.subarray(0, 2))).toBe(false);
  });
});

describe('addsNothing', () => {
  it('is true for an empty update', () => {
    const doc = new Y.Doc();
    const empty = Y.encodeStateAsUpdate(doc, Y.encodeStateVector(doc));
    expect(addsNothing(empty, doc)).toBe(true);
  });

  it('is true for a reply that only repeats known deletions', () => {
    const { server, client } = synced();
    const reply = Y.encodeStateAsUpdate(client, Y.encodeStateVector(server));
    expect(Y.decodeUpdate(reply).ds.clients.size).toBeGreaterThan(0);
    expect(addsNothing(reply, server)).toBe(true);
  });

  it('is true for an update the document already contains', () => {
    const { server, client } = synced();
    expect(addsNothing(Y.encodeStateAsUpdate(client), server)).toBe(true);
  });

  it('is false when the update inserts text', () => {
    const { server, client } = synced();
    client.getText('content').insert(0, '!');
    const reply = Y.encodeStateAsUpdate(client, Y.encodeStateVector(server));
    expect(addsNothing(reply, server)).toBe(false);
  });

  it('is false when the update deletes something the document still has', () => {
    const { server, client } = synced();
    const deletions: Uint8Array[] = [];
    client.on('update', (update: Uint8Array) => deletions.push(update));
    client.getText('content').delete(0, 1);
    expect(addsNothing(deletions[0], server)).toBe(false);
  });
});

describe('classifyInbound', () => {
  it('stores an update that inserts text', () => {
    const { server, client } = synced();
    client.getText('content').insert(0, '!');
    const reply = Y.encodeStateAsUpdate(client, Y.encodeStateVector(server));
    expect(classifyInbound(reply, server, 1_000)).toBe('store');
  });

  it('reports an update the document already has as unchanged', () => {
    const { server, client } = synced();
    expect(classifyInbound(Y.encodeStateAsUpdate(client), server, 1_000)).toBe('unchanged');
  });

  it('refuses updates over the size limit', () => {
    const { server, client } = synced();
    client.getText('content').insert(0, 'x'.repeat(200));
    const reply = Y.encodeStateAsUpdate(client, Y.encodeStateVector(server));
    expect(classifyInbound(reply, server, 100)).toBe('too_large');
  });

  it('reports bytes that are not an update as malformed', () => {
    const { server } = synced();
    expect(classifyInbound(new Uint8Array([5]), server, 1_000)).toBe('malformed');
  });
});
