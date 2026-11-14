import { requireActor, requireRole } from "@/server/auth/guards";
import { json, readJson, route } from "@/server/http";
import { createStaffBody } from "@/server/schemas";
import { serializeStaff } from "@/server/serialize";
import { createStaff } from "@/services/admin";

export const POST = route(async ({ req }) => {
  const actor = await requireActor(req);
  requireRole(actor, "ADMIN");
  const input = await readJson(req, createStaffBody);
  const staff = await createStaff(actor, input);
  return json({ staff: serializeStaff(staff) }, 201);
});
