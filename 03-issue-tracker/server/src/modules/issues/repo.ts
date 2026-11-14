import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import type { IssueStatus } from '../../db/types.js';
import type { LabelRow } from '../labels/repo.js';

export interface IssueRow {
  id: string;
  project_id: string;
  project_key: string;
  archived_at: Date | null;
  number: number;
  title: string;
  description: string;
  status: IssueStatus;
  priority: number;
  assignee_id: string | null;
  version: number;
}

export interface IssueDetailRow extends IssueRow {
  reporter_id: string;
  reporter_name: string;
  assignee_name: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface IssueChanges {
  title?: string;
  description?: string;
  status?: IssueStatus;
  priority?: number;
  assignee_id?: string | null;
  project_id?: string;
  number?: number;
}

function issueWithProject(orgId: string, db: Database) {
  return db
    .selectFrom('issues as i')
    .innerJoin('projects as p', (join) =>
      join.onRef('p.org_id', '=', 'i.org_id').onRef('p.id', '=', 'i.project_id'),
    )
    .select([
      'i.id',
      'i.project_id',
      'p.key as project_key',
      'p.archived_at',
      'i.number',
      'i.title',
      'i.description',
      'i.status',
      'i.priority',
      'i.assignee_id',
      'i.version',
    ])
    .where('i.org_id', '=', orgId);
}

export async function findIssueByNumber(
  orgId: string,
  projectKey: string,
  number: number,
  db: Database,
): Promise<IssueRow | undefined> {
  return issueWithProject(orgId, db)
    .where('p.key', '=', projectKey)
    .where('i.number', '=', number)
    .executeTakeFirst();
}

export async function findIssueDetail(
  orgId: string,
  issueId: string,
  db: Database,
): Promise<IssueDetailRow | undefined> {
  return issueWithProject(orgId, db)
    .innerJoin('users as r', 'r.id', 'i.reporter_id')
    .leftJoin('users as a', 'a.id', 'i.assignee_id')
    .select([
      'i.reporter_id',
      'r.name as reporter_name',
      'a.name as assignee_name',
      'i.created_at',
      'i.updated_at',
    ])
    .where('i.id', '=', issueId)
    .executeTakeFirst();
}

/** Labels for each of the given issues, keyed by issue id, alphabetical within an issue. */
export async function findLabelsForIssues(
  orgId: string,
  issueIds: string[],
  db: Database,
): Promise<Map<string, LabelRow[]>> {
  const byIssue = new Map<string, LabelRow[]>();
  if (issueIds.length === 0) return byIssue;
  const rows = await db
    .selectFrom('issue_labels as il')
    .innerJoin('labels as l', (join) =>
      join.onRef('l.org_id', '=', 'il.org_id').onRef('l.id', '=', 'il.label_id'),
    )
    .select(['il.issue_id', 'l.id', 'l.name', 'l.color'])
    .where('il.org_id', '=', orgId)
    .where('il.issue_id', 'in', issueIds)
    .orderBy(sql`lower(l.name)`)
    .orderBy('l.id')
    .execute();
  for (const row of rows) {
    const labels = byIssue.get(row.issue_id) ?? [];
    labels.push({ id: row.id, name: row.name, color: row.color });
    byIssue.set(row.issue_id, labels);
  }
  return byIssue;
}

export async function listIssueLabelIds(
  orgId: string,
  issueId: string,
  db: Database,
): Promise<string[]> {
  const rows = await db
    .selectFrom('issue_labels')
    .select('label_id')
    .where('org_id', '=', orgId)
    .where('issue_id', '=', issueId)
    .execute();
  return rows.map((row) => row.label_id);
}

/** Takes the next number from the project; undefined when the project is archived. */
export async function allocateIssueNumber(
  orgId: string,
  projectId: string,
  db: Database,
): Promise<number | undefined> {
  const row = await db
    .updateTable('projects')
    .set({ next_issue_number: sql<number>`next_issue_number + 1` })
    .where('org_id', '=', orgId)
    .where('id', '=', projectId)
    .where('archived_at', 'is', null)
    .returning(sql<number>`next_issue_number - 1`.as('number'))
    .executeTakeFirst();
  return row?.number;
}

export async function insertIssue(
  orgId: string,
  values: {
    projectId: string;
    number: number;
    title: string;
    description: string;
    status: IssueStatus;
    priority: number;
    assigneeId: string | null;
    reporterId: string;
    now: Date;
  },
  db: Database,
): Promise<string> {
  const row = await db
    .insertInto('issues')
    .values({
      org_id: orgId,
      project_id: values.projectId,
      number: values.number,
      title: values.title,
      description: values.description,
      status: values.status,
      priority: values.priority,
      assignee_id: values.assigneeId,
      reporter_id: values.reporterId,
      created_at: values.now,
      updated_at: values.now,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

/** Applies `changes` only if the stored version still equals `version`. */
export async function updateIssueIfVersion(
  orgId: string,
  issueId: string,
  version: number,
  changes: IssueChanges,
  now: Date,
  db: Database,
): Promise<boolean> {
  const row = await db
    .updateTable('issues')
    .set({ ...changes, version: sql<number>`version + 1`, updated_at: now })
    .where('org_id', '=', orgId)
    .where('id', '=', issueId)
    .where('version', '=', version)
    .returning('id')
    .executeTakeFirst();
  return row !== undefined;
}

export async function replaceIssueLabels(
  orgId: string,
  issueId: string,
  labelIds: string[],
  db: Database,
): Promise<void> {
  await db
    .deleteFrom('issue_labels')
    .where('org_id', '=', orgId)
    .where('issue_id', '=', issueId)
    .execute();
  if (labelIds.length > 0) {
    await db
      .insertInto('issue_labels')
      .values(labelIds.map((labelId) => ({ org_id: orgId, issue_id: issueId, label_id: labelId })))
      .execute();
  }
}

export async function deleteIssue(orgId: string, issueId: string, db: Database): Promise<void> {
  await db.deleteFrom('issues').where('org_id', '=', orgId).where('id', '=', issueId).execute();
}
