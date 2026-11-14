import { requireActor } from "@/server/auth/guards";
import { clock } from "@/server/clock";
import { json, readJson, route } from "@/server/http";
import { cancelBody } from "@/server/schemas";
import { serializeAppointment } from "@/server/serialize";
import { parseId } from "@/server/validation";
import { cancelAppointment } from "@/services/appointments";

export const POST = route<{ id: string }>(async ({ req, params }) => {
  const actor = await requireActor(req);
  const id = parseId(params.id, "Appointment");
  const { reason } = await readJson(req, cancelBody);
  const appointment = await cancelAppointment(actor, id, reason ?? null, clock.now());
  return json({ appointment: serializeAppointment(appointment) });
});
