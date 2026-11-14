import type { DateTime } from "luxon";

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
