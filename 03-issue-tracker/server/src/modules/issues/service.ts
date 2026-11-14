import type { AppDeps } from '../../app.js';
import type { Database } from '../../db/index.js';
import type { IssueStatus } from '../../db/types.js';
import { conflict, invalidReference, notFound } from '../../lib/errors.js';
import { formatIdentifier } from '../../lib/identifier.js';
import { assertCan } from '../../lib/permissions.js';
import type { TenantContext } from '../../plugins/tenant.js';
import { lockLabelIds, type LabelRow } from '../labels/repo.js';
import { lockAssignableMember } from '../members/repo.js';
import { findProjectByKey } from '../projects/repo.js';
import { projectArchived } from '../projects/service.js';
import {
  allocateIssueNumber,
  deleteIssue as deleteIssueRow,
  findIssueByNumber,
  findIssueDetail,
  findLabelsForIssues,
  insertIssue,
  listIssueLabelIds,
  replaceIssueLabels,
  updateIssueIfVersion,
  type IssueChanges,
  type IssueDetailRow,
  type IssueRow,
} from './repo.js';

type Deps = Pick<AppDeps, 'db' | 'clock'>;

export interface IssueRef {
  projectKey: string;
  number: number;
}

export interface UserSummaryView {
  id: string;
  name: string;
}

