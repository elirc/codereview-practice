import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { addsNothing } from '../../src/collab/updates.js';

function synced(): { server: Y.Doc; client: Y.Doc } {
  const client = new Y.Doc();
  client.getText('content').insert(0, 'hello world');
  client.getText('content').delete(0, 6);
  const server = new Y.Doc();
  Y.applyUpdate(server, Y.encodeStateAsUpdate(client));
  return { server, client };
}

describe('addsNothing', () => {
  it('is true for an empty update', () => {
    const doc = new Y.Doc();
    const empty = Y.encodeStateAsUpdate(doc, Y.encodeStateVector(doc));
    expect(addsNothing(Y.decodeUpdate(empty), doc)).toBe(true);
  });

  it('is true for a reply that only repeats known deletions', () => {
    const { server, client } = synced();
    const reply = Y.encodeStateAsUpdate(client, Y.encodeStateVector(server));
    const decoded = Y.decodeUpdate(reply);
    expect(decoded.ds.clients.size).toBeGreaterThan(0);
    expect(addsNothing(decoded, server)).toBe(true);
  });

  it('is false when the update inserts text', () => {
    const { server, client } = synced();
    client.getText('content').insert(0, '!');
    const reply = Y.encodeStateAsUpdate(client, Y.encodeStateVector(server));
    expect(addsNothing(Y.decodeUpdate(reply), server)).toBe(false);
  });

  it('is false when the update deletes something the document still has', () => {
    const { server, client } = synced();
    const deletions: Uint8Array[] = [];
    client.on('update', (update: Uint8Array) => deletions.push(update));
    client.getText('content').delete(0, 1);
    expect(addsNothing(Y.decodeUpdate(deletions[0]), server)).toBe(false);
  });
});
