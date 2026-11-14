import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb } from '../../src/db/db.js';
import { resetDb, TEST_DATABASE_URL } from '../helpers/env.js';

const db = createDb(TEST_DATABASE_URL, 2);

async function seedWorkspace() {
  const owner = await db
    .insertInto('users')
    .values({ email: 'owner@example.com', name: 'Owner', password_hash: 'x' })
    .returning('id')
    .executeTakeFirstOrThrow();
  const other = await db
    .insertInto('users')
    .values({ email: 'other@example.com', name: 'Other', password_hash: 'x' })
    .returning('id')
    .executeTakeFirstOrThrow();
  const workspace = await db
    .insertInto('workspaces')
    .values({ name: 'Team' })
    .returning('id')
    .executeTakeFirstOrThrow();
  await db
    .insertInto('workspace_members')
    .values({ workspace_id: workspace.id, user_id: owner.id, role: 'owner' })
    .execute();
  return { ownerId: owner.id, otherId: other.id, workspaceId: workspace.id };
}

beforeEach(async () => {
  await resetDb(db);
});

afterAll(async () => {
  await db.destroy();
});

describe('schema constraints', () => {
  it('allows only one owner per workspace', async () => {
    const { otherId, workspaceId } = await seedWorkspace();
    await expect(
      db
        .insertInto('workspace_members')
        .values({ workspace_id: workspaceId, user_id: otherId, role: 'owner' })
        .execute(),
    ).rejects.toThrow(/workspace_members_one_owner/);
  });

  it('requires a document owner to be a workspace member', async () => {
    const { otherId, workspaceId } = await seedWorkspace();
    await expect(
      db
        .insertInto('docs')
        .values({ workspace_id: workspaceId, owner_id: otherId, title: 'Notes' })
        .execute(),
    ).rejects.toThrow(/docs_owner_is_member/);
  });

  it('keeps head_seq at or above snapshot_seq', async () => {
    const { ownerId, workspaceId } = await seedWorkspace();
    const doc = await db
      .insertInto('docs')
      .values({ workspace_id: workspaceId, owner_id: ownerId, title: 'Notes' })
      .returning('id')
      .executeTakeFirstOrThrow();
    await expect(
      db.updateTable('docs').set({ snapshot_seq: 1 }).where('id', '=', doc.id).execute(),
    ).rejects.toThrow(/docs_seq_order/);
  });

  it('bounds the size of a stored update and requires a positive seq', async () => {
    const { ownerId, workspaceId } = await seedWorkspace();
    const doc = await db
      .insertInto('docs')
      .values({ workspace_id: workspaceId, owner_id: ownerId, title: 'Notes' })
      .returning('id')
      .executeTakeFirstOrThrow();
    await expect(
      db
        .insertInto('doc_updates')
        .values({ doc_id: doc.id, seq: 1, update: Buffer.alloc(262_145), user_id: ownerId })
        .execute(),
    ).rejects.toThrow(/doc_updates_size/);
    await expect(
      db
        .insertInto('doc_updates')
        .values({ doc_id: doc.id, seq: 0, update: Buffer.alloc(4), user_id: ownerId })
        .execute(),
    ).rejects.toThrow(/doc_updates_seq_positive/);
  });

  it('allows one automatic version per seq but any number of named ones', async () => {
    const { ownerId, workspaceId } = await seedWorkspace();
    const doc = await db
      .insertInto('docs')
      .values({ workspace_id: workspaceId, owner_id: ownerId, title: 'Notes' })
      .returning('id')
      .executeTakeFirstOrThrow();
    const version = { doc_id: doc.id, seq: 3, state: Buffer.alloc(2) };
    await db
      .insertInto('doc_versions')
      .values([
        { ...version, kind: 'named', label: 'One' },
        { ...version, kind: 'named', label: 'Two' },
        { ...version, kind: 'auto' },
      ])
      .execute();
    await expect(
      db
        .insertInto('doc_versions')
        .values({ ...version, kind: 'auto' })
        .execute(),
    ).rejects.toThrow(/doc_versions_auto_seq_key/);
  });
});
