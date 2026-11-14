import type { Database } from '../../db/index.js';

export interface ProjectRow {
  id: string;
  key: string;
  name: string;
  archived_at: Date | null;
  created_at: Date;
}

const COLUMNS = ['id', 'key', 'name', 'archived_at', 'created_at'] as const;

export async function listProjects(orgId: string, db: Database): Promise<ProjectRow[]> {
  return db
    .selectFrom('projects')
    .select(COLUMNS)
    .where('org_id', '=', orgId)
    .orderBy('key')
    .execute();
}

export async function findProjectByKey(
  orgId: string,
  key: string,
  db: Database,
): Promise<ProjectRow | undefined> {
  return db
    .selectFrom('projects')
    .select(COLUMNS)
    .where('org_id', '=', orgId)
    .where('key', '=', key)
    .executeTakeFirst();
}

export async function insertProject(
  orgId: string,
  values: { key: string; name: string; now: Date },
  db: Database,
): Promise<ProjectRow> {
  return db
    .insertInto('projects')
    .values({ org_id: orgId, key: values.key, name: values.name, created_at: values.now })
    .returning(COLUMNS)
    .executeTakeFirstOrThrow();
}

export async function updateProjectName(
  orgId: string,
  projectId: string,
  name: string,
  db: Database,
): Promise<ProjectRow | undefined> {
  return db
    .updateTable('projects')
    .set({ name })
    .where('org_id', '=', orgId)
    .where('id', '=', projectId)
    .returning(COLUMNS)
    .executeTakeFirst();
}

/** Sets archived_at once; archiving an archived project leaves the original time. */
export async function archiveProject(
  orgId: string,
  projectId: string,
  now: Date,
  db: Database,
): Promise<ProjectRow | undefined> {
  await db
    .updateTable('projects')
    .set({ archived_at: now })
    .where('org_id', '=', orgId)
    .where('id', '=', projectId)
    .where('archived_at', 'is', null)
    .execute();
  return db
    .selectFrom('projects')
    .select(COLUMNS)
    .where('org_id', '=', orgId)
    .where('id', '=', projectId)
    .executeTakeFirst();
}
