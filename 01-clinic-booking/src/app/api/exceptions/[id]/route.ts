import { requireActor } from "@/server/auth/guards";
import { clock } from "@/server/clock";
import { json, route } from "@/server/http";
import { parseId } from "@/server/validation";
import { deleteException } from "@/services/availability";

export const DELETE = route<{ id: string }>(async ({ req, params }) => {
  const actor = await requireActor(req);
  const exceptionId = parseId(params.id, "Availability exception");
  const result = await deleteException(actor, exceptionId, clock.now());
  return json({ affectedAppointments: result.affectedAppointments });
});
