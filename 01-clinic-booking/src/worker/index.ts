import PgBoss from "pg-boss";
import { clock } from "@/server/clock";
import { db } from "@/server/db";
import { env } from "@/server/env";
import {
  ensureQueues,
  QUEUES,
  type AppointmentEmailJob,
  type ReminderSendJob,
} from "@/server/jobs";
import { logger, type Logger } from "@/server/logger";
import { createMailer } from "@/server/mailer";
import { sendAppointmentEmail, type AppointmentEmailKind } from "./emails";
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

  await boss.work<object>(QUEUES.remindersDispatch, WITH_METADATA, async (batch) => {
    for (const job of batch) {
      await runJob(job, async (log) => {
        const result = await dispatchReminders({
          db,
          log,
          now: clock.now(),
          enqueueSend: async (reminderId) => {
            const data: ReminderSendJob = { reminderId };
            await boss.send(QUEUES.remindersSend, data, { singletonKey: reminderId });
          },
        });
        log.info(result, "reminders dispatched");
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

  const emailQueues: [string, AppointmentEmailKind][] = [
    [QUEUES.emailCancellation, "cancellation"],
    [QUEUES.emailRescheduled, "rescheduled"],
  ];
  for (const [queue, kind] of emailQueues) {
    await boss.work<AppointmentEmailJob>(queue, WITH_METADATA, async (batch) => {
      for (const job of batch) {
        await runJob(job, async (log) => {
          const { appointmentId } = job.data;
          const outcome = await sendAppointmentEmail({ db, mailer, log }, kind, appointmentId);
          log.info({ appointmentId, outcome }, "appointment email processed");
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
