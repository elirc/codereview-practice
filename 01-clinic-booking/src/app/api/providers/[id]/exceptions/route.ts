import { requireActor } from "@/server/auth/guards";
import { clock } from "@/server/clock";
import { json, readJson, route } from "@/server/http";
import { createExceptionBody } from "@/server/schemas";
import { serializeException } from "@/server/serialize";
import { parseId } from "@/server/validation";
import { createException, listExceptions } from "@/services/availability";

export const GET = route<{ id: string }>(async ({ req, params }) => {
  const actor = await requireActor(req);
  const exceptions = await listExceptions(actor, parseId(params.id, "Provider"));
  return json({ exceptions: exceptions.map(serializeException) });
});

export const POST = route<{ id: string }>(async ({ req, params }) => {
  const actor = await requireActor(req);
  const providerId = parseId(params.id, "Provider");
  const input = await readJson(req, createExceptionBody);
  const result = await createException(actor, providerId, input, clock.now());
  return json(
    {
      exception: serializeException(result.exception),
      affectedAppointments: result.affectedAppointments,
    },
    201,
  );
});
