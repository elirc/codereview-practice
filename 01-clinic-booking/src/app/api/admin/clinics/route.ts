import { requireActor, requireRole } from "@/server/auth/guards";
import { json, readJson, route } from "@/server/http";
import { createClinicBody } from "@/server/schemas";
import { serializeClinic } from "@/server/serialize";
import { createClinic } from "@/services/admin";
import { listClinics } from "@/services/clinics";

export const GET = route(async ({ req }) => {
  const actor = await requireActor(req);
  requireRole(actor, "ADMIN");
  const clinics = await listClinics();
  return json({ clinics: clinics.map(serializeClinic) });
});

export const POST = route(async ({ req }) => {
  const actor = await requireActor(req);
  requireRole(actor, "ADMIN");
  const input = await readJson(req, createClinicBody);
  const clinic = await createClinic(actor, input);
  return json({ clinic: serializeClinic(clinic) }, 201);
});
