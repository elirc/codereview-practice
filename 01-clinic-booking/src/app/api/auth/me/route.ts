import { requireActor } from "@/server/auth/guards";
import { json, route } from "@/server/http";
import { getProfile } from "@/services/auth";

export const GET = route(async ({ req }) => {
  const actor = await requireActor(req);
  return json({ user: await getProfile(actor) });
});
