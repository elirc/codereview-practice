import type * as Y from 'yjs';
import { contentOf, docFromLog } from '../collab/docState.js';
import { readDocLog } from '../collab/docStore.js';
import { readSnapshot, toBytea } from '../db/db.js';
import { decodeAnchor, quoteOf, resolveAnchor, threadRange } from '../domain/anchors.js';
import { canComment, canResolveThread, type DocRole } from '../domain/roles.js';
import { errors } from '../http/errors.js';
import { requireDocAccess, type Principal, type UserPrincipal } from './access.js';
import type { ServiceContext } from './context.js';

export interface CommentView {
  id: string;
  threadId: string;
  authorId: string;
  authorName: string;
  body: string;
  createdAt: Date;
  editedAt: Date | null;
  deletedAt: Date | null;
}

export interface ThreadView {
  id: string;
  docId: string;
  quotedText: string;
  status: 'open' | 'resolved';
  range: { start: number; end: number };
  detached: boolean;
  createdBy: string;
  resolvedBy: string | null;
  resolvedAt: Date | null;
  createdAt: Date;
  comments: CommentView[];
}

export interface NewThread {
  anchor: { start: Uint8Array; end: Uint8Array };
  body: string;
}

/** Runs `fn` with the document's current state: the open room's, or one loaded from the database. */
async function withCurrentDoc<T>(
  ctx: ServiceContext,
  docId: string,
  fn: (doc: Y.Doc) => T,
): Promise<T> {
  const open = ctx.live.openDoc(docId);
  if (open) return fn(open);
  const log = await readSnapshot(ctx.db, (trx) => readDocLog(trx, docId));
  const doc = docFromLog(log);
  try {
    return fn(doc);
  } finally {
    doc.destroy();
  }
}

async function commentsFor(ctx: ServiceContext, threadIds: string[]): Promise<Map<string, CommentView[]>> {
  const byThread = new Map<string, CommentView[]>();
  if (threadIds.length === 0) return byThread;
  const rows = await ctx.db
    .selectFrom('comments')
    .innerJoin('users', 'users.id', 'comments.author_id')
    .select([
      'comments.id',
      'comments.thread_id',
      'comments.author_id',
      'users.name as author_name',
      'comments.body',
      'comments.created_at',
      'comments.edited_at',
      'comments.deleted_at',
    ])
    .where('comments.thread_id', 'in', threadIds)
    .orderBy('comments.created_at')
    .orderBy('comments.id')
    .execute();
  for (const row of rows) {
    const list = byThread.get(row.thread_id) ?? [];
    list.push({
      id: row.id,
      threadId: row.thread_id,
      authorId: row.author_id,
      authorName: row.author_name,
      body: row.body,
      createdAt: row.created_at,
      editedAt: row.edited_at,
      deletedAt: row.deleted_at,
    });
    byThread.set(row.thread_id, list);
  }
  return byThread;
}

/** Lists a document's threads with their current ranges. */
export async function listThreads(
  ctx: ServiceContext,
  docId: string,
  principal: Principal,
): Promise<ThreadView[]> {
  await requireDocAccess(ctx.db, docId, principal, ctx.clock.now());
  const threads = await ctx.db
    .selectFrom('comment_threads')
    .selectAll()
    .where('doc_id', '=', docId)
    .orderBy('created_at')
    .orderBy('id')
    .execute();
  const comments = await commentsFor(
    ctx,
    threads.map((thread) => thread.id),
  );
  const ranges = await withCurrentDoc(ctx, docId, (doc) => {
    const text = contentOf(doc);
    return threads.map((thread) => threadRange(doc, text, thread.anchor_start, thread.anchor_end));
  });
  return threads.map((thread, index) => ({
    id: thread.id,
    docId: thread.doc_id,
    quotedText: thread.quoted_text,
    status: thread.status,
    range: ranges[index].range,
    detached: ranges[index].detached,
    createdBy: thread.created_by,
    resolvedBy: thread.resolved_by,
    resolvedAt: thread.resolved_at,
    createdAt: thread.created_at,
    comments: comments.get(thread.id) ?? [],
  }));
}

