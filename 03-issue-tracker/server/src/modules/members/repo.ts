import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { isoMicros } from '../../db/sql.js';
import type { MembershipRole } from '../../db/types.js';
import type { Cursor } from '../../lib/cursor.js';

export interface MemberRow {
  user_id: string;
  name: string;
  email: string;
  role: MembershipRole;
  created_at: Date;
  joined_cursor: string;
}

function memberQuery(orgId: string, db: Database) {
  return db
    .selectFrom('memberships as m')
    .innerJoin('users as u', 'u.id', 'm.user_id')
    .select([
      'm.user_id',
      'u.name',
      'u.email',
      'm.role',
      'm.created_at',
      isoMicros('m.created_at').as('joined_cursor'),
    ])
    .where('m.org_id', '=', orgId);
}

export async function listMembersPage(
  orgId: string,
  after: Cursor | null,
  take: number,
  db: Database,
): Promise<MemberRow[]> {
  let query = memberQuery(orgId, db);
  if (after) {
    query = query.where(
      sql<boolean>`(m.created_at, m.user_id) > (${after.v}::timestamptz, ${after.id}::uuid)`,
    );
  }
  return query.orderBy('m.created_at', 'asc').orderBy('m.user_id', 'asc').limit(take).execute();
}

export async function findMember(
  orgId: string,
  userId: string,
  db: Database,
): Promise<MemberRow | undefined> {
  return memberQuery(orgId, db).where('m.user_id', '=', userId).executeTakeFirst();
}

export async function findMembershipRole(
  orgId: string,
  userId: string,
  db: Database,
): Promise<MembershipRole | undefined> {
  const row = await db
    .selectFrom('memberships')
    .select('role')
    .where('org_id', '=', orgId)
    .where('user_id', '=', userId)
    .executeTakeFirst();
  return row?.role;
}

/** Locks the org's owner rows; returns the owners' user ids. */
export async function lockOwners(orgId: string, db: Database): Promise<string[]> {
  const rows = await db
    .selectFrom('memberships')
    .select('user_id')
    .where('org_id', '=', orgId)
    .where('role', '=', 'owner')
    .orderBy('user_id')
    .forUpdate()
    .execute();
  return rows.map((row) => row.user_id);
}

export async function lockMembership(
  orgId: string,
  userId: string,
  db: Database,
): Promise<MembershipRole | undefined> {
  const row = await db
    .selectFrom('memberships')
    .select('role')
    .where('org_id', '=', orgId)
    .where('user_id', '=', userId)
    .forUpdate()
    .executeTakeFirst();
  return row?.role;
}

/** The member's role, locked FOR SHARE. */
export async function lockAssignableMember(
  orgId: string,
  userId: string,
  db: Database,
): Promise<MembershipRole | undefined> {
  const row = await db
    .selectFrom('memberships')
    .select('role')
    .where('org_id', '=', orgId)
    .where('user_id', '=', userId)
    .forShare()
    .executeTakeFirst();
  return row?.role;
}

export async function insertMembership(
  orgId: string,
  values: { userId: string; role: MembershipRole; now: Date },
  db: Database,
): Promise<void> {
  await db
    .insertInto('memberships')
    .values({ org_id: orgId, user_id: values.userId, role: values.role, created_at: values.now })
    .execute();
}

export async function updateMembershipRole(
  orgId: string,
  userId: string,
  role: MembershipRole,
  db: Database,
): Promise<void> {
  await db
    .updateTable('memberships')
    .set({ role })
    .where('org_id', '=', orgId)
    .where('user_id', '=', userId)
    .execute();
}

export async function deleteMembership(orgId: string, userId: string, db: Database): Promise<void> {
  await db
    .deleteFrom('memberships')
    .where('org_id', '=', orgId)
    .where('user_id', '=', userId)
    .execute();
}

/** Clears the member as assignee everywhere in the org, bumping each issue's version. */
export async function unassignMemberIssues(
  orgId: string,
  userId: string,
  now: Date,
  db: Database,
): Promise<void> {
  await db
    .updateTable('issues')
    .set({ assignee_id: null, version: sql<number>`version + 1`, updated_at: now })
    .where('org_id', '=', orgId)
    .where('assignee_id', '=', userId)
    .execute();
}

export async function findUserIdByEmail(email: string, db: Database): Promise<string | undefined> {
  const row = await db.selectFrom('users').select('id').where('email', '=', email).executeTakeFirst();
  return row?.id;
}
