import { isClinicStaff, type Actor } from "@/server/auth/actor";
import { db } from "@/server/db";
import { forbidden, notFound } from "@/server/errors";

/** Finds the patient registered with `email`, for staff booking on a patient's behalf. */
export async function findPatientByEmail(actor: Actor, email: string) {
  if (!isClinicStaff(actor)) throw forbidden();
  const patient = await db.patient.findFirst({ where: { user: { email } } });
  if (!patient) throw notFound("Patient");
  return patient;
}
