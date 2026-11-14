import type { Database } from '../../db/index.js';
import { isoMicros, keysetAfter, timestampValue } from '../../db/sql.js';
import type { Cursor } from '../../lib/cursor.js';

export interface CommentRow {
  id: string;
  issue_id: string;
  body: string;
  author_id: string;
  author_name: string;
  created_at: Date;
  edited_at: Date | null;
  created_cursor: string;
}

function commentQuery(orgId: string, db: Database) {
  return db
    .selectFrom('comments as c')
    .innerJoin('users as u', 'u.id', 'c.author_id')
    .select([
      'c.id',
      'c.issue_id',
      'c.body',
      'c.author_id',
      'u.name as author_name',
      'c.created_at',
      'c.edited_at',
      isoMicros('c.created_at').as('created_cursor'),
    ])
    .where('c.org_id', '=', orgId);
}

/** Oldest first, starting strictly after `after`. */
export async function listCommentsPage(
  orgId: string,
  issueId: string,
  after: Cursor | null,
  take: number,
  db: Database,
): Promise<CommentRow[]> {
  let query = commentQuery(orgId, db).where('c.issue_id', '=', issueId);
  if (after) {
    query = query.where(
      keysetAfter('c.created_at', 'c.id', 'asc', timestampValue(after.v), after.id),
    );
  }
  return query.orderBy('c.created_at', 'asc').orderBy('c.id', 'asc').limit(take).execute();
}

export async function findComment(
  orgId: string,
  commentId: string,
  db: Database,
): Promise<CommentRow | undefined> {
  return commentQuery(orgId, db).where('c.id', '=', commentId).executeTakeFirst();
}

export async function insertComment(
  orgId: string,
  values: { issueId: string; authorId: string; body: string; now: Date },
  db: Database,
): Promise<string> {
  const row = await db
    .insertInto('comments')
    .values({
      org_id: orgId,
      issue_id: values.issueId,
      author_id: values.authorId,
      body: values.body,
      created_at: values.now,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

export async function updateCommentBody(
  orgId: string,
  issueId: string,
  commentId: string,
  body: string,
  now: Date,
  db: Database,
): Promise<void> {
  await db
    .updateTable('comments')
    .set({ body, edited_at: now })
    .where('org_id', '=', orgId)
    .where('issue_id', '=', issueId)
    .where('id', '=', commentId)
    .execute();
}

export async function deleteComment(
  orgId: string,
  issueId: string,
  commentId: string,
  db: Database,
): Promise<void> {
  await db
    .deleteFrom('comments')
    .where('org_id', '=', orgId)
    .where('issue_id', '=', issueId)
    .where('id', '=', commentId)
    .execute();
}
