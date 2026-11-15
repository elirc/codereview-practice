import { requireActor } from "@/server/auth/guards";
import { json, readQuery, route } from "@/server/http";
import { patientLookupQuery } from "@/server/schemas";
import { serializePatient } from "@/server/serialize";
import { findPatientByEmail } from "@/services/patients";

export const GET = route(async ({ req }) => {
  const actor = await requireActor(req);
  const { email } = readQuery(req, patientLookupQuery);
  const patient = await findPatientByEmail(actor, email);
  return json({ patient: serializePatient(patient) });
});
