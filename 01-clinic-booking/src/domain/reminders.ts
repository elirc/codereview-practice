import type { DateTime } from "luxon";
import type { AppointmentStatus } from "./policies";

export type ReminderKind = "T24H" | "T2H";

const LEAD_HOURS: ReadonlyArray<[ReminderKind, number]> = [
  ["T24H", 24],
  ["T2H", 2],
];

export interface PlannedReminder {
  kind: ReminderKind;
  scheduledFor: DateTime;
}

/** Reminders for an appointment starting at `startsAt`, minus any whose send time has passed. */
export function planReminders(startsAt: DateTime, now: DateTime): PlannedReminder[] {
  const planned: PlannedReminder[] = [];
  for (const [kind, hours] of LEAD_HOURS) {
    const scheduledFor = startsAt.minus({ hours });
    if (scheduledFor.toMillis() > now.toMillis()) planned.push({ kind, scheduledFor });
  }
  return planned;
}

/** A reminder this far past its send time is no longer useful. */
export const STALE_AFTER_MINUTES = 30;
/** A claimed reminder not resolved within this long is returned to the queue. */
export const CLAIM_TIMEOUT_MINUTES = 10;
export const MAX_SEND_ATTEMPTS = 5;

export interface ReminderCheck {
  scheduledFor: DateTime;
  appointmentStatus: AppointmentStatus;
  startsAt: DateTime;
  now: DateTime;
}

export function decideReminderAction(check: ReminderCheck): "send" | "skip" {
  if (check.appointmentStatus !== "BOOKED") return "skip";
  const staleBefore = check.now.minus({ minutes: STALE_AFTER_MINUTES }).toMillis();
  if (check.scheduledFor.toMillis() < staleBefore) return "skip";
  if (check.now.toMillis() >= check.startsAt.toMillis()) return "skip";
  return "send";
}

/** Status after a failed delivery, given the attempt count including that failure. */
export function statusAfterFailure(attempts: number): "PENDING" | "FAILED" {
  return attempts < MAX_SEND_ATTEMPTS ? "PENDING" : "FAILED";
}
