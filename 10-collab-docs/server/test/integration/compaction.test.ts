import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { contentOf, docFromLog } from '../../src/collab/docState.js';
import { DocStore } from '../../src/collab/docStore.js';
import { createDb } from '../../src/db/db.js';
import { createLogger } from '../../src/lib/logger.js';
import { compactOnce, type CompactionOptions } from '../../src/worker/compaction.js';
import { FakeClock, resetDb, TEST_DATABASE_URL } from '../helpers/env.js';
import { seedDoc, textOf, typedUpdates } from '../helpers/fixtures.js';

const db = createDb(TEST_DATABASE_URL, 8);
const clock = new FakeClock();
const store = new DocStore(db, clock, 5_242_880);
const options: CompactionOptions = {
  db,
  logger: createLogger('silent'),
  minUpdates: 3,
  minBytes: 1_048_576,
};

async function docRow(docId: string) {
  return db
    .selectFrom('docs')
    .select(['head_seq', 'snapshot_seq', 'log_bytes', 'snapshot_bytes'])
    .where('id', '=', docId)
    .executeTakeFirstOrThrow();
}

async function storedText(docId: string): Promise<string> {
  return contentOf(docFromLog(await store.load(docId))).toString();
}

async function appendAll(docId: string, userId: string, updates: Uint8Array[]) {
  for (const update of updates) {
    const result = await store.append({ docId, update, userId });
    expect(result.status).toBe('ok');
  }
}

beforeEach(async () => {
  await resetDb(db);
});

afterAll(async () => {
  await db.destroy();
});

describe('compaction', () => {
  it('replaces the log with a snapshot of the same state and keeps head_seq', async () => {
    const { docId, userId } = await seedDoc(db);
    const updates = typedUpdates('one ', 'two ', 'three ', 'four');
    await appendAll(docId, userId, updates);
    const before = await storedText(docId);

    expect(await compactOnce(options, clock.now())).toBe(1);

    const doc = await docRow(docId);
    expect(doc.head_seq).toBe(4);
    expect(doc.snapshot_seq).toBe(4);
    expect(doc.log_bytes).toBe(0);
    expect(doc.snapshot_bytes).toBeGreaterThan(0);
    expect(await db.selectFrom('doc_updates').selectAll().execute()).toHaveLength(0);
    const snapshots = await db.selectFrom('doc_snapshots').select('upto_seq').execute();
    expect(snapshots).toEqual([{ upto_seq: 4 }]);
    expect(await storedText(docId)).toBe(before);
    expect(before).toBe(textOf(updates));
  });

  it('builds on the previous snapshot and removes it', async () => {
    const { docId, userId } = await seedDoc(db);
    const updates = typedUpdates('a', 'b', 'c', 'd', 'e', 'f');
    await appendAll(docId, userId, updates.slice(0, 3));
    await compactOnce(options, clock.now());
    await appendAll(docId, userId, updates.slice(3));
    expect(await compactOnce(options, clock.now())).toBe(1);
    const snapshots = await db.selectFrom('doc_snapshots').select('upto_seq').execute();
    expect(snapshots).toEqual([{ upto_seq: 6 }]);
    expect(await storedText(docId)).toBe('abcdef');
  });

  it('leaves documents under the thresholds and trashed documents alone', async () => {
    const small = await seedDoc(db);
    await appendAll(small.docId, small.userId, typedUpdates('x', 'y'));
    const trashed = await seedDoc(db);
    await appendAll(trashed.docId, trashed.userId, typedUpdates('1', '2', '3', '4'));
    await db
      .updateTable('docs')
      .set({ trashed_at: clock.now(), trashed_by: trashed.userId })
      .where('id', '=', trashed.docId)
      .execute();
    expect(await compactOnce(options, clock.now())).toBe(0);
    expect((await docRow(small.docId)).snapshot_seq).toBe(0);
    expect((await docRow(trashed.docId)).snapshot_seq).toBe(0);
  });

  it('compacts on the byte threshold alone', async () => {
    const { docId, userId } = await seedDoc(db);
    await appendAll(docId, userId, typedUpdates('z'.repeat(400)));
    expect(await compactOnce({ ...options, minUpdates: 1_000, minBytes: 100 }, clock.now())).toBe(1);
    expect((await docRow(docId)).snapshot_seq).toBe(1);
  });

  it('keeps every update appended during compaction', async () => {
    const { docId, userId } = await seedDoc(db);
    const updates = typedUpdates(...Array.from({ length: 40 }, (_, i) => `w${i} `));
    await appendAll(docId, userId, updates.slice(0, 20));
    await Promise.all([
      compactOnce(options, clock.now()),
      (async () => {
        for (const update of updates.slice(20)) await store.append({ docId, update, userId });
      })(),
    ]);
    const doc = await docRow(docId);
    expect(doc.head_seq).toBe(40);
    expect(await storedText(docId)).toBe(textOf(updates));
    await compactOnce(options, clock.now());
    expect(await storedText(docId)).toBe(textOf(updates));
    expect((await docRow(docId)).head_seq).toBe(40);
  });

  it('loads the complete text while a compaction runs', async () => {
    const { docId, userId } = await seedDoc(db);
    const updates = typedUpdates(...Array.from({ length: 30 }, (_, i) => `${i},`));
    await appendAll(docId, userId, updates);
    const expected = textOf(updates);
    const loads = await Promise.all([
      store.load(docId),
      compactOnce(options, clock.now()).then(() => null),
      store.load(docId),
      store.load(docId),
    ]);
    for (const log of loads) {
      if (log === null) continue;
      expect(contentOf(docFromLog(log)).toString()).toBe(expected);
    }
  });

  it('compacts each document once when two workers run together', async () => {
    const seeded = await Promise.all([seedDoc(db), seedDoc(db), seedDoc(db), seedDoc(db)]);
    for (const { docId, userId } of seeded) {
      await appendAll(docId, userId, typedUpdates('p', 'q', 'r', 's'));
    }
    const [first, second] = await Promise.all([
      compactOnce(options, clock.now()),
      compactOnce(options, clock.now()),
    ]);
    expect(first + second).toBe(4);
    const snapshots = await db.selectFrom('doc_snapshots').select(['doc_id', 'upto_seq']).execute();
    expect(snapshots).toHaveLength(4);
    for (const { docId } of seeded) expect(await storedText(docId)).toBe('pqrs');
  });
});
