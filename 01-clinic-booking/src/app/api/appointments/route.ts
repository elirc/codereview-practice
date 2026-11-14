import { requireActor } from "@/server/auth/guards";
import { clock } from "@/server/clock";
import { validationError } from "@/server/errors";
import { json, readJson, readQuery, route } from "@/server/http";
import { appointmentListQuery, bookingBody, idempotencyKeyHeader } from "@/server/schemas";
import { serializeAppointment } from "@/server/serialize";
import { listAppointments } from "@/services/appointments";
import { bookAppointment } from "@/services/booking";

function readIdempotencyKey(req: Request): string | undefined {
  const raw = req.headers.get("idempotency-key");
  if (raw === null) return undefined;
  const parsed = idempotencyKeyHeader.safeParse(raw);
  if (!parsed.success) {
    throw validationError([{ path: "Idempotency-Key", message: "Must be 1 to 64 characters" }]);
  }
  return parsed.data;
}

export const GET = route(async ({ req }) => {
  const actor = await requireActor(req);
  const query = readQuery(req, appointmentListQuery);
  const appointments = await listAppointments(actor, query);
  return json({ appointments: appointments.map(serializeAppointment) });
});

export const POST = route(async ({ req }) => {
  const actor = await requireActor(req);
  const idempotencyKey = readIdempotencyKey(req);
  const input = await readJson(req, bookingBody);
  const result = await bookAppointment(actor, { ...input, idempotencyKey }, clock.now());
  const status = result.replayed ? 200 : 201;
  return json({ appointment: serializeAppointment(result.appointment) }, status);
});
