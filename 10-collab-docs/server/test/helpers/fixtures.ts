import * as Y from 'yjs';
import type { Db } from '../../src/db/db.js';

export interface SeededDoc {
  userId: string;
  workspaceId: string;
  docId: string;
}

let counter = 0;

/** Inserts a user, a workspace they own and a document they own, directly in the database. */
export async function seedDoc(db: Db, title = 'Fixture'): Promise<SeededDoc> {
  counter += 1;
  const user = await db
    .insertInto('users')
    .values({ email: `fixture${counter}@example.com`, name: `Fixture ${counter}`, password_hash: 'x' })
    .returning('id')
    .executeTakeFirstOrThrow();
  const workspace = await db
    .insertInto('workspaces')
    .values({ name: `Workspace ${counter}` })
    .returning('id')
    .executeTakeFirstOrThrow();
  await db
    .insertInto('workspace_members')
    .values({ workspace_id: workspace.id, user_id: user.id, role: 'owner' })
    .execute();
  const doc = await db
    .insertInto('docs')
    .values({ workspace_id: workspace.id, owner_id: user.id, title })
    .returning('id')
    .executeTakeFirstOrThrow();
  return { userId: user.id, workspaceId: workspace.id, docId: doc.id };
}

/** Produces a chain of updates that type the given strings one after another into `content`. */
export function typedUpdates(...chunks: string[]): Uint8Array[] {
  const doc = new Y.Doc();
  const text = doc.getText('content');
  const updates: Uint8Array[] = [];
  doc.on('update', (update: Uint8Array) => updates.push(update));
  for (const chunk of chunks) text.insert(text.length, chunk);
  doc.destroy();
  return updates;
}

/** Returns the text a list of updates produces. */
export function textOf(updates: Uint8Array[]): string {
  const doc = new Y.Doc();
  for (const update of updates) Y.applyUpdate(doc, update);
  const text = doc.getText('content').toString();
  doc.destroy();
  return text;
}
