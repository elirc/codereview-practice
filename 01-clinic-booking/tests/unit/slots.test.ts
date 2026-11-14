import { DateTime } from "luxon";
import { describe, expect, it } from "vitest";
import {
  annotateSlots,
  generateSlots,
  slotsForDate,
  type ExceptionSpec,
  type RuleSpec,
  type Slot,
} from "@/domain/slots";

const NEW_YORK = "America/New_York";

function rule(overrides: Partial<RuleSpec> = {}): RuleSpec {
  return {
    weekday: 1,
    startLocal: "09:00",
    endLocal: "12:00",
    slotMinutes: 30,
    validFrom: "2026-01-01",
    validTo: null,
    ...overrides,
  };
}

function local(slots: Slot[], zone = NEW_YORK): string[] {
  return slots.map((slot) => slot.startsAt.setZone(zone).toFormat("HH:mm ZZ"));
}

function utc(value: string): DateTime {
  return DateTime.fromISO(value, { zone: "utc" });
}

const noExceptions = new Map<string, ExceptionSpec>();

const closed = (localDate: string): ExceptionSpec => ({
  localDate,
  kind: "CLOSED",
  startLocal: null,
  endLocal: null,
  slotMinutes: null,
});

describe("slot generation", () => {
  it("lays a plain day out on the slot grid", () => {
    const slots = slotsForDate("2026-07-06", NEW_YORK, [rule()], noExceptions);
    expect(slots).toHaveLength(6);
    expect(slots[0].startsAt.toMillis()).toBe(utc("2026-07-06T13:00").toMillis());
    expect(slots[5].endsAt.toMillis()).toBe(utc("2026-07-06T16:00").toMillis());
  });

  it("does not offer a trailing remainder shorter than a slot", () => {
    const slots = slotsForDate("2026-07-06", NEW_YORK, [rule({ endLocal: "10:45" })], noExceptions);
    expect(local(slots)).toEqual(["09:00 -04:00", "09:30 -04:00", "10:00 -04:00"]);
  });

  it("combines several windows on the same weekday in start order", () => {
    const rules = [rule({ startLocal: "14:00", endLocal: "15:00" }), rule({ endLocal: "10:00" })];
    const slots = slotsForDate("2026-07-06", NEW_YORK, rules, noExceptions);
    expect(local(slots)).toEqual(["09:00 -04:00", "09:30 -04:00", "14:00 -04:00", "14:30 -04:00"]);
  });

  it("generates slots on a rule's last valid date and none after it", () => {
    const rules = [
      rule({ weekday: 1, validTo: "2026-07-06" }),
      rule({ weekday: 2, validTo: "2026-07-06" }),
    ];
    expect(slotsForDate("2026-07-06", NEW_YORK, rules, noExceptions)).toHaveLength(6);
    expect(slotsForDate("2026-07-07", NEW_YORK, rules, noExceptions)).toHaveLength(0);
    expect(slotsForDate("2026-07-13", NEW_YORK, rules, noExceptions)).toHaveLength(0);
  });

  it("ignores a rule before its first valid date", () => {
    const rules = [rule({ validFrom: "2026-07-13" })];
    expect(slotsForDate("2026-07-06", NEW_YORK, rules, noExceptions)).toHaveLength(0);
    expect(slotsForDate("2026-07-13", NEW_YORK, rules, noExceptions)).toHaveLength(6);
  });

  it("offers nothing on a closed day even when rules apply", () => {
    const exceptions = new Map([["2026-07-06", closed("2026-07-06")]]);
    expect(slotsForDate("2026-07-06", NEW_YORK, [rule()], exceptions)).toHaveLength(0);
  });

  it("uses custom hours on a weekday that has no rule", () => {
    const exceptions = new Map<string, ExceptionSpec>([
      [
        "2026-07-11",
        {
          localDate: "2026-07-11",
          kind: "CUSTOM_HOURS",
          startLocal: "10:00",
          endLocal: "11:00",
          slotMinutes: 20,
        },
      ],
    ]);
    const slots = slotsForDate("2026-07-11", NEW_YORK, [rule()], exceptions);
    expect(local(slots)).toEqual(["10:00 -04:00", "10:20 -04:00", "10:40 -04:00"]);
  });

  it("drops wall times skipped on a spring-forward day", () => {
    const window = { startLocal: "01:00", endLocal: "04:00", slotMinutes: 30 };
    const slots = generateSlots("2026-03-08", NEW_YORK, [window]);
    expect(local(slots)).toEqual(["01:00 -05:00", "01:30 -05:00", "03:00 -04:00", "03:30 -04:00"]);
    expect(slots[1].endsAt.toMillis()).toBe(slots[2].startsAt.toMillis());
  });

  it("drops a slot that would start before the previous one ends after a skipped hour", () => {
    const window = { startLocal: "00:45", endLocal: "04:30", slotMinutes: 45 };
    const slots = generateSlots("2026-03-08", NEW_YORK, [window]);
    expect(local(slots)).toEqual(["00:45 -05:00", "01:30 -05:00", "03:45 -04:00"]);
  });

  it("offers each wall time once on a fall-back day without overlapping slots", () => {
    const window = { startLocal: "00:30", endLocal: "03:00", slotMinutes: 30 };
    const slots = generateSlots("2026-11-01", NEW_YORK, [window]);
    expect(local(slots)).toEqual([
      "00:30 -04:00",
      "01:00 -04:00",
      "01:30 -04:00",
      "02:00 -05:00",
      "02:30 -05:00",
    ]);
    for (let i = 1; i < slots.length; i += 1) {
      expect(slots[i].startsAt.toMillis()).toBeGreaterThanOrEqual(slots[i - 1].endsAt.toMillis());
    }
  });

  it("computes each day of a range with that day's offset", () => {
    const rules = [6, 7, 1].map((weekday) => rule({ weekday, endLocal: "10:00", slotMinutes: 60 }));
    const starts = ["2026-03-07", "2026-03-08", "2026-03-09"].map((date) =>
      slotsForDate(date, NEW_YORK, rules, noExceptions)[0].startsAt.toUTC().toFormat("HH:mm"),
    );
    expect(starts).toEqual(["14:00", "13:00", "13:00"]);
  });
});

