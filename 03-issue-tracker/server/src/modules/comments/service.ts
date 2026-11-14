import type { AppDeps } from '../../app.js';
import { buildPage, decodeCursor } from '../../lib/cursor.js';
import { forbidden, notFound } from '../../lib/errors.js';
import { assertCan, can } from '../../lib/permissions.js';
import type { TenantContext } from '../../plugins/tenant.js';
import { findIssueByNumber, touchIssue } from '../issues/repo.js';
import type { IssueRef } from '../issues/service.js';
import { projectArchived } from '../projects/service.js';
import {
  deleteComment as deleteCommentRow,
  findComment,
  insertComment,
  listCommentsPage,
  updateCommentBody,
  type CommentRow,
} from './repo.js';

type Deps = Pick<AppDeps, 'db' | 'clock'>;

export interface CommentView {
  id: string;
  body: string;
  author: { id: string; name: string };
  createdAt: string;
  editedAt: string | null;
}

function toComment(row: CommentRow): CommentView {
  return {
    id: row.id,
    body: row.body,
    author: { id: row.author_id, name: row.author_name },
    createdAt: row.created_at.toISOString(),
    editedAt: row.edited_at ? row.edited_at.toISOString() : null,
  };
}

async function requireIssue(deps: Deps, tenant: TenantContext, ref: IssueRef) {
  const issue = await findIssueByNumber(tenant.orgId, ref.projectKey, ref.number, deps.db);
  if (!issue) throw notFound();
  return issue;
}

async function requireComment(
  deps: Deps,
  tenant: TenantContext,
  issueId: string,
  commentId: string,
): Promise<CommentRow> {
  const comment = await findComment(tenant.orgId, issueId, commentId, deps.db);
  if (!comment) throw notFound();
  return comment;
}

async function loadComment(deps: Deps, tenant: TenantContext, issueId: string, id: string) {
  return toComment(await requireComment(deps, tenant, issueId, id));
}

export async function listComments(
  deps: Deps,
  tenant: TenantContext,
  ref: IssueRef,
  query: { limit?: number; cursor?: string },
) {
  const limit = query.limit ?? 25;
  const after = query.cursor ? decodeCursor(query.cursor, 'created') : null;
  const issue = await requireIssue(deps, tenant, ref);
  const rows = await listCommentsPage(tenant.orgId, issue.id, after, limit + 1, deps.db);
  const page = buildPage(rows, limit, (row) => ({
    s: 'created',
    v: row.created_cursor,
    id: row.id,
  }));
  return { items: page.rows.map(toComment), nextCursor: page.nextCursor };
}

export async function addComment(
  deps: Deps,
  tenant: TenantContext,
  ref: IssueRef,
  body: string,
): Promise<CommentView> {
  const issue = await requireIssue(deps, tenant, ref);
  assertCan(tenant.role, 'comment.create');
  if (issue.archived_at) throw projectArchived();
  const now = deps.clock.now();
  const id = await deps.db.transaction().execute(async (trx) => {
    const commentId = await insertComment(
      tenant.orgId,
      { issueId: issue.id, authorId: tenant.userId, body, now },
      trx,
    );
    await touchIssue(tenant.orgId, issue.id, now, trx);
    return commentId;
  });
  return loadComment(deps, tenant, issue.id, id);
}

/** Only the author may edit, whatever their role. */
export async function editComment(
  deps: Deps,
  tenant: TenantContext,
  ref: IssueRef,
  commentId: string,
  body: string,
): Promise<CommentView> {
  const issue = await requireIssue(deps, tenant, ref);
  const comment = await requireComment(deps, tenant, issue.id, commentId);
  if (comment.author_id !== tenant.userId || !can(tenant.role, 'comment.editOwn')) {
    throw forbidden();
  }
  if (issue.archived_at) throw projectArchived();
  const now = deps.clock.now();
  await deps.db.transaction().execute(async (trx) => {
    await updateCommentBody(tenant.orgId, issue.id, commentId, body, now, trx);
    await touchIssue(tenant.orgId, issue.id, now, trx);
  });
  return loadComment(deps, tenant, issue.id, commentId);
}

export async function deleteComment(
  deps: Deps,
  tenant: TenantContext,
  ref: IssueRef,
  commentId: string,
): Promise<void> {
  const issue = await requireIssue(deps, tenant, ref);
  const comment = await requireComment(deps, tenant, issue.id, commentId);
  const own = comment.author_id === tenant.userId && can(tenant.role, 'comment.deleteOwn');
  if (!own && !can(tenant.role, 'comment.deleteAny')) throw forbidden();
  if (issue.archived_at) throw projectArchived();
  const now = deps.clock.now();
  await deps.db.transaction().execute(async (trx) => {
    await deleteCommentRow(tenant.orgId, issue.id, commentId, trx);
    await touchIssue(tenant.orgId, issue.id, now, trx);
  });
}
