import type { Appointment, Clinic, Patient, PrismaClient, Provider, User } from "@prisma/client";
import type { AppointmentEmailContext } from "@/domain/emails";
import { fromDbInstant } from "@/server/dates";
import type { Logger } from "@/server/logger";
import type { Mailer } from "@/server/mailer";

export interface WorkerDeps {
  db: PrismaClient;
  mailer: Mailer;
  log: Logger;
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
