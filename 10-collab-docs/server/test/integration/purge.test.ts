import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { DocStore } from '../../src/collab/docStore.js';
import { createDb } from '../../src/db/db.js';
import { addDays } from '../../src/lib/clock.js';
import { createLogger } from '../../src/lib/logger.js';
import { purgeSessionsOnce } from '../../src/worker/sessionPurge.js';
import { purgeTrashOnce } from '../../src/worker/trashPurge.js';
import { FakeClock, resetDb, TEST_DATABASE_URL } from '../helpers/env.js';
import { seedDoc, typedUpdates } from '../helpers/fixtures.js';

const db = createDb(TEST_DATABASE_URL, 4);
const clock = new FakeClock();
const options = { db, logger: createLogger('silent'), retentionDays: 30 };

beforeEach(async () => {
  await resetDb(db);
});

afterAll(async () => {
  await db.destroy();
});

async function trashAt(docId: string, userId: string, at: Date) {
  await db
    .updateTable('docs')
    .set({ trashed_at: at, trashed_by: userId })
    .where('id', '=', docId)
    .execute();
}

describe('trash purge', () => {
  it('deletes documents trashed more than 30 days ago with everything attached', async () => {
    const old = await seedDoc(db);
    const store = new DocStore(db, clock, 5_242_880);
    for (const update of typedUpdates('a', 'b')) {
      await store.append({ docId: old.docId, update, userId: old.userId });
    }
    await db
      .insertInto('doc_versions')
      .values({ doc_id: old.docId, seq: 2, state: Buffer.alloc(2), kind: 'named', label: 'v1' })
      .execute();
    const thread = await db
      .insertInto('comment_threads')
      .values({
        doc_id: old.docId,
        anchor_start: Buffer.alloc(1),
        anchor_end: Buffer.alloc(1),
        quoted_text: 'a',
        created_by: old.userId,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await db
      .insertInto('comments')
      .values({ thread_id: thread.id, author_id: old.userId, body: 'hi' })
      .execute();
    await db
      .insertInto('doc_links')
      .values({ doc_id: old.docId, token_hash: 'h', role: 'viewer', created_by: old.userId })
      .execute();
    await trashAt(old.docId, old.userId, addDays(clock.now(), -31));

    const recent = await seedDoc(db);
    await trashAt(recent.docId, recent.userId, addDays(clock.now(), -29));
    const kept = await seedDoc(db);

    expect(await purgeTrashOnce(options, clock.now())).toBe(1);
    const remaining = (await db.selectFrom('docs').select('id').execute()).map((row) => row.id);
    expect(remaining.sort()).toEqual([recent.docId, kept.docId].sort());
    for (const table of [
      'doc_updates',
      'doc_versions',
      'comment_threads',
      'comments',
      'doc_links',
    ] as const) {
      expect(await db.selectFrom(table).selectAll().execute()).toHaveLength(0);
    }
  });

  it('works through more than one batch', async () => {
    const seeded = [];
    for (let i = 0; i < 55; i += 1) seeded.push(await seedDoc(db));
    for (const { docId, userId } of seeded) await trashAt(docId, userId, addDays(clock.now(), -40));
    expect(await purgeTrashOnce(options, clock.now())).toBe(55);
    expect(await db.selectFrom('docs').selectAll().execute()).toHaveLength(0);
  });
});

describe('session purge', () => {
  it('deletes only expired sessions', async () => {
    const { userId } = await seedDoc(db);
    await db
      .insertInto('sessions')
      .values([
        { user_id: userId, token_hash: 'expired', expires_at: clock.now() },
        { user_id: userId, token_hash: 'live', expires_at: new Date(clock.now().getTime() + 1) },
      ])
      .execute();
    expect(await purgeSessionsOnce(db, clock.now())).toBe(1);
    const left = await db.selectFrom('sessions').select('token_hash').execute();
    expect(left).toEqual([{ token_hash: 'live' }]);
  });
});
