import { DateTime } from "luxon";
import { describe, expect, it } from "vitest";
import { formatAppointmentTime, reminderEmail } from "@/domain/emails";
import { decideReminderAction, statusAfterFailure } from "@/domain/reminders";

const utc = (value: string) => DateTime.fromISO(value, { zone: "utc" });

describe("appointment time formatting", () => {
  it("shows the patient's zone and the clinic's wall time when offsets differ", () => {
    const text = formatAppointmentTime(
      utc("2026-03-10T16:00:00"),
      "Asia/Tokyo",
      "America/Los_Angeles",
    );
    expect(text).toBe(
      "Wednesday, March 11, 2026 at 1:00 AM GMT+9 (Tuesday, March 10 at 9:00 AM PDT clinic time)",
    );
  });

  it("uses the abbreviation in force at that instant, not today's", () => {
    const winter = formatAppointmentTime(utc("2026-01-15T14:00:00"), "America/New_York", "UTC");
    const summer = formatAppointmentTime(utc("2026-07-15T13:00:00"), "America/New_York", "UTC");
    expect(winter).toContain("9:00 AM EST");
    expect(summer).toContain("9:00 AM EDT");
  });

  it("omits the clinic time when both zones share the offset", () => {
    const sameZone = formatAppointmentTime(
      utc("2026-07-15T13:00:00"),
      "America/New_York",
      "America/New_York",
    );
    const sameOffset = formatAppointmentTime(
      utc("2026-07-15T13:00:00"),
      "America/Toronto",
      "America/New_York",
    );
    expect(sameZone).not.toContain("clinic time");
    expect(sameOffset).not.toContain("clinic time");
  });

  it("puts the formatted time into reminder emails", () => {
    const email = reminderEmail("T2H", {
      patientName: "Ana Silva",
      patientZone: "Asia/Tokyo",
      clinicName: "Harbour Clinic",
      clinicZone: "America/Los_Angeles",
      providerName: "Dr. Lee",
      startsAt: utc("2026-03-10T16:00:00"),
    });
    expect(email.subject).toBe("Reminder: your appointment with Dr. Lee is in 2 hours");
    expect(email.text).toContain("Harbour Clinic on Wednesday, March 11, 2026 at 1:00 AM GMT+9");
    expect(email.text).toContain("9:00 AM PDT clinic time");
  });
});

describe("reminder send decisions", () => {
  const startsAt = utc("2026-07-10T14:00:00");
  const base = { appointmentStatus: "BOOKED" as const, startsAt };

  it("sends a reminder that is due and still relevant", () => {
    const now = utc("2026-07-10T12:10:00");
    const scheduledFor = startsAt.minus({ hours: 2 });
    expect(decideReminderAction({ ...base, scheduledFor, now })).toBe("send");
  });

  it("skips reminders for appointments that are no longer booked", () => {
    const now = utc("2026-07-10T12:00:00");
    const scheduledFor = startsAt.minus({ hours: 2 });
    const cancelled = { ...base, appointmentStatus: "CANCELLED" as const };
    expect(decideReminderAction({ ...cancelled, scheduledFor, now })).toBe("skip");
  });

  it("skips reminders more than 30 minutes late but sends one exactly 30 minutes late", () => {
    const scheduledFor = startsAt.minus({ hours: 24 });
    const thirty = scheduledFor.plus({ minutes: 30 });
    expect(decideReminderAction({ ...base, scheduledFor, now: thirty })).toBe("send");
    const later = thirty.plus({ seconds: 1 });
    expect(decideReminderAction({ ...base, scheduledFor, now: later })).toBe("skip");
  });

  it("skips once the appointment has started", () => {
    const scheduledFor = startsAt.minus({ minutes: 10 });
    expect(decideReminderAction({ ...base, scheduledFor, now: startsAt })).toBe("skip");
  });

  it("gives up after the fifth failed attempt", () => {
    expect([1, 2, 3, 4, 5].map(statusAfterFailure)).toEqual([
      "PENDING",
      "PENDING",
      "PENDING",
      "PENDING",
      "FAILED",
    ]);
  });
});
