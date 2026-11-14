import type { AppDeps } from '../../app.js';
import { isUniqueViolation } from '../../db/index.js';
import { conflict, notFound } from '../../lib/errors.js';
import { assertCan } from '../../lib/permissions.js';
import type { TenantContext } from '../../plugins/tenant.js';
import {
  deleteLabel as deleteLabelRow,
  findLabel,
  insertLabel,
  listLabels as listLabelRows,
  updateLabel as updateLabelRow,
  type LabelRow,
} from './repo.js';

type Deps = Pick<AppDeps, 'db' | 'clock'>;

function labelExists() {
  return conflict('label_exists', 'A label with this name already exists.');
}

async function withLabelNameCheck<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (err) {
    if (isUniqueViolation(err, 'labels_org_id_name_key')) throw labelExists();
    throw err;
  }
}

async function requireLabel(deps: Deps, tenant: TenantContext, labelId: string) {
  const label = await findLabel(tenant.orgId, labelId, deps.db);
  if (!label) throw notFound();
  return label;
}

export async function listLabels(deps: Deps, tenant: TenantContext) {
  return { items: await listLabelRows(tenant.orgId, deps.db) };
}

export async function createLabel(
  deps: Deps,
  tenant: TenantContext,
  input: { name: string; color: string },
): Promise<LabelRow> {
  assertCan(tenant.role, 'label.manage');
  return withLabelNameCheck(() =>
    insertLabel(
      tenant.orgId,
      { name: input.name.trim(), color: input.color.toLowerCase(), now: deps.clock.now() },
      deps.db,
    ),
  );
}

export async function updateLabel(
  deps: Deps,
  tenant: TenantContext,
  labelId: string,
  input: { name?: string; color?: string },
): Promise<LabelRow> {
  await requireLabel(deps, tenant, labelId);
  assertCan(tenant.role, 'label.manage');
  const changes: { name?: string; color?: string } = {};
  if (input.name !== undefined) changes.name = input.name.trim();
  if (input.color !== undefined) changes.color = input.color.toLowerCase();
  const label = await withLabelNameCheck(() =>
    updateLabelRow(tenant.orgId, labelId, changes, deps.db),
  );
  if (!label) throw notFound();
  return label;
}

/** Deleting a label also removes it from every issue that carried it. */
export async function deleteLabel(
  deps: Deps,
  tenant: TenantContext,
  labelId: string,
): Promise<void> {
  await requireLabel(deps, tenant, labelId);
  assertCan(tenant.role, 'label.manage');
  await deleteLabelRow(tenant.orgId, labelId, deps.db);
}
