import { requireActor } from "@/server/auth/guards";
import { clock } from "@/server/clock";
import { json, readJson, route } from "@/server/http";
import { updateAppointmentBody } from "@/server/schemas";
import { serializeAppointment } from "@/server/serialize";
import { parseId } from "@/server/validation";
import { getAppointment, updateAppointmentReason } from "@/services/appointments";

export const GET = route<{ id: string }>(async ({ req, params }) => {
  const actor = await requireActor(req);
  const appointment = await getAppointment(actor, parseId(params.id, "Appointment"));
  return json({ appointment: serializeAppointment(appointment) });
});

export const PATCH = route<{ id: string }>(async ({ req, params }) => {
  const actor = await requireActor(req);
  const id = parseId(params.id, "Appointment");
  const { reason } = await readJson(req, updateAppointmentBody);
  const appointment = await updateAppointmentReason(actor, id, reason || null, clock.now());
  return json({ appointment: serializeAppointment(appointment) });
});
