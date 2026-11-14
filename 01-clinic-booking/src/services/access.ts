import type { Appointment, Clinic, Patient, Provider } from "@prisma/client";
import type { CancellerRole } from "@/domain/policies";
import type { Actor } from "@/server/auth/actor";
import { db } from "@/server/db";
import { forbidden, notFound } from "@/server/errors";

export const appointmentInclude = {
  provider: { include: { clinic: true } },
  patient: true,
} as const;

export type AppointmentView = Appointment & {
  provider: Provider & { clinic: Clinic };
  patient: Patient;
};

export function canViewAppointment(actor: Actor, appointment: AppointmentView): boolean {
  switch (actor.role) {
    case "ADMIN":
      return true;
    case "STAFF":
      return actor.clinicId !== null && appointment.provider.clinicId === actor.clinicId;
    case "PROVIDER":
      return actor.providerId !== null && appointment.providerId === actor.providerId;
    case "PATIENT":
      return actor.patientId !== null && appointment.patientId === actor.patientId;
  }
}

export async function getAppointmentView(id: string): Promise<AppointmentView> {
  return db.appointment.findUniqueOrThrow({ where: { id }, include: appointmentInclude });
}

/** Loads an appointment if the caller may view it. */
export async function loadVisibleAppointment(actor: Actor, id: string): Promise<AppointmentView> {
  const appointment = await db.appointment.findUnique({
    where: { id },
    include: appointmentInclude,
  });
  if (!appointment || !canViewAppointment(actor, appointment)) throw notFound("Appointment");
  return appointment;
}

/** Providers may view their appointments but cannot cancel or move them. */
export function cancellerRole(actor: Actor): CancellerRole {
  if (actor.role === "PROVIDER") throw forbidden();
  return actor.role;
}

export function assertCanRecordOutcome(actor: Actor): void {
  if (actor.role === "PATIENT") throw forbidden();
}
