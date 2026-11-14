import type { Appointment } from "@prisma/client";
import { cancellationEmail, rescheduledEmail, type EmailContent } from "@/domain/emails";
import { fromDbInstant } from "@/server/dates";
import {
  emailAppointmentInclude,
  emailContext,
  type EmailAppointment,
  type WorkerDeps,
} from "./context";

export type AppointmentEmailKind = "cancellation" | "rescheduled";

/** Sends a cancellation or reschedule notice. Mail errors propagate so pg-boss retries the job. */
export async function sendAppointmentEmail(
  deps: WorkerDeps,
  kind: AppointmentEmailKind,
  appointmentId: string,
): Promise<"sent" | "missing"> {
  const appointment = await deps.db.appointment.findUnique({
    where: { id: appointmentId },
    include: { ...emailAppointmentInclude, rescheduledFrom: true },
  });
  if (!appointment) {
    deps.log.warn({ appointmentId, kind }, "appointment for email no longer exists");
    return "missing";
  }

  const content = buildContent(kind, appointment);
  await deps.mailer.send({ to: appointment.patient.user.email, ...content });
  return "sent";
}

function buildContent(
  kind: AppointmentEmailKind,
  appointment: EmailAppointment & { rescheduledFrom: Appointment | null },
): EmailContent {
  const ctx = emailContext(appointment);
  if (kind === "cancellation") return cancellationEmail(ctx);
  const previous = appointment.rescheduledFrom?.startsAt;
  return rescheduledEmail(ctx, previous ? fromDbInstant(previous) : null);
}
