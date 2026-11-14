import type { Appointment, Clinic, Patient, PrismaClient, Provider, User } from "@prisma/client";
import type { DateTime } from "luxon";
import type { AppointmentEmailContext } from "@/domain/emails";
import { fromDbInstant } from "@/server/dates";
import type { QueueName } from "@/server/jobs";
import type { Logger } from "@/server/logger";
import type { Mailer } from "@/server/mailer";

export const DISPATCH_BATCH_SIZE = 100;

export interface WorkerDeps {
  db: PrismaClient;
  mailer: Mailer;
  log: Logger;
}

export type Enqueue = (queue: QueueName, data: object) => Promise<void>;

export interface DispatchDeps extends Omit<WorkerDeps, "mailer"> {
  now: DateTime;
  enqueue: Enqueue;
}

export interface DispatchResult {
  reset: number;
  claimed: number;
  enqueued: number;
}

export interface SendDeps extends WorkerDeps {
  now: DateTime;
}

export type SendOutcome = "sent" | "skipped" | "retry" | "failed" | "ignored";

export function describeError(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 500);
}

export const emailAppointmentInclude = {
  patient: { include: { user: true } },
  provider: { include: { clinic: true } },
} as const;

export type EmailAppointment = Appointment & {
  patient: Patient & { user: User };
  provider: Provider & { clinic: Clinic };
};

export function emailContext(appointment: EmailAppointment): AppointmentEmailContext {
  return {
    patientName: appointment.patient.fullName,
    patientZone: appointment.patient.timezone,
    clinicName: appointment.provider.clinic.name,
    clinicZone: appointment.provider.clinic.timezone,
    providerName: appointment.provider.displayName,
    startsAt: fromDbInstant(appointment.startsAt),
  };
}
