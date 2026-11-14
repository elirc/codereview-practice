import type { AvailabilityException, AvailabilityRule } from "@prisma/client";
import type { DateTime } from "luxon";
import {
  matchesSlot,
  slotsForDate,
  type ExceptionSpec,
  type RuleSpec,
  type Slot,
} from "@/domain/slots";
import { localDateOf, type LocalDate } from "@/domain/time";
import { fromDbDate, fromDbInstant, toDbDate } from "@/server/dates";
import type { DbClient } from "@/server/db";

export interface ProviderSchedule {
  rules: RuleSpec[];
  exceptions: Map<LocalDate, ExceptionSpec>;
}

export function toRuleSpec(rule: AvailabilityRule): RuleSpec {
  return {
    weekday: rule.weekday,
    startLocal: rule.startLocal,
    endLocal: rule.endLocal,
    slotMinutes: rule.slotMinutes,
    validFrom: fromDbDate(rule.validFrom),
    validTo: rule.validTo ? fromDbDate(rule.validTo) : null,
  };
}

export function toExceptionSpec(exception: AvailabilityException): ExceptionSpec {
  return {
    localDate: fromDbDate(exception.localDate),
    kind: exception.kind,
    startLocal: exception.startLocal,
    endLocal: exception.endLocal,
    slotMinutes: exception.slotMinutes,
  };
}

/** Loads the rules and exceptions that can affect any date in `[from, to]`. */
export async function loadSchedule(
  client: DbClient,
  providerId: string,
  from: LocalDate,
  to: LocalDate,
): Promise<ProviderSchedule> {
  const rules = await client.availabilityRule.findMany({
    where: {
      providerId,
      validFrom: { lte: toDbDate(to) },
      OR: [{ validTo: null }, { validTo: { gte: toDbDate(from) } }],
    },
  });
  const exceptions = await client.availabilityException.findMany({
    where: { providerId, localDate: { gte: toDbDate(from), lte: toDbDate(to) } },
  });
  return {
    rules: rules.map(toRuleSpec),
    exceptions: new Map(exceptions.map((e) => [fromDbDate(e.localDate), toExceptionSpec(e)])),
  };
}

export function scheduleSlots(schedule: ProviderSchedule, date: LocalDate, zone: string): Slot[] {
  return slotsForDate(date, zone, schedule.rules, schedule.exceptions);
}

/** Future BOOKED appointments of a provider that no longer line up with a generated slot. */
export async function findAffectedAppointments(
  client: DbClient,
  provider: { id: string; clinic: { timezone: string } },
  now: DateTime,
): Promise<string[]> {
  const providerId = provider.id;
  const zone = provider.clinic.timezone;
  const appointments = await client.appointment.findMany({
    where: { providerId, status: "BOOKED", startsAt: { gte: now.toJSDate() } },
    select: { id: true, startsAt: true, endsAt: true },
    orderBy: { startsAt: "asc" },
  });
  if (appointments.length === 0) return [];

  const ranges = appointments.map((a) => ({
    id: a.id,
    startsAt: fromDbInstant(a.startsAt),
    endsAt: fromDbInstant(a.endsAt),
  }));
  const first = localDateOf(ranges[0].startsAt, zone);
  const last = localDateOf(ranges[ranges.length - 1].startsAt, zone);
  const schedule = await loadSchedule(client, providerId, first, last);

  const slotsByDate = new Map<LocalDate, Slot[]>();
  return ranges
    .filter((range) => {
      const date = localDateOf(range.startsAt, zone);
      let slots = slotsByDate.get(date);
      if (!slots) {
        slots = scheduleSlots(schedule, date, zone);
        slotsByDate.set(date, slots);
      }
      return !matchesSlot(slots, range);
    })
    .map((range) => range.id);
}
