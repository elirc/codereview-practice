import type { Patient, Provider, Role, User } from "@prisma/client";

/** The authenticated caller, resolved once per request from the session cookie. */
export interface Actor {
  userId: string;
  email: string;
  role: Role;
  clinicId: string | null;
  patientId: string | null;
  providerId: string | null;
}

export function toActor(
  user: User & { patient: Patient | null; provider: Provider | null },
): Actor {
  return {
    userId: user.id,
    email: user.email,
    role: user.role,
    clinicId: user.clinicId,
    patientId: user.patient?.id ?? null,
    providerId: user.provider?.id ?? null,
  };
}

export function isClinicStaff(actor: Actor): boolean {
  return actor.role === "STAFF" || actor.role === "ADMIN";
}
