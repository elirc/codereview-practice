import type { Prisma } from "@prisma/client";
import type { DateTime } from "luxon";
import { reminderEmail } from "@/domain/emails";
import {
  CLAIM_TIMEOUT_MINUTES,
  decideReminderAction,
  statusAfterFailure,
} from "@/domain/reminders";
import { fromDbInstant, isoInstant } from "@/server/dates";
import { emailAppointmentInclude, emailContext, type WorkerDeps } from "./context";

export const DISPATCH_BATCH_SIZE = 100;

export interface DispatchDeps extends Omit<WorkerDeps, "mailer"> {
  now: DateTime;
  enqueueSend(reminderId: string): Promise<void>;
}

export interface DispatchResult {
  reset: number;
  claimed: number;
  enqueued: number;
}

/**
 * Returns abandoned claims to the queue, claims the next batch of due reminders and enqueues a
 * send job for each. A claim whose send job is never enqueued is picked up again after the
 * claim timeout.
 */
export async function dispatchReminders(deps: DispatchDeps): Promise<DispatchResult> {
  const { db, now, log } = deps;
  const claimTimeout = now.minus({ minutes: CLAIM_TIMEOUT_MINUTES }).toJSDate();
  const { count: reset } = await db.reminder.updateMany({
    where: { status: "SENDING", claimedAt: { lt: claimTimeout } },
    data: { status: "PENDING", claimedAt: null },
  });

  const nowIso = isoInstant(now);
  const claimed = await db.$queryRaw<{ id: string }[]>`
    UPDATE reminders
    SET status = 'SENDING', claimed_at = ${nowIso}::timestamptz
    WHERE id IN (
      SELECT id FROM reminders
      WHERE status = 'PENDING' AND scheduled_for <= ${nowIso}::timestamptz
      ORDER BY scheduled_for
      LIMIT ${DISPATCH_BATCH_SIZE}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id`;

  let enqueued = 0;
  for (const { id } of claimed) {
    try {
      await deps.enqueueSend(id);
      enqueued += 1;
    } catch (err) {
      log.error({ err, reminderId: id }, "failed to enqueue reminder send");
    }
  }
  return { reset, claimed: claimed.length, enqueued };
}

export interface SendDeps extends WorkerDeps {
  now: DateTime;
}

export type SendOutcome = "sent" | "skipped" | "retry" | "failed" | "ignored";

function updateIfSending(
  deps: SendDeps,
  reminderId: string,
  data: Prisma.ReminderUpdateManyMutationInput,
) {
  return deps.db.reminder.updateMany({ where: { id: reminderId, status: "SENDING" }, data });
}

function describeError(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 500);
}

/**
 * Delivers one claimed reminder. Mail failures are recorded on the row and not thrown; any
 * other error propagates so the job is retried.
 */
export async function sendReminder(deps: SendDeps, reminderId: string): Promise<SendOutcome> {
  const { db, mailer, now, log } = deps;
  const reminder = await db.reminder.findUnique({
    where: { id: reminderId },
    include: { appointment: { include: emailAppointmentInclude } },
  });
  if (!reminder || reminder.status !== "SENDING") return "ignored";

  const { appointment } = reminder;
  const action = decideReminderAction({
    scheduledFor: fromDbInstant(reminder.scheduledFor),
    appointmentStatus: appointment.status,
    startsAt: fromDbInstant(appointment.startsAt),
    now,
  });
  if (action === "skip") {
    await updateIfSending(deps, reminderId, { status: "SKIPPED" });
    return "skipped";
  }

  const content = reminderEmail(reminder.kind, emailContext(appointment));
  try {
    await mailer.send({ to: appointment.patient.user.email, ...content });
  } catch (err) {
    const attempts = reminder.attempts + 1;
    const status = statusAfterFailure(attempts);
    await updateIfSending(deps, reminderId, {
      status,
      attempts,
      lastError: describeError(err),
      claimedAt: null,
    });
    log.warn({ err, reminderId, attempts, status }, "reminder delivery failed");
    return status === "FAILED" ? "failed" : "retry";
  }

  await updateIfSending(deps, reminderId, { status: "SENT", sentAt: now.toJSDate() });
  return "sent";
}
