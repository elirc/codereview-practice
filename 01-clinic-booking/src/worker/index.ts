import PgBoss from "pg-boss";
import { clock } from "@/server/clock";
import { db } from "@/server/db";
import { env } from "@/server/env";
import {
  ensureQueues,
  QUEUES,
  type NotificationSendJob,
  type ReminderSendJob,
} from "@/server/jobs";
import { logger, type Logger } from "@/server/logger";
import { createMailer } from "@/server/mailer";
import type { Enqueue } from "./context";
import { dispatchNotifications, sendNotification } from "./notifications";
import { dispatchReminders, sendReminder } from "./reminders";

const DISPATCH_CRON = "* * * * *";
const WITH_METADATA = { includeMetadata: true } as const;

async function runJob<T>(
  job: PgBoss.JobWithMetadata<T>,
  work: (log: Logger) => Promise<void>,
): Promise<void> {
  const log = logger.child({ jobId: job.id, queue: job.name, attempt: job.retryCount + 1 });
  log.info("job started");
  try {
    await work(log);
    log.info("job finished");
  } catch (err) {
    log.error({ err }, "job failed");
    throw err;
  }
}

async function main(): Promise<void> {
  const boss = new PgBoss({ connectionString: env.DATABASE_URL });
  boss.on("error", (err) => logger.error({ err }, "pg-boss error"));
  await boss.start();
  await ensureQueues(boss);
  const mailer = createMailer(env.MAILER, logger, env.MAIL_FROM);
  const enqueue: Enqueue = async (queue, data) => {
    await boss.send(queue, data);
  };

  await boss.work<object>(QUEUES.remindersDispatch, WITH_METADATA, async (batch) => {
    for (const job of batch) {
      await runJob(job, async (log) => {
        const now = clock.now();
        const reminders = await dispatchReminders({ db, log, now, enqueue });
        const notifications = await dispatchNotifications({ db, log, now, enqueue });
        log.info({ reminders, notifications }, "dispatch finished");
      });
    }
  });

  await boss.work<ReminderSendJob>(QUEUES.remindersSend, WITH_METADATA, async (batch) => {
    for (const job of batch) {
      await runJob(job, async (log) => {
        const { reminderId } = job.data;
        const outcome = await sendReminder({ db, mailer, log, now: clock.now() }, reminderId);
        log.info({ reminderId, outcome }, "reminder processed");
      });
    }
  });

  for (const queue of [QUEUES.emailCancellation, QUEUES.emailRescheduled]) {
    await boss.work<NotificationSendJob>(queue, WITH_METADATA, async (batch) => {
      for (const job of batch) {
        await runJob(job, async (log) => {
          const { notificationId } = job.data;
          const deps = { db, mailer, log, now: clock.now() };
          const outcome = await sendNotification(deps, notificationId);
          log.info({ notificationId, outcome }, "notification processed");
        });
      }
    });
  }

  await boss.schedule(QUEUES.remindersDispatch, DISPATCH_CRON);
  logger.info("worker started");

  const shutdown = async (signal: string) => {
    logger.info({ signal }, "worker stopping");
    await boss.stop({ graceful: true, timeout: 30_000 });
    await db.$disconnect();
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err: unknown) => {
  logger.fatal({ err }, "worker failed to start");
  process.exit(1);
});
