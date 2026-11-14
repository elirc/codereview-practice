import { sql } from 'kysely';
import type { Database } from '../../db/index.js';

export interface LabelRow {
  id: string;
  name: string;
  color: string;
}

export async function listLabels(orgId: string, db: Database): Promise<LabelRow[]> {
  return db
    .selectFrom('labels')
    .select(['id', 'name', 'color'])
    .where('org_id', '=', orgId)
    .orderBy(sql`lower(name)`)
    .orderBy('id')
    .execute();
}

export async function findLabel(
  orgId: string,
  labelId: string,
  db: Database,
): Promise<LabelRow | undefined> {
  return db
    .selectFrom('labels')
    .select(['id', 'name', 'color'])
    .where('org_id', '=', orgId)
    .where('id', '=', labelId)
    .executeTakeFirst();
}

/**
 * Returns which of `labelIds` exist in the org, share-locking them so they cannot be deleted
 * before the caller's transaction commits.
 */
export async function lockLabelIds(
  orgId: string,
  labelIds: string[],
  db: Database,
): Promise<string[]> {
  if (labelIds.length === 0) return [];
  const rows = await db
    .selectFrom('labels')
    .select('id')
    .where('org_id', '=', orgId)
    .where('id', 'in', labelIds)
    .forShare()
    .execute();
  return rows.map((row) => row.id);
}

export async function insertLabel(
  orgId: string,
  values: { name: string; color: string; now: Date },
  db: Database,
): Promise<LabelRow> {
  return db
    .insertInto('labels')
    .values({ org_id: orgId, name: values.name, color: values.color, created_at: values.now })
    .returning(['id', 'name', 'color'])
    .executeTakeFirstOrThrow();
}

export async function updateLabel(
  orgId: string,
  labelId: string,
  changes: { name?: string; color?: string },
  db: Database,
): Promise<LabelRow | undefined> {
  return db
    .updateTable('labels')
    .set(changes)
    .where('org_id', '=', orgId)
    .where('id', '=', labelId)
    .returning(['id', 'name', 'color'])
    .executeTakeFirst();
}

export async function deleteLabel(orgId: string, labelId: string, db: Database): Promise<void> {
  await db.deleteFrom('labels').where('org_id', '=', orgId).where('id', '=', labelId).execute();
}