describe("slot availability", () => {
  const quarterHours = generateSlots("2026-07-02", NEW_YORK, [
    { startLocal: "00:00", endLocal: "01:00", slotMinutes: 15 },
  ]);
  // 23:30 in New York on 2026-07-01, already 2026-07-02 in UTC.
  const lateEvening = utc("2026-07-02T03:30");

  function at(slots: ReturnType<typeof annotateSlots>, wall: string) {
    return slots.find((slot) => slot.startsAt.setZone(NEW_YORK).toFormat("HH:mm") === wall);
  }

  it("marks a slot inside the lead time as too_soon across local midnight", () => {
    const window = { now: lateEvening, zone: NEW_YORK, minLeadMinutes: 60, bookingHorizonDays: 90 };
    const slot = at(annotateSlots(quarterHours, window, []), "00:15");
    expect(slot).toMatchObject({ available: false, reason: "too_soon" });
  });

  it("offers the same slot with a shorter lead time", () => {
    const window = { now: lateEvening, zone: NEW_YORK, minLeadMinutes: 30, bookingHorizonDays: 90 };
    const slot = at(annotateSlots(quarterHours, window, []), "00:15");
    expect(slot).toMatchObject({ available: true });
    expect(slot?.reason).toBeUndefined();
  });

  it("counts the horizon from the clinic's date, not UTC's", () => {
    const window = { now: lateEvening, zone: NEW_YORK, minLeadMinutes: 60, bookingHorizonDays: 90 };
    const window9am = { startLocal: "09:00", endLocal: "09:30", slotMinutes: 30 };
    const lastDay = annotateSlots(generateSlots("2026-09-29", NEW_YORK, [window9am]), window, []);
    const dayAfter = annotateSlots(generateSlots("2026-09-30", NEW_YORK, [window9am]), window, []);
    expect(lastDay[0]).toMatchObject({ available: true });
    expect(dayAfter[0]).toMatchObject({ available: false, reason: "beyond_horizon" });
  });

  it("marks overlapping bookings but not adjacent ones", () => {
    const now = utc("2026-07-01T12:00");
    const window = { now, zone: NEW_YORK, minLeadMinutes: 0, bookingHorizonDays: 90 };
    const booked = [{ startsAt: utc("2026-07-02T04:15"), endsAt: utc("2026-07-02T04:30") }];
    const slots = annotateSlots(quarterHours, window, booked);
    expect(slots.map((slot) => slot.reason ?? "open")).toEqual(["open", "booked", "open", "open"]);
  });
});
