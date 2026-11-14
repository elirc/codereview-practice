import type { AppDeps } from '../../app.js';
import { isUniqueViolation } from '../../db/index.js';
import { conflict, notFound, unprocessable } from '../../lib/errors.js';
import { assertCan } from '../../lib/permissions.js';
import type { TenantContext } from '../../plugins/tenant.js';
import {
  archiveProject as archiveProjectRow,
  findProjectByKey,
  insertProject,
  listProjects as listProjectRows,
  updateProjectName,
  type ProjectRow,
} from './repo.js';

type Deps = Pick<AppDeps, 'db' | 'clock'>;

export interface ProjectView {
  id: string;
  key: string;
  name: string;
  archivedAt: string | null;
  createdAt: string;
}

export function toProject(row: ProjectRow): ProjectView {
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    archivedAt: row.archived_at ? row.archived_at.toISOString() : null,
    createdAt: row.created_at.toISOString(),
  };
}

export function projectArchived() {
  return unprocessable('project_archived', 'This project is archived and read-only.');
}

async function requireProject(deps: Deps, tenant: TenantContext, key: string) {
  const project = await findProjectByKey(tenant.orgId, key, deps.db);
  if (!project) throw notFound();
  return project;
}

export async function listProjects(deps: Deps, tenant: TenantContext) {
  const rows = await listProjectRows(tenant.orgId, deps.db);
  return { items: rows.map(toProject) };
}

export async function createProject(
  deps: Deps,
  tenant: TenantContext,
  input: { key: string; name: string },
): Promise<ProjectView> {
  assertCan(tenant.role, 'project.manage');
  try {
    const row = await insertProject(
      tenant.orgId,
      { key: input.key, name: input.name.trim(), now: deps.clock.now() },
      deps.db,
    );
    return toProject(row);
  } catch (err) {
    if (isUniqueViolation(err, 'projects_org_id_key_key')) {
      throw conflict('project_key_taken', 'A project with this key already exists.');
    }
    throw err;
  }
}

export async function renameProject(
  deps: Deps,
  tenant: TenantContext,
  key: string,
  input: { name: string },
): Promise<ProjectView> {
  const project = await requireProject(deps, tenant, key);
  assertCan(tenant.role, 'project.manage');
  const row = await updateProjectName(tenant.orgId, project.id, input.name.trim(), deps.db);
  if (!row) throw notFound();
  return toProject(row);
}

export async function archiveProject(
  deps: Deps,
  tenant: TenantContext,
  key: string,
): Promise<ProjectView> {
  const project = await requireProject(deps, tenant, key);
  assertCan(tenant.role, 'project.manage');
  const row = await archiveProjectRow(tenant.orgId, project.id, deps.clock.now(), deps.db);
  if (!row) throw notFound();
  return toProject(row);
}
