import { once } from 'node:events';
import { Redis } from 'ioredis';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BusMessage } from '../../src/collab/busMessages.js';
import { docChannel } from '../../src/collab/busMessages.js';
import { contentOf, docFromLog } from '../../src/collab/docState.js';
import { toBase64 } from '../../src/lib/bytes.js';
import { createLogger } from '../../src/lib/logger.js';
import { compactOnce } from '../../src/worker/compaction.js';
import { FakeClock, TEST_REDIS_URL } from '../helpers/env.js';
import { typedUpdates } from '../helpers/fixtures.js';
import { registerUser, type TestUser } from '../helpers/http.js';
import {
  connectionsClosed,
  freshDatabase,
  startInstance,
  stopInstances,
  type RunningInstance,
} from '../helpers/instance.js';
import { TestClient } from '../helpers/wsClient.js';

let a: RunningInstance;
let b: RunningInstance;
let owner: TestUser;
let docId: string;
let raw: Redis;

async function storedText(): Promise<string> {
  const log = await a.instance.store.load(docId);
  return contentOf(docFromLog(log)).toString();
}

async function rowCount(): Promise<number> {
  const rows = await a.instance.db
    .selectFrom('doc_updates')
    .select('seq')
    .where('doc_id', '=', docId)
    .execute();
  return rows.length;
}

/** Drops the next `count` update messages that instance `from` publishes. */
function dropUpdates(from: RunningInstance, count: number) {
  const bus = from.instance.bus;
  const original = bus.publish.bind(bus);
  let remaining = count;
  return vi.spyOn(bus, 'publish').mockImplementation(async (channel: string, message: BusMessage) => {
    if (message.kind === 'update' && remaining > 0) {
      remaining -= 1;
      return;
    }
    return original(channel, message);
  });
}

beforeEach(async () => {
  await freshDatabase();
  const clock = new FakeClock();
  a = await startInstance({ clock });
  b = await startInstance({ clock });
  owner = await registerUser(a.instance.app, 'Olive');
  const created = await owner.api.post(`/api/workspaces/${owner.personalWorkspaceId}/docs`, {
    title: 'Shared',
  });
  docId = created.body.doc.id;
  raw = new Redis(TEST_REDIS_URL);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await raw.quit();
  await stopInstances();
});

