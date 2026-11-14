import { requireActor } from "@/server/auth/guards";
import { json, route } from "@/server/http";
import { serializeClinic } from "@/server/serialize";
import { listClinics } from "@/services/clinics";

export const GET = route(async ({ req }) => {
  await requireActor(req);
  const clinics = await listClinics();
  return json({ clinics: clinics.map(serializeClinic) });
});
