import type { AppDeps } from '../../app.js';
import { isUniqueViolation } from '../../db/index.js';
import { conflict, notFound } from '../../lib/errors.js';
import { assertCan, type Role } from '../../lib/permissions.js';
import type { TenantContext } from '../../plugins/tenant.js';
import { deleteOrg, findOrg, insertOrgWithOwner, updateOrgName } from './repo.js';

type Deps = Pick<AppDeps, 'db' | 'clock'>;

export interface OrgView {
  id: string;
  slug: string;
  name: string;
  role: Role;
}

export async function createOrg(
  deps: Deps,
  userId: string,
  input: { slug: string; name: string },
): Promise<OrgView> {
  try {
    const org = await insertOrgWithOwner(
      { slug: input.slug, name: input.name.trim(), ownerId: userId, now: deps.clock.now() },
      deps.db,
    );
    return { ...org, role: 'owner' };
  } catch (err) {
    if (isUniqueViolation(err, 'orgs_slug_key')) {
      throw conflict('slug_taken', 'That organisation slug is already taken.');
    }
    throw err;
  }
}

export async function getOrg(deps: Deps, tenant: TenantContext): Promise<OrgView> {
  const org = await findOrg(tenant.orgId, deps.db);
  if (!org) throw notFound();
  return { ...org, role: tenant.role };
}

export async function renameOrg(
  deps: Deps,
  tenant: TenantContext,
  input: { name: string },
): Promise<OrgView> {
  assertCan(tenant.role, 'org.update');
  const org = await updateOrgName(tenant.orgId, input.name.trim(), deps.db);
  if (!org) throw notFound();
  return { ...org, role: tenant.role };
}

export async function removeOrg(deps: Deps, tenant: TenantContext): Promise<void> {
  assertCan(tenant.role, 'org.delete');
  await deleteOrg(tenant.orgId, deps.db);
}
