import { requireActor, requireRole } from "@/server/auth/guards";
import { json, readJson, route } from "@/server/http";
import { updateClinicBody } from "@/server/schemas";
import { serializeClinic } from "@/server/serialize";
import { parseId } from "@/server/validation";
import { updateClinic } from "@/services/admin";

export const PATCH = route<{ id: string }>(async ({ req, params }) => {
  const actor = await requireActor(req);
  requireRole(actor, "ADMIN");
  const clinicId = parseId(params.id, "Clinic");
  const patch = await readJson(req, updateClinicBody);
  const clinic = await updateClinic(actor, clinicId, patch);
  return json({ clinic: serializeClinic(clinic) });
});
