import type { Database } from '../../db/index.js';
import type { MembershipRole } from '../../db/types.js';

export async function findMembershipBySlug(
  slug: string,
  userId: string,
  db: Database,
): Promise<{ orgId: string; role: MembershipRole } | undefined> {
  return db
    .selectFrom('orgs as o')
    .innerJoin('memberships as m', 'm.org_id', 'o.id')
    .select(['o.id as orgId', 'm.role'])
    .where('o.slug', '=', slug)
    .where('m.user_id', '=', userId)
    .executeTakeFirst();
}

export async function insertOrgWithOwner(
  values: { slug: string; name: string; ownerId: string; now: Date },
  db: Database,
): Promise<{ id: string; slug: string; name: string }> {
  return db.transaction().execute(async (trx) => {
    const org = await trx
      .insertInto('orgs')
      .values({ slug: values.slug, name: values.name, created_at: values.now })
      .returning(['id', 'slug', 'name'])
      .executeTakeFirstOrThrow();
    await trx
      .insertInto('memberships')
      .values({ org_id: org.id, user_id: values.ownerId, role: 'owner', created_at: values.now })
      .execute();
    return org;
  });
}

export async function findOrg(orgId: string, db: Database) {
  return db
    .selectFrom('orgs')
    .select(['id', 'slug', 'name'])
    .where('id', '=', orgId)
    .executeTakeFirst();
}

export async function updateOrgName(orgId: string, name: string, db: Database) {
  return db
    .updateTable('orgs')
    .set({ name })
    .where('id', '=', orgId)
    .returning(['id', 'slug', 'name'])
    .executeTakeFirst();
}

/** Deletes the org and everything it owns. */
export async function deleteOrg(orgId: string, db: Database): Promise<void> {
  await db.transaction().execute(async (trx) => {
    // Issues go first so their assignee references are gone before memberships cascade.
    await trx.deleteFrom('issues').where('org_id', '=', orgId).execute();
    await trx.deleteFrom('orgs').where('id', '=', orgId).execute();
  });
}
