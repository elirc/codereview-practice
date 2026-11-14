import { requireActor } from "@/server/auth/guards";
import { clock } from "@/server/clock";
import { json, readJson, route } from "@/server/http";
import { rescheduleBody } from "@/server/schemas";
import { serializeAppointment } from "@/server/serialize";
import { parseId } from "@/server/validation";
import { rescheduleAppointment } from "@/services/appointments";

export const POST = route<{ id: string }>(async ({ req, params }) => {
  const actor = await requireActor(req);
  const id = parseId(params.id, "Appointment");
  const input = await readJson(req, rescheduleBody);
  const appointment = await rescheduleAppointment(actor, id, input, clock.now());
  return json({ appointment: serializeAppointment(appointment) }, 201);
});