export interface IssueSummaryView {
  id: string;
  identifier: string;
  projectKey: string;
  number: number;
  title: string;
  status: IssueStatus;
  priority: number;
  assignee: UserSummaryView | null;
  labels: LabelRow[];
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface IssueDetailView extends IssueSummaryView {
  description: string;
  reporter: UserSummaryView;
}

export interface CreateIssueInput {
  title: string;
  description?: string;
  status?: IssueStatus;
  priority?: number;
  assigneeId?: string | null;
  labelIds?: string[];
}

export interface PatchIssueInput {
  version: number;
  title?: string;
  description?: string;
  status?: IssueStatus;
  priority?: number;
  assigneeId?: string | null;
  projectKey?: string;
}

/** Thrown inside a transaction to roll it back; reported with the issue's current state. */
class StaleVersion extends Error {
  constructor(readonly issueId: string) {
    super('stale issue version');
  }
}

function toIssueDetail(row: IssueDetailRow, labels: LabelRow[]): IssueDetailView {
  return {
    id: row.id,
    identifier: formatIdentifier(row.project_key, row.number),
    projectKey: row.project_key,
    number: row.number,
    title: row.title,
    description: row.description,
    status: row.status,
    priority: row.priority,
    assignee:
      row.assignee_id && row.assignee_name !== null
        ? { id: row.assignee_id, name: row.assignee_name }
        : null,
    reporter: { id: row.reporter_id, name: row.reporter_name },
    labels,
    version: row.version,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

async function loadIssue(deps: Deps, orgId: string, issueId: string): Promise<IssueDetailView> {
  const row = await findIssueDetail(orgId, issueId, deps.db);
  if (!row) throw notFound();
  const labels = await findLabelsForIssues(orgId, [row.id], deps.db);
  return toIssueDetail(row, labels.get(row.id) ?? []);
}

async function versionConflict(deps: Deps, orgId: string, issueId: string) {
  const row = await findIssueDetail(orgId, issueId, deps.db);
  if (!row) return notFound();
  const labels = await findLabelsForIssues(orgId, [row.id], deps.db);
  return conflict('version_conflict', 'This issue was changed by someone else.', {
    current: toIssueDetail(row, labels.get(row.id) ?? []),
  });
}

async function withVersionCheck(deps: Deps, orgId: string, work: () => Promise<string>) {
  try {
    return await work();
  } catch (err) {
    if (err instanceof StaleVersion) throw await versionConflict(deps, orgId, err.issueId);
    throw err;
  }
}

async function requireIssue(orgId: string, ref: IssueRef, db: Database): Promise<IssueRow> {
  const issue = await findIssueByNumber(orgId, ref.projectKey, ref.number, db);
  if (!issue) throw notFound();
  return issue;
}

async function assertAssignable(orgId: string, userId: string, db: Database): Promise<void> {
  const role = await lockAssignableMember(orgId, userId, db);
  if (!role || role === 'viewer') throw invalidReference('assigneeId');
}

async function assertLabelsExist(orgId: string, labelIds: string[], db: Database): Promise<void> {
  const found = await lockLabelIds(orgId, labelIds, db);
  if (found.length !== labelIds.length) throw invalidReference('labelIds');
}

export async function getIssue(
  deps: Deps,
  tenant: TenantContext,
  ref: IssueRef,
): Promise<IssueDetailView> {
  const issue = await requireIssue(tenant.orgId, ref, deps.db);
  return loadIssue(deps, tenant.orgId, issue.id);
}

export async function createIssue(
  deps: Deps,
  tenant: TenantContext,
  projectKey: string,
  input: CreateIssueInput,
): Promise<IssueDetailView> {
  const project = await findProjectByKey(tenant.orgId, projectKey, deps.db);
  if (!project) throw notFound();
  assertCan(tenant.role, 'issue.create');
  if (project.archived_at) throw projectArchived();

  const now = deps.clock.now();
  const labelIds = input.labelIds ?? [];
  const issueId = await deps.db.transaction().execute(async (trx) => {
    if (input.assigneeId) await assertAssignable(tenant.orgId, input.assigneeId, trx);
    await assertLabelsExist(tenant.orgId, labelIds, trx);
    const number = await allocateIssueNumber(tenant.orgId, project.id, trx);
    if (number === undefined) throw projectArchived();
    const id = await insertIssue(
      tenant.orgId,
      {
        projectId: project.id,
        number,
        title: input.title.trim(),
        description: input.description ?? '',
        status: input.status ?? 'backlog',
        priority: input.priority ?? 0,
        assigneeId: input.assigneeId ?? null,
        reporterId: tenant.userId,
        now,
      },
      trx,
    );
    await replaceIssueLabels(tenant.orgId, id, labelIds, trx);
    return id;
  });
  return loadIssue(deps, tenant.orgId, issueId);
}

export async function patchIssue(
  deps: Deps,
  tenant: TenantContext,
  ref: IssueRef,
  input: PatchIssueInput,
): Promise<IssueDetailView> {
  const now = deps.clock.now();
  const issueId = await withVersionCheck(deps, tenant.orgId, () =>
    deps.db.transaction().execute(async (trx) => {
      const issue = await requireIssue(tenant.orgId, ref, trx);
      assertCan(tenant.role, 'issue.update');
      if (issue.archived_at) throw projectArchived();

      const changes: IssueChanges = {};
      if (input.title !== undefined && input.title.trim() !== issue.title) {
        changes.title = input.title.trim();
      }
      if (input.description !== undefined && input.description !== issue.description) {
        changes.description = input.description;
      }
      if (input.status !== undefined && input.status !== issue.status) {
        changes.status = input.status;
      }
      if (input.priority !== undefined && input.priority !== issue.priority) {
        changes.priority = input.priority;
      }
      if (input.assigneeId !== undefined && input.assigneeId !== issue.assignee_id) {
        if (input.assigneeId !== null) {
          await assertAssignable(tenant.orgId, input.assigneeId, trx);
        }
        changes.assignee_id = input.assigneeId;
      }
      if (input.projectKey !== undefined && input.projectKey !== issue.project_key) {
        const target = await findProjectByKey(tenant.orgId, input.projectKey, trx);
        if (!target) throw invalidReference('projectKey');
        const number = await allocateIssueNumber(tenant.orgId, target.id, trx);
        if (number === undefined) throw projectArchived();
        changes.project_id = target.id;
        changes.number = number;
      }

      if (Object.keys(changes).length === 0) {
        if (issue.version !== input.version) throw new StaleVersion(issue.id);
        return issue.id;
      }
      const updated = await updateIssueIfVersion(
        tenant.orgId,
        issue.id,
        input.version,
        changes,
        now,
        trx,
      );
      if (!updated) throw new StaleVersion(issue.id);
      return issue.id;
    }),
  );
  return loadIssue(deps, tenant.orgId, issueId);
}

export async function replaceLabels(
  deps: Deps,
  tenant: TenantContext,
  ref: IssueRef,
  input: { version: number; labelIds: string[] },
): Promise<IssueDetailView> {
  const now = deps.clock.now();
  const issueId = await withVersionCheck(deps, tenant.orgId, () =>
    deps.db.transaction().execute(async (trx) => {
      const issue = await requireIssue(tenant.orgId, ref, trx);
      assertCan(tenant.role, 'issue.update');
      if (issue.archived_at) throw projectArchived();
      await assertLabelsExist(tenant.orgId, input.labelIds, trx);

      const current = new Set(await listIssueLabelIds(tenant.orgId, issue.id, trx));
      const unchanged =
        current.size === input.labelIds.length && input.labelIds.every((id) => current.has(id));
      if (unchanged) {
        if (issue.version !== input.version) throw new StaleVersion(issue.id);
        return issue.id;
      }
      const updated = await updateIssueIfVersion(tenant.orgId, issue.id, input.version, {}, now, trx);
      if (!updated) throw new StaleVersion(issue.id);
      await replaceIssueLabels(tenant.orgId, issue.id, input.labelIds, trx);
      return issue.id;
    }),
  );
  return loadIssue(deps, tenant.orgId, issueId);
}

/** Comments and label links go with the issue. Its number is not reused. */
export async function deleteIssue(deps: Deps, tenant: TenantContext, ref: IssueRef): Promise<void> {
  const issue = await requireIssue(tenant.orgId, ref, deps.db);
  assertCan(tenant.role, 'issue.delete');
  if (issue.archived_at) throw projectArchived();
  await deleteIssueRow(tenant.orgId, issue.id, deps.db);
}
