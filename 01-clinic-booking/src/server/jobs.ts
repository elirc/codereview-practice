import type PgBoss from "pg-boss";

export const QUEUES = {
  remindersDispatch: "reminders.dispatch",
  remindersSend: "reminders.send",
  emailCancellation: "email.cancellation",
  emailRescheduled: "email.rescheduled",
} as const;

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

export interface ReminderSendJob {
  reminderId: string;
}

export interface NotificationSendJob {
  notificationId: string;
}

/** pg-boss 10 refuses to send to or work a queue that has not been created. */
export async function ensureQueues(boss: PgBoss): Promise<void> {
  for (const name of Object.values(QUEUES)) {
    if (!(await boss.getQueue(name))) await boss.createQueue(name);
  }
}
