import type { Actor } from "@/server/auth/actor";
import { db } from "@/server/db";
import { notFound } from "@/server/errors";

export function listClinics() {
  return db.clinic.findMany({ orderBy: { name: "asc" } });
}

export async function getClinic(clinicId: string) {
  const clinic = await db.clinic.findUnique({ where: { id: clinicId } });
  if (!clinic) throw notFound("Clinic");
  return clinic;
}

/** Patients only ever see providers who are currently taking bookings. */
export async function listClinicProviders(actor: Actor, clinicId: string) {
  await getClinic(clinicId);
  return db.provider.findMany({
    where: { clinicId, ...(actor.role === "PATIENT" ? { active: true } : {}) },
    orderBy: { displayName: "asc" },
  });
}
