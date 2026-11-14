import { requireActor } from "@/server/auth/guards";
import { clock } from "@/server/clock";
import { json, route } from "@/server/http";
import { serializeAppointment } from "@/server/serialize";
import { parseId } from "@/server/validation";
import { recordOutcome } from "@/services/appointments";

export const POST = route<{ id: string }>(async ({ req, params }) => {
  const actor = await requireActor(req);
  const id = parseId(params.id, "Appointment");
  const appointment = await recordOutcome(actor, id, "NO_SHOW", clock.now());
  return json({ appointment: serializeAppointment(appointment) });
});
