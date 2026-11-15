import type { Clinic, Provider } from "@prisma/client";
import type { DateTime } from "luxon";
import { rulesConflict, ruleShapeProblems } from "@/domain/availability";
import type { RuleSpec } from "@/domain/slots";
import type { LocalDate } from "@/domain/time";
import type { Actor } from "@/server/auth/actor";
import { fromDbDate, toDbDate } from "@/server/dates";
import { db, LOCKING_TX_OPTIONS, type DbClient } from "@/server/db";
import { isUniqueViolation } from "@/server/db-errors";
import { AppError, forbidden, notFound, validationError } from "@/server/errors";
import { findAffectedAppointments, toRuleSpec } from "./schedule";

type ProviderWithClinic = Provider & { clinic: Clinic };

export interface RuleInput {
  weekday: number;
  startLocal: string;
  endLocal: string;
  slotMinutes: number;
  validFrom: LocalDate;
  validTo?: LocalDate | null;
}

export type RulePatch = Partial<RuleInput>;

export type ExceptionInput =
  | { kind: "CLOSED"; localDate: LocalDate }
  | {
      kind: "CUSTOM_HOURS";
      localDate: LocalDate;
      startLocal: string;
      endLocal: string;
      slotMinutes: number;
    };

async function loadProvider(providerId: string): Promise<ProviderWithClinic> {
  const provider = await db.provider.findUnique({
    where: { id: providerId },
    include: { clinic: true },
  });
  if (!provider) throw notFound("Provider");
  return provider;
}

function assertCanRead(actor: Actor, provider: Provider): void {
  if (actor.role === "ADMIN") return;
  if (actor.role === "STAFF" && actor.clinicId === provider.clinicId) return;
  if (actor.role === "PROVIDER" && actor.providerId === provider.id) return;
  throw forbidden();
}

function canManage(actor: Actor, provider: Provider): boolean {
  if (actor.role === "ADMIN") return true;
  return actor.role === "STAFF" && actor.clinicId === provider.clinicId;
}

function assertCanManage(actor: Actor, provider: Provider): void {
  if (!canManage(actor, provider)) throw forbidden();
}

export async function lockProvider(tx: DbClient, providerId: string): Promise<void> {
  await tx.$queryRaw`SELECT id FROM providers WHERE id = ${providerId}::uuid FOR UPDATE`;
}

function assertRuleShape(rule: RuleSpec): void {
  const problems = ruleShapeProblems(rule);
  if (problems.length > 0) throw validationError(problems);
}

async function assertNoConflict(
  tx: DbClient,
  providerId: string,
  rule: RuleSpec,
  excludeRuleId: string | null,
): Promise<void> {
  const siblings = await tx.availabilityRule.findMany({
    where: {
      providerId,
      weekday: rule.weekday,
      ...(excludeRuleId ? { NOT: { id: excludeRuleId } } : {}),
    },
  });
  const conflict = siblings.find((sibling) => rulesConflict(rule, toRuleSpec(sibling)));
  if (conflict) {
    throw new AppError("rule_overlap", "The rule overlaps another rule for this weekday.", {
      ruleId: conflict.id,
    });
  }
}

function ruleData(rule: RuleSpec) {
  return {
    weekday: rule.weekday,
    startLocal: rule.startLocal,
    endLocal: rule.endLocal,
    slotMinutes: rule.slotMinutes,
    validFrom: toDbDate(rule.validFrom),
    validTo: rule.validTo ? toDbDate(rule.validTo) : null,
  };
}

function findRules(providerId: string) {
  return db.availabilityRule.findMany({
    where: { providerId },
    orderBy: [{ weekday: "asc" }, { startLocal: "asc" }, { validFrom: "asc" }],
  });
}

function findExceptions(providerId: string) {
  return db.availabilityException.findMany({
    where: { providerId },
    orderBy: { localDate: "asc" },
  });
}

/** Everything the availability editor shows for one provider. */
export async function getAvailability(actor: Actor, providerId: string) {
  const provider = await loadProvider(providerId);
  assertCanRead(actor, provider);
  const rules = await findRules(providerId);
  const exceptions = await findExceptions(providerId);
  return { provider, rules, exceptions, canManage: canManage(actor, provider) };
}

export async function listRules(actor: Actor, providerId: string) {
  assertCanRead(actor, await loadProvider(providerId));
  return findRules(providerId);
}

