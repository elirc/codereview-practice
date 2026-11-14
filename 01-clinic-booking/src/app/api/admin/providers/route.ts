import { requireActor, requireRole } from "@/server/auth/guards";
import { json, readJson, route } from "@/server/http";
import { createProviderBody } from "@/server/schemas";
import { serializeProviderAccount } from "@/server/serialize";
import { createProvider, listAllProviders } from "@/services/admin";

export const GET = route(async ({ req }) => {
  const actor = await requireActor(req);
  requireRole(actor, "ADMIN");
  const providers = await listAllProviders(actor);
  return json({ providers: providers.map(serializeProviderAccount) });
});

export const POST = route(async ({ req }) => {
  const actor = await requireActor(req);
  requireRole(actor, "ADMIN");
  const input = await readJson(req, createProviderBody);
  const provider = await createProvider(actor, input);
  return json({ provider: serializeProviderAccount(provider) }, 201);
});
