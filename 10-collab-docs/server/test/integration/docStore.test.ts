import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { contentOf, docFromLog } from '../../src/collab/docState.js';
import { DocStore } from '../../src/collab/docStore.js';
import { createDb, toBytea } from '../../src/db/db.js';
import { FakeClock, resetDb, TEST_DATABASE_URL } from '../helpers/env.js';
import { seedDoc, textOf, typedUpdates } from '../helpers/fixtures.js';

const db = createDb(TEST_DATABASE_URL, 4);
const clock = new FakeClock();

beforeEach(async () => {
  await resetDb(db);
});

afterAll(async () => {
  await db.destroy();
});

async function docRow(docId: string) {
  return db
    .selectFrom('docs')
    .select(['head_seq', 'snapshot_seq', 'log_bytes'])
    .where('id', '=', docId)
    .executeTakeFirstOrThrow();
}

describe('DocStore.append', () => {
  it('stores each update as one row with consecutive seqs and counts its bytes', async () => {
    const { docId, userId } = await seedDoc(db);
    const store = new DocStore(db, clock, 5_242_880);
    const updates = typedUpdates('hello', ' world');
    const results = [];
    for (const update of updates) results.push(await store.append({ docId, update, userId }));
    expect(results).toEqual([
      { status: 'ok', seq: 1 },
      { status: 'ok', seq: 2 },
    ]);
    const rows = await db.selectFrom('doc_updates').select(['seq', 'user_id']).execute();
    expect(rows).toEqual([
      { seq: 1, user_id: userId },
      { seq: 2, user_id: userId },
    ]);
    const doc = await docRow(docId);
    expect(doc.head_seq).toBe(2);
    expect(doc.log_bytes).toBe(updates[0].byteLength + updates[1].byteLength);
  });

  it('assigns seqs 1 to n to appends made in parallel', async () => {
    const { docId, userId } = await seedDoc(db);
    const store = new DocStore(db, clock, 5_242_880);
    const updates = typedUpdates('a', 'b', 'c', 'd', 'e', 'f');
    const results = await Promise.all(updates.map((update) => store.append({ docId, update, userId })));
    const seqs = results.map((result) => (result.status === 'ok' ? result.seq : -1)).sort();
    expect(seqs).toEqual([1, 2, 3, 4, 5, 6]);
    expect((await docRow(docId)).head_seq).toBe(6);
  });

  it('refuses trashed and unknown documents without changing anything', async () => {
    const { docId, userId } = await seedDoc(db);
    await db
      .updateTable('docs')
      .set({ trashed_at: clock.now(), trashed_by: userId })
      .where('id', '=', docId)
      .execute();
    const store = new DocStore(db, clock, 5_242_880);
    const [update] = typedUpdates('x');
    expect(await store.append({ docId, update, userId })).toEqual({ status: 'missing' });
    expect(
      await store.append({ docId: '00000000-0000-4000-8000-000000000000', update, userId }),
    ).toEqual({ status: 'missing' });
    expect((await docRow(docId)).head_seq).toBe(0);
  });

  it('rolls back when the authorizer refuses and passes it both epochs', async () => {
    const { docId, userId } = await seedDoc(db);
    await db.updateTable('docs').set({ perm_epoch: 3 }).where('id', '=', docId).execute();
    const store = new DocStore(db, clock, 5_242_880);
    const [update] = typedUpdates('x');
    const seen: unknown[] = [];
    const result = await store.append({
      docId,
      update,
      userId,
      authorize: async (_trx, epochs) => {
        seen.push(epochs);
        return false;
      },
    });
    expect(result).toEqual({ status: 'forbidden' });
    expect(seen).toEqual([{ docEpoch: 3, workspaceEpoch: 0 }]);
    expect((await docRow(docId)).head_seq).toBe(0);
    expect(await db.selectFrom('doc_updates').selectAll().execute()).toHaveLength(0);
  });

  it('refuses an update that takes the document past its size limit', async () => {
    const { docId, userId } = await seedDoc(db);
    const [first, second] = typedUpdates('a'.repeat(50), 'b'.repeat(50));
    const store = new DocStore(db, clock, first.byteLength + second.byteLength - 1);
    expect((await store.append({ docId, update: first, userId })).status).toBe('ok');
    expect(await store.append({ docId, update: second, userId })).toEqual({ status: 'too_large' });
    const doc = await docRow(docId);
    expect(doc.head_seq).toBe(1);
    expect(doc.log_bytes).toBe(first.byteLength);
  });
});

describe('DocStore reads', () => {
  it('loads the newest snapshot and the updates after it', async () => {
    const { docId, userId } = await seedDoc(db);
    const updates = typedUpdates('one ', 'two ', 'three');
    const store = new DocStore(db, clock, 5_242_880);
    for (const update of updates) await store.append({ docId, update, userId });

    const snapshotDoc = new Y.Doc();
    Y.applyUpdate(snapshotDoc, updates[0]);
    Y.applyUpdate(snapshotDoc, updates[1]);
    await db
      .insertInto('doc_snapshots')
      .values({ doc_id: docId, upto_seq: 2, state: toBytea(Y.encodeStateAsUpdate(snapshotDoc)) })
      .execute();
    await db.deleteFrom('doc_updates').where('seq', '<=', 2).execute();
    await db.updateTable('docs').set({ snapshot_seq: 2 }).where('id', '=', docId).execute();

    const log = await store.load(docId);
    expect(log.snapshot?.uptoSeq).toBe(2);
    expect(log.updates.map((u) => u.seq)).toEqual([3]);
    expect(contentOf(docFromLog(log)).toString()).toBe(textOf(updates));

    const behind = await store.readSince(docId, 1);
    expect(behind.snapshot?.uptoSeq).toBe(2);
    expect(behind.updates.map((u) => u.seq)).toEqual([3]);

    const current = await store.readSince(docId, 2);
    expect(current.snapshot).toBeNull();
    expect(current.updates.map((u) => u.seq)).toEqual([3]);

    const head = await store.loadAtHead(docId);
    expect(head?.headSeq).toBe(3);
  });
});
