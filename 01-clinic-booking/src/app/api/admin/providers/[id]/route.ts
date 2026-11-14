import { requireActor, requireRole } from "@/server/auth/guards";
import { json, readJson, route } from "@/server/http";
import { updateProviderBody } from "@/server/schemas";
import { serializeProviderAccount } from "@/server/serialize";
import { parseId } from "@/server/validation";
import { updateProvider } from "@/services/admin";

export const PATCH = route<{ id: string }>(async ({ req, params }) => {
  const actor = await requireActor(req);
  requireRole(actor, "ADMIN");
  const providerId = parseId(params.id, "Provider");
  const patch = await readJson(req, updateProviderBody);
  const provider = await updateProvider(actor, providerId, patch);
  return json({ provider: serializeProviderAccount(provider) });
});
