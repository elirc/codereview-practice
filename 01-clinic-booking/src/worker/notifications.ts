import type { Appointment, NotificationKind, Prisma } from "@prisma/client";
import { cancellationEmail, rescheduledEmail, type EmailContent } from "@/domain/emails";
import { CLAIM_TIMEOUT_MINUTES, statusAfterFailure } from "@/domain/reminders";
import { fromDbInstant, isoInstant } from "@/server/dates";
import { QUEUES, type NotificationSendJob } from "@/server/jobs";
import {
  describeError,
  DISPATCH_BATCH_SIZE,
  emailAppointmentInclude,
  emailContext,
  type DispatchDeps,
  type DispatchResult,
  type EmailAppointment,
  type SendDeps,
  type SendOutcome,
} from "./context";

const QUEUE_FOR_KIND = {
  CANCELLATION: QUEUES.emailCancellation,
  RESCHEDULED: QUEUES.emailRescheduled,
} as const;

/**
 * Returns abandoned claims to the queue, claims pending appointment notifications and enqueues
 * one email job for each on the queue for its kind.
 */
export async function dispatchNotifications(deps: DispatchDeps): Promise<DispatchResult> {
  const { db, now, log } = deps;
  const claimTimeout = now.minus({ minutes: CLAIM_TIMEOUT_MINUTES }).toJSDate();
  const { count: reset } = await db.appointmentNotification.updateMany({
    where: { status: "SENDING", claimedAt: { lt: claimTimeout } },
    data: { status: "PENDING", claimedAt: null },
  });

  const nowIso = isoInstant(now);
  const claimed = await db.$queryRaw<{ id: string; kind: NotificationKind }[]>`
    UPDATE appointment_notifications
    SET status = 'SENDING', claimed_at = ${nowIso}::timestamptz
    WHERE id IN (
      SELECT id FROM appointment_notifications
      WHERE status = 'PENDING'
      ORDER BY created_at
      LIMIT ${DISPATCH_BATCH_SIZE}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, kind::text AS kind`;

  let enqueued = 0;
  for (const { id, kind } of claimed) {
    try {
      const job: NotificationSendJob = { notificationId: id };
      await deps.enqueue(QUEUE_FOR_KIND[kind], job);
      enqueued += 1;
    } catch (err) {
      log.error({ err, notificationId: id }, "failed to enqueue notification send");
    }
  }
  return { reset, claimed: claimed.length, enqueued };
}

function updateIfSending(
  deps: SendDeps,
  notificationId: string,
  data: Prisma.AppointmentNotificationUpdateManyMutationInput,
) {
  return deps.db.appointmentNotification.updateMany({
    where: { id: notificationId, status: "SENDING" },
    data,
  });
}

function buildContent(
  kind: NotificationKind,
  appointment: EmailAppointment & { rescheduledFrom: Appointment | null },
): EmailContent {
  const ctx = emailContext(appointment);
  if (kind === "CANCELLATION") return cancellationEmail(ctx);
  const previous = appointment.rescheduledFrom?.startsAt;
  return rescheduledEmail(ctx, previous ? fromDbInstant(previous) : null);
}

/**
 * Delivers one claimed cancellation or reschedule notice. Mail failures are recorded on the
 * row and not thrown; any other error propagates so the job is retried.
 */
export async function sendNotification(
  deps: SendDeps,
  notificationId: string,
): Promise<SendOutcome> {
  const { db, mailer, now, log } = deps;
  const notification = await db.appointmentNotification.findUnique({
    where: { id: notificationId },
    include: { appointment: { include: { ...emailAppointmentInclude, rescheduledFrom: true } } },
  });
  if (!notification || notification.status !== "SENDING") return "ignored";

  const { appointment } = notification;
  const content = buildContent(notification.kind, appointment);
  try {
    await mailer.send({ to: appointment.patient.user.email, ...content });
  } catch (err) {
    const attempts = notification.attempts + 1;
    const status = statusAfterFailure(attempts);
    await updateIfSending(deps, notificationId, {
      status,
      attempts,
      lastError: describeError(err),
      claimedAt: null,
    });
    log.warn({ err, notificationId, attempts, status }, "notification delivery failed");
    return status === "FAILED" ? "failed" : "retry";
  }

  await updateIfSending(deps, notificationId, { status: "SENT", sentAt: now.toJSDate() });
  return "sent";
}
