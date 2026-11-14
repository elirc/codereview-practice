import { requireActor } from "@/server/auth/guards";
import { json, route } from "@/server/http";
import { serializeProvider } from "@/server/serialize";
import { parseId } from "@/server/validation";
import { listClinicProviders } from "@/services/clinics";

export const GET = route<{ id: string }>(async ({ req, params }) => {
  const actor = await requireActor(req);
  const providers = await listClinicProviders(actor, parseId(params.id, "Clinic"));
  return json({ providers: providers.map(serializeProvider) });
});
