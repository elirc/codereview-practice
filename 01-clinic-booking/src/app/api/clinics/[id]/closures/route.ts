import { requireActor } from "@/server/auth/guards";
import { clock } from "@/server/clock";
import { json, readJson, route } from "@/server/http";
import { closeDayBody } from "@/server/schemas";
import { serializeException } from "@/server/serialize";
import { parseId } from "@/server/validation";
import { closeProviderDay } from "@/services/closures";

export const POST = route<{ id: string }>(async ({ req, params }) => {
  const actor = await requireActor(req);
  const clinicId = parseId(params.id, "Clinic");
  const input = await readJson(req, closeDayBody);
  const result = await closeProviderDay(actor, clinicId, input, clock.now());
  return json(
    {
      exception: serializeException(result.exception),
      cancelledAppointments: result.cancelledAppointments,
    },
    201,
  );
});
