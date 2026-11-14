import { DateTime } from "luxon";
import { describe, expect, it } from "vitest";
import { checkBookingWindow, evaluateCancellation, outcomeProblem } from "@/domain/policies";
import { planReminders } from "@/domain/reminders";

const startsAt = DateTime.fromISO("2026-07-10T14:00:00Z", { zone: "utc" });
const exactlyADayBefore = startsAt.minus({ hours: 24 });
const clinicRoles = ["STAFF", "ADMIN"] as const;

describe("cancellation policy", () => {
  it("lets a patient cancel at exactly 24 hours' notice", () => {
    expect(evaluateCancellation("PATIENT", startsAt, exactlyADayBefore)).toEqual({
      allowed: true,
      lateCancel: false,
    });
  });

  it("refuses a patient one second inside the 24-hour window", () => {
    const now = exactlyADayBefore.plus({ seconds: 1 });
    expect(evaluateCancellation("PATIENT", startsAt, now)).toEqual({
      allowed: false,
      code: "cancellation_window_closed",
    });
  });

  it.each(clinicRoles)("lets %s cancel with full notice at the boundary", (role) => {
    expect(evaluateCancellation(role, startsAt, exactlyADayBefore)).toEqual({
      allowed: true,
      lateCancel: false,
    });
  });

  it.each(clinicRoles)("marks a %s cancellation inside 24 hours as late", (role) => {
    const now = exactlyADayBefore.plus({ seconds: 1 });
    expect(evaluateCancellation(role, startsAt, now)).toEqual({ allowed: true, lateCancel: true });
  });

  it.each(clinicRoles)("refuses %s once the appointment has started", (role) => {
    expect(evaluateCancellation(role, startsAt, startsAt)).toEqual({
      allowed: false,
      code: "already_started",
    });
  });
});

describe("booking window", () => {
  const window = {
    now: DateTime.fromISO("2026-07-10T13:30:00Z", { zone: "utc" }),
    zone: "America/New_York",
    minLeadMinutes: 60,
    bookingHorizonDays: 90,
  };

  it("applies the lead time to patients", () => {
    expect(checkBookingWindow(startsAt, window, false)).toBe("too_soon");
  });

  it("exempts staff from the lead time but not from the start being in the future", () => {
    expect(checkBookingWindow(startsAt, window, true)).toBeNull();
    expect(checkBookingWindow(window.now, window, true)).toBe("in_past");
  });

  it("applies the horizon to everyone", () => {
    const late = DateTime.fromISO("2026-10-09T14:00:00Z", { zone: "utc" });
    expect(checkBookingWindow(late, window, true)).toBe("beyond_horizon");
    expect(checkBookingWindow(late.minus({ days: 1 }), window, false)).toBeNull();
  });
});

describe("outcomes", () => {
  it("allows completion only from BOOKED once the start has passed", () => {
    expect(outcomeProblem("BOOKED", startsAt, startsAt.minus({ minutes: 1 }))).toBe("not_started");
    expect(outcomeProblem("BOOKED", startsAt, startsAt)).toBeNull();
    const later = startsAt.plus({ hours: 1 });
    expect(outcomeProblem("CANCELLED", later, later)).toBe("invalid_state");
  });
});

describe("reminder planning", () => {
  function kindsFor(hoursAhead: number): string[] {
    const now = startsAt.minus({ minutes: hoursAhead * 60 });
    return planReminders(startsAt, now).map((reminder) => reminder.kind);
  }

  it("plans both reminders three days ahead", () => {
    expect(kindsFor(72)).toEqual(["T24H", "T2H"]);
    const [day, twoHours] = planReminders(startsAt, startsAt.minus({ days: 3 }));
    expect(day.scheduledFor.toMillis()).toBe(startsAt.minus({ hours: 24 }).toMillis());
    expect(twoHours.scheduledFor.toMillis()).toBe(startsAt.minus({ hours: 2 }).toMillis());
  });

  it("plans only the two-hour reminder three hours ahead", () => {
    expect(kindsFor(3)).toEqual(["T2H"]);
  });

  it("plans nothing 90 or 30 minutes ahead", () => {
    expect(kindsFor(1.5)).toEqual([]);
    expect(kindsFor(0.5)).toEqual([]);
  });
});
