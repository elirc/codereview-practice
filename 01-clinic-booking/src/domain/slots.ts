import type { DateTime } from "luxon";
import {
  addDays,
  isoWeekday,
  localDateOf,
  minutesToWallTime,
  overlaps,
  resolveLocal,
  wallTimeToMinutes,
  type LocalDate,
  type TimeRange,
  type WallTime,
} from "./time";

export const SLOT_LENGTHS = [15, 20, 30, 45, 60] as const;

export interface RuleSpec {
  weekday: number;
  startLocal: WallTime;
  endLocal: WallTime;
  slotMinutes: number;
  validFrom: LocalDate;
  validTo: LocalDate | null;
}

export interface ExceptionSpec {
  localDate: LocalDate;
  kind: "CLOSED" | "CUSTOM_HOURS";
  startLocal: WallTime | null;
  endLocal: WallTime | null;
  slotMinutes: number | null;
}

export interface SlotWindow {
  startLocal: WallTime;
  endLocal: WallTime;
  slotMinutes: number;
}

export type Slot = TimeRange;

export type UnavailableReason = "booked" | "too_soon" | "beyond_horizon";

export interface AnnotatedSlot extends Slot {
  available: boolean;
  reason?: UnavailableReason;
}

export interface BookingWindow {
  now: DateTime;
  zone: string;
  minLeadMinutes: number;
  bookingHorizonDays: number;
}

export function ruleAppliesOn(rule: RuleSpec, date: LocalDate): boolean {
  return (
    rule.weekday === isoWeekday(date) &&
    rule.validFrom <= date &&
    (rule.validTo === null || date <= rule.validTo)
  );
}

/** The wall-clock windows a provider works on `date`; an exception replaces every rule. */
export function windowsForDate(
  date: LocalDate,
  rules: RuleSpec[],
  exception: ExceptionSpec | undefined,
): SlotWindow[] {
  if (exception) {
    if (exception.kind === "CLOSED") return [];
    const { startLocal, endLocal, slotMinutes } = exception;
    return startLocal && endLocal && slotMinutes ? [{ startLocal, endLocal, slotMinutes }] : [];
  }
  return rules
    .filter((rule) => ruleAppliesOn(rule, date))
    .map(({ startLocal, endLocal, slotMinutes }) => ({ startLocal, endLocal, slotMinutes }))
    .sort((a, b) => wallTimeToMinutes(a.startLocal) - wallTimeToMinutes(b.startLocal));
}

/** Resolves each window's wall-clock grid on `date` in `zone` into instant ranges. */
export function generateSlots(date: LocalDate, zone: string, windows: SlotWindow[]): Slot[] {
  const slots: Slot[] = [];
  for (const window of windows) {
    const windowEnd = wallTimeToMinutes(window.endLocal);
    let previousEndMs: number | null = null;
    for (
      let candidate = wallTimeToMinutes(window.startLocal);
      candidate + window.slotMinutes <= windowEnd;
      candidate += window.slotMinutes
    ) {
      const startsAt = resolveLocal(date, minutesToWallTime(candidate), zone);
      if (!startsAt) continue;
      if (previousEndMs !== null && startsAt.toMillis() < previousEndMs) continue;
      const endsAt = startsAt.plus({ minutes: window.slotMinutes });
      slots.push({ startsAt, endsAt });
      previousEndMs = endsAt.toMillis();
    }
  }
  return slots.sort((a, b) => a.startsAt.toMillis() - b.startsAt.toMillis());
}

export function slotsForDate(
  date: LocalDate,
  zone: string,
  rules: RuleSpec[],
  exceptions: ReadonlyMap<LocalDate, ExceptionSpec>,
): Slot[] {
  return generateSlots(date, zone, windowsForDate(date, rules, exceptions.get(date)));
}

export function findSlot(slots: Slot[], startsAt: DateTime): Slot | undefined {
  const target = startsAt.toMillis();
  return slots.find((slot) => slot.startsAt.toMillis() === target);
}

export function matchesSlot(slots: Slot[], range: TimeRange): boolean {
  const slot = findSlot(slots, range.startsAt);
  return slot !== undefined && slot.endsAt.toMillis() === range.endsAt.toMillis();
}

/** The last clinic-local date that can still be booked. */
export function horizonLastDate(window: BookingWindow): LocalDate {
  return addDays(localDateOf(window.now, window.zone), window.bookingHorizonDays);
}

export function isTooSoon(startsAt: DateTime, window: BookingWindow): boolean {
  return startsAt.toMillis() < window.now.plus({ minutes: window.minLeadMinutes }).toMillis();
}

export function isBeyondHorizon(startsAt: DateTime, window: BookingWindow): boolean {
  return localDateOf(startsAt, window.zone) > horizonLastDate(window);
}

export function annotateSlots(
  slots: Slot[],
  window: BookingWindow,
  booked: TimeRange[],
): AnnotatedSlot[] {
  return slots.map((slot) => {
    let reason: UnavailableReason | undefined;
    if (booked.some((range) => overlaps(slot, range))) reason = "booked";
    else if (isTooSoon(slot.startsAt, window)) reason = "too_soon";
    else if (isBeyondHorizon(slot.startsAt, window)) reason = "beyond_horizon";
    return reason ? { ...slot, available: false, reason } : { ...slot, available: true };
  });
}