export async function createRule(
  actor: Actor,
  providerId: string,
  input: RuleInput,
  now: DateTime,
) {
  const provider = await loadProvider(providerId);
  assertCanManage(actor, provider);
  const spec: RuleSpec = { ...input, validTo: input.validTo ?? null };
  assertRuleShape(spec);

  return db.$transaction(async (tx) => {
    await lockProvider(tx, providerId);
    await assertNoConflict(tx, providerId, spec, null);
    const rule = await tx.availabilityRule.create({ data: { providerId, ...ruleData(spec) } });
    const affectedAppointments = await findAffectedAppointments(tx, provider, now);
    return { rule, affectedAppointments };
  }, LOCKING_TX_OPTIONS);
}

async function loadRule(ruleId: string) {
  const rule = await db.availabilityRule.findUnique({
    where: { id: ruleId },
    include: { provider: { include: { clinic: true } } },
  });
  if (!rule) throw notFound("Availability rule");
  return rule;
}

export async function updateRule(actor: Actor, ruleId: string, patch: RulePatch, now: DateTime) {
  const { provider } = await loadRule(ruleId);
  assertCanManage(actor, provider);

  return db.$transaction(async (tx) => {
    await lockProvider(tx, provider.id);
    const current = await tx.availabilityRule.findUnique({ where: { id: ruleId } });
    if (!current) throw notFound("Availability rule");
    const base = toRuleSpec(current);
    const merged: RuleSpec = {
      weekday: patch.weekday ?? base.weekday,
      startLocal: patch.startLocal ?? base.startLocal,
      endLocal: patch.endLocal ?? base.endLocal,
      slotMinutes: patch.slotMinutes ?? base.slotMinutes,
      validFrom: patch.validFrom ?? base.validFrom,
      validTo: patch.validTo === undefined ? base.validTo : patch.validTo,
    };
    assertRuleShape(merged);
    await assertNoConflict(tx, provider.id, merged, ruleId);
    const rule = await tx.availabilityRule.update({
      where: { id: ruleId },
      data: ruleData(merged),
    });
    const affectedAppointments = await findAffectedAppointments(tx, provider, now);
    return { rule, affectedAppointments };
  }, LOCKING_TX_OPTIONS);
}

export async function deleteRule(actor: Actor, ruleId: string, now: DateTime) {
  const { provider } = await loadRule(ruleId);
  assertCanManage(actor, provider);

  return db.$transaction(async (tx) => {
    await lockProvider(tx, provider.id);
    const { count } = await tx.availabilityRule.deleteMany({ where: { id: ruleId } });
    if (count === 0) throw notFound("Availability rule");
    const affectedAppointments = await findAffectedAppointments(tx, provider, now);
    return { affectedAppointments };
  }, LOCKING_TX_OPTIONS);
}

export async function listExceptions(actor: Actor, providerId: string) {
  assertCanRead(actor, await loadProvider(providerId));
  return findExceptions(providerId);
}

export function exceptionExists(date: LocalDate): AppError {
  return new AppError("exception_exists", `An exception already exists for ${date}.`);
}

export async function createException(
  actor: Actor,
  providerId: string,
  input: ExceptionInput,
  now: DateTime,
) {
  const provider = await loadProvider(providerId);
  assertCanManage(actor, provider);
  const hours =
    input.kind === "CUSTOM_HOURS"
      ? { startLocal: input.startLocal, endLocal: input.endLocal, slotMinutes: input.slotMinutes }
      : { startLocal: null, endLocal: null, slotMinutes: null };

  const localDate = toDbDate(input.localDate);

  try {
    return await db.$transaction(async (tx) => {
      await lockProvider(tx, providerId);
      const existing = await tx.availabilityException.findUnique({
        where: { providerId_localDate: { providerId, localDate } },
      });
      if (existing) throw exceptionExists(input.localDate);
      const exception = await tx.availabilityException.create({
        data: { providerId, localDate, kind: input.kind, ...hours },
      });
      const affectedAppointments = await findAffectedAppointments(tx, provider, now);
      return { exception, affectedAppointments };
    }, LOCKING_TX_OPTIONS);
  } catch (err) {
    if (isUniqueViolation(err)) throw exceptionExists(input.localDate);
    throw err;
  }
}

export async function deleteException(actor: Actor, exceptionId: string, now: DateTime) {
  const exception = await db.availabilityException.findUnique({
    where: { id: exceptionId },
    include: { provider: { include: { clinic: true } } },
  });
  if (!exception) throw notFound("Availability exception");
  const { provider } = exception;
  assertCanManage(actor, provider);

  return db.$transaction(async (tx) => {
    await lockProvider(tx, provider.id);
    const { count } = await tx.availabilityException.deleteMany({ where: { id: exceptionId } });
    if (count === 0) throw notFound("Availability exception");
    const affectedAppointments = await findAffectedAppointments(tx, provider, now);
    return { affectedAppointments, localDate: fromDbDate(exception.localDate) };
  }, LOCKING_TX_OPTIONS);
}
