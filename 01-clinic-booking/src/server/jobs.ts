import PgBoss from "pg-boss";
import { env } from "./env";
import { logger } from "./logger";

export const QUEUES = {
  remindersDispatch: "reminders.dispatch",
  remindersSend: "reminders.send",
  emailCancellation: "email.cancellation",
  emailRescheduled: "email.rescheduled",
} as const;

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

export type AppointmentEmailQueue =
  | typeof QUEUES.emailCancellation
  | typeof QUEUES.emailRescheduled;

export interface AppointmentEmailJob {
  appointmentId: string;
}

export interface ReminderSendJob {
  reminderId: string;
}

export const EMAIL_RETRY = { retryLimit: 3, retryDelay: 30, retryBackoff: true } as const;

/** pg-boss 10 refuses to send to or work a queue that has not been created. */
export async function ensureQueues(boss: PgBoss): Promise<void> {
  for (const name of Object.values(QUEUES)) {
    if (!(await boss.getQueue(name))) await boss.createQueue(name);
  }
}

let publisher: Promise<PgBoss> | undefined;

function getPublisher(): Promise<PgBoss> {
  publisher ??= (async () => {
    // The web process only enqueues; maintenance and cron belong to the worker.
    const boss = new PgBoss({
      connectionString: env.DATABASE_URL,
      supervise: false,
      schedule: false,
    });
    boss.on("error", (err) => logger.error({ err }, "pg-boss error"));
    await boss.start();
    await ensureQueues(boss);
    return boss;
  })().catch((err: unknown) => {
    publisher = undefined;
    throw err;
  });
  return publisher;
}

export const jobs = {
  async publish(name: QueueName, data: object, options: PgBoss.SendOptions = {}): Promise<void> {
    const boss = await getPublisher();
    await boss.send(name, data, options);
  },
};