/** Creates a thread on a range of the current text with its first comment. */
export async function createThread(
  ctx: ServiceContext,
  docId: string,
  principal: UserPrincipal,
  input: NewThread,
): Promise<ThreadView> {
  const now = ctx.clock.now();
  await requireDocAccess(ctx.db, docId, principal, now, { min: 'commenter' });
  try {
    decodeAnchor(input.anchor.start);
    decodeAnchor(input.anchor.end);
  } catch {
    throw errors.validation([{ path: 'anchor', message: 'Not an encoded relative position' }]);
  }

  const resolved = await withCurrentDoc(ctx, docId, (doc) => {
    const text = contentOf(doc);
    const result = resolveAnchor(doc, text, input.anchor.start, input.anchor.end);
    if (result.kind === 'unknown') throw errors.anchorUnknown();
    if (result.kind === 'foreign' || result.start >= result.end) throw errors.emptyAnchor();
    return { ...result, quote: quoteOf(text.toString(), result.start, result.end) };
  });

  const created = await ctx.db.transaction().execute(async (trx) => {
    const thread = await trx
      .insertInto('comment_threads')
      .values({
        doc_id: docId,
        anchor_start: toBytea(input.anchor.start),
        anchor_end: toBytea(input.anchor.end),
        quoted_text: resolved.quote,
        created_by: principal.userId,
        created_at: now,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    const comment = await trx
      .insertInto('comments')
      .values({ thread_id: thread.id, author_id: principal.userId, body: input.body, created_at: now })
      .returningAll()
      .executeTakeFirstOrThrow();
    const author = await trx
      .selectFrom('users')
      .select('name')
      .where('id', '=', principal.userId)
      .executeTakeFirstOrThrow();
    return { thread, comment, authorName: author.name };
  });
  ctx.notifier.doc(docId, { kind: 'comments' });

  const { thread, comment } = created;
  return {
    id: thread.id,
    docId,
    quotedText: thread.quoted_text,
    status: thread.status,
    range: { start: resolved.start, end: resolved.end },
    detached: false,
    createdBy: thread.created_by,
    resolvedBy: null,
    resolvedAt: null,
    createdAt: thread.created_at,
    comments: [
      {
        id: comment.id,
        threadId: thread.id,
        authorId: comment.author_id,
        authorName: created.authorName,
        body: comment.body,
        createdAt: comment.created_at,
        editedAt: null,
        deletedAt: null,
      },
    ],
  };
}

interface ThreadAccess {
  threadId: string;
  docId: string;
  createdBy: string;
  status: 'open' | 'resolved';
  role: DocRole;
}

async function requireThread(
  ctx: ServiceContext,
  threadId: string,
  principal: Principal,
  now: Date,
): Promise<ThreadAccess> {
  const thread = await ctx.db
    .selectFrom('comment_threads')
    .select(['id', 'doc_id', 'created_by', 'status'])
    .where('id', '=', threadId)
    .executeTakeFirst();
  if (!thread) throw errors.notFound('Thread not found.');
  const access = await requireDocAccess(ctx.db, thread.doc_id, principal, now).catch(() => {
    throw errors.notFound('Thread not found.');
  });
  return {
    threadId: thread.id,
    docId: thread.doc_id,
    createdBy: thread.created_by,
    status: thread.status,
    role: access.role,
  };
}

/** Adds a reply to a thread, reopening it if it was resolved. */
export async function reply(
  ctx: ServiceContext,
  threadId: string,
  principal: UserPrincipal,
  input: { body: string },
): Promise<CommentView> {
  const now = ctx.clock.now();
  const thread = await requireThread(ctx, threadId, principal, now);
  if (!canComment(thread.role)) throw errors.forbidden();
  const comment = await ctx.db.transaction().execute(async (trx) => {
    const row = await trx
      .insertInto('comments')
      .values({ thread_id: threadId, author_id: principal.userId, body: input.body, created_at: now })
      .returningAll()
      .executeTakeFirstOrThrow();
    await trx
      .updateTable('comment_threads')
      .set({ status: 'open', resolved_by: null, resolved_at: null })
      .where('id', '=', threadId)
      .where('status', '=', 'resolved')
      .execute();
    const author = await trx
      .selectFrom('users')
      .select('name')
      .where('id', '=', principal.userId)
      .executeTakeFirstOrThrow();
    return {
      id: row.id,
      threadId,
      authorId: row.author_id,
      authorName: author.name,
      body: row.body,
      createdAt: row.created_at,
      editedAt: null,
      deletedAt: null,
    };
  });
  ctx.notifier.doc(thread.docId, { kind: 'comments' });
  return comment;
}

async function requireOwnComment(
  ctx: ServiceContext,
  commentId: string,
  principal: UserPrincipal,
  now: Date,
): Promise<{ docId: string; deletedAt: Date | null }> {
  const comment = await ctx.db
    .selectFrom('comments')
    .select(['thread_id', 'author_id', 'deleted_at'])
    .where('id', '=', commentId)
    .executeTakeFirst();
  if (!comment) throw errors.notFound('Comment not found.');
  const thread = await requireThread(ctx, comment.thread_id, principal, now).catch(() => {
    throw errors.notFound('Comment not found.');
  });
  if (!canComment(thread.role) || comment.author_id !== principal.userId) throw errors.forbidden();
  return { docId: thread.docId, deletedAt: comment.deleted_at };
}

/** Changes the body of the caller's own comment. */
export async function editComment(
  ctx: ServiceContext,
  commentId: string,
  principal: UserPrincipal,
  input: { body: string },
): Promise<void> {
  const now = ctx.clock.now();
  const comment = await requireOwnComment(ctx, commentId, principal, now);
  if (comment.deletedAt !== null) throw errors.invalidState('The comment was deleted.');
  await ctx.db
    .updateTable('comments')
    .set({ body: input.body, edited_at: now })
    .where('id', '=', commentId)
    .where('deleted_at', 'is', null)
    .execute();
  ctx.notifier.doc(comment.docId, { kind: 'comments' });
}

/** Deletes the caller's own comment, keeping its row with a blank body. */
export async function deleteComment(
  ctx: ServiceContext,
  commentId: string,
  principal: UserPrincipal,
): Promise<void> {
  const now = ctx.clock.now();
  const comment = await requireOwnComment(ctx, commentId, principal, now);
  if (comment.deletedAt !== null) throw errors.invalidState('The comment was already deleted.');
  await ctx.db
    .updateTable('comments')
    .set({ body: '', deleted_at: now })
    .where('id', '=', commentId)
    .where('deleted_at', 'is', null)
    .execute();
  ctx.notifier.doc(comment.docId, { kind: 'comments' });
}

/** Marks a thread resolved or open again. */
export async function setThreadStatus(
  ctx: ServiceContext,
  threadId: string,
  principal: UserPrincipal,
  status: 'open' | 'resolved',
): Promise<void> {
  const now = ctx.clock.now();
  const thread = await requireThread(ctx, threadId, principal, now);
  if (!canResolveThread(thread.role, thread.createdBy === principal.userId)) throw errors.forbidden();
  const updated = await ctx.db
    .updateTable('comment_threads')
    .set(
      status === 'resolved'
        ? { status, resolved_by: principal.userId, resolved_at: now }
        : { status, resolved_by: null, resolved_at: null },
    )
    .where('id', '=', threadId)
    .where('status', '=', status === 'resolved' ? 'open' : 'resolved')
    .executeTakeFirst();
  if (updated.numUpdatedRows === 0n) {
    throw errors.invalidState(
      status === 'resolved' ? 'The thread is already resolved.' : 'The thread is already open.',
    );
  }
  ctx.notifier.doc(thread.docId, { kind: 'comments' });
}