describe('two instances', () => {
  it('converge when editors on different instances type at once, with one row per update', async () => {
    const left = await TestClient.join(a.url, docId, { token: owner.token });
    const right = await TestClient.join(b.url, docId, { token: owner.token });
    const words = ['alpha ', 'beta ', 'gamma ', 'delta '];
    for (const word of words) {
      left.append(word);
      right.type(0, word.toUpperCase());
    }
    await left.waitFor(() => left.text.length === 2 * words.join('').length);
    await right.waitFor(() => right.text.toString() === left.text.toString());
    expect(await rowCount()).toBe(words.length * 2);
    expect(await storedText()).toBe(left.text.toString());
    await Promise.all([left.close(), right.close()]);
  });

  it('fills a lost update from the database on the next message', async () => {
    const left = await TestClient.join(a.url, docId, { token: owner.token });
    const right = await TestClient.join(b.url, docId, { token: owner.token });
    dropUpdates(a, 1);
    left.append('lost ');
    left.append('found');
    await right.waitForText('lost found');
    expect(b.instance.registry.get(docId)!.appliedSeq).toBe(2);
    await Promise.all([left.close(), right.close()]);
  });

  it('fills a lost update at the periodic catch-up', async () => {
    const left = await TestClient.join(a.url, docId, { token: owner.token });
    const right = await TestClient.join(b.url, docId, { token: owner.token });
    const observer = await TestClient.join(a.url, docId, { token: owner.token });
    dropUpdates(a, 1);
    left.append('quiet');
    await observer.waitForText('quiet');
    expect(right.text.toString()).toBe('');
    await b.instance.registry.catchUpStale();
    await right.waitForText('quiet');
    await Promise.all([left.close(), right.close(), observer.close()]);
  });

  it('applies reordered and duplicated bus messages once each', async () => {
    const reader = await TestClient.join(b.url, docId, { token: owner.token });
    const [first, second] = typedUpdates('one ', 'two');
    await a.instance.store.append({ docId, update: first, userId: owner.id });
    await a.instance.store.append({ docId, update: second, userId: owner.id });
    const message = (seq: number, update: Uint8Array) =>
      JSON.stringify({ kind: 'update', instanceId: 'elsewhere', seq, update: toBase64(update) });
    await raw.publish(docChannel(docId), message(2, second));
    await raw.publish(docChannel(docId), message(1, first));
    await raw.publish(docChannel(docId), message(2, second));
    await reader.waitForText('one two');
    expect(b.instance.registry.get(docId)!.appliedSeq).toBe(2);
    await reader.close();
  });

  it('ignores update messages carrying its own instance id', async () => {
    const reader = await TestClient.join(a.url, docId, { token: owner.token });
    const room = a.instance.registry.get(docId)!;
    const [update] = typedUpdates('ghost');
    await raw.publish(
      docChannel(docId),
      JSON.stringify({
        kind: 'update',
        instanceId: a.instance.bus.instanceId,
        seq: 5,
        update: toBase64(update),
      }),
    );
    await raw.publish(
      docChannel(docId),
      JSON.stringify({ kind: 'comments', instanceId: 'elsewhere' }),
    );
    await reader.waitForControl('comments_changed');
    expect(room.bufferedSeqs).toEqual([]);
    expect(room.appliedSeq).toBe(0);
    expect(reader.text.toString()).toBe('');
    await reader.close();
  });

  it('keeps editing and persisting while Redis publishing fails', async () => {
    const failing = vi
      .spyOn(a.instance.bus, 'publish')
      .mockRejectedValue(new Error('Connection is closed.'));
    const editor = await TestClient.join(a.url, docId, { token: owner.token });
    const local = await TestClient.join(a.url, docId, { token: owner.token });
    editor.append('offline bus');
    await local.waitForText('offline bus');
    expect(await rowCount()).toBe(1);
    expect(failing).toHaveBeenCalled();
    await Promise.all([editor.close(), local.close()]);
  });

  it('catches up every open room when the subscriber reconnects', async () => {
    const left = await TestClient.join(a.url, docId, { token: owner.token });
    const right = await TestClient.join(b.url, docId, { token: owner.token });
    const observer = await TestClient.join(a.url, docId, { token: owner.token });
    dropUpdates(a, 1);
    left.append('while away');
    await observer.waitForText('while away');
    const subscriber = b.instance.bus.subscriber;
    const reconnected = once(subscriber, 'ready');
    subscriber.disconnect(true);
    await reconnected;
    await right.waitForText('while away');
    await Promise.all([left.close(), right.close(), observer.close()]);
  });

  it('catches up from a snapshot newer than what the room has applied', async () => {
    const left = await TestClient.join(a.url, docId, { token: owner.token });
    const right = await TestClient.join(b.url, docId, { token: owner.token });
    const observer = await TestClient.join(a.url, docId, { token: owner.token });
    left.append('seen ');
    await right.waitForText('seen ');
    dropUpdates(a, 3);
    left.append('a');
    left.append('b');
    left.append('c');
    await observer.waitForText('seen abc');
    const compacted = await compactOnce(
      { db: a.instance.db, logger: createLogger('silent'), minUpdates: 1, minBytes: 1_000_000 },
      a.clock.now(),
    );
    expect(compacted).toBe(1);
    expect(b.instance.registry.get(docId)!.appliedSeq).toBe(1);
    await b.instance.registry.catchUpStale();
    await right.waitForText('seen abc');
    expect(b.instance.registry.get(docId)!.appliedSeq).toBe(4);
    await Promise.all([left.close(), right.close(), observer.close()]);
  });

  it('reopens an idle-closed room with content written through another instance', async () => {
    const reader = await TestClient.join(b.url, docId, { token: owner.token });
    const closed = connectionsClosed(b.instance);
    await reader.close();
    await closed;
    b.clock.advance(30_000);
    expect(await b.instance.registry.sweepIdle(b.clock.now())).toBe(1);

    const writer = await TestClient.join(a.url, docId, { token: owner.token });
    const local = await TestClient.join(a.url, docId, { token: owner.token });
    writer.append('written meanwhile');
    await local.waitForText('written meanwhile');

    const again = await TestClient.join(b.url, docId, { token: owner.token });
    await again.waitForText('written meanwhile');
    await Promise.all([writer.close(), local.close(), again.close()]);
  });

  it('closes sockets on every instance when the document is trashed', async () => {
    const left = await TestClient.join(a.url, docId, { token: owner.token });
    const right = await TestClient.join(b.url, docId, { token: owner.token });
    expect((await owner.api.post(`/api/docs/${docId}/trash`, {})).status).toBe(204);
    expect((await left.closed).code).toBe(4404);
    expect((await right.closed).code).toBe(4404);
  });

  it('tells every instance about a new title', async () => {
    const left = await TestClient.join(a.url, docId, { token: owner.token });
    const right = await TestClient.join(b.url, docId, { token: owner.token });
    await owner.api.patch(`/api/docs/${docId}`, { title: 'Renamed' });
    expect(await right.waitForControl('meta')).toEqual({ type: 'meta', title: 'Renamed' });
    expect(await left.waitForControl('meta')).toEqual({ type: 'meta', title: 'Renamed' });
    await Promise.all([left.close(), right.close()]);
  });
});
