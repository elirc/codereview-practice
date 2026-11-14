import { requireActor } from "@/server/auth/guards";
import { json, route } from "@/server/http";
import { serializeAppointment } from "@/server/serialize";
import { parseId } from "@/server/validation";
import { getAppointment } from "@/services/appointments";

export const GET = route<{ id: string }>(async ({ req, params }) => {
  const actor = await requireActor(req);
  const appointment = await getAppointment(actor, parseId(params.id, "Appointment"));
  return json({ appointment: serializeAppointment(appointment) });
});
