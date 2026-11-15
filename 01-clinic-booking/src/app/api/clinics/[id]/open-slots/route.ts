import { requireActor } from "@/server/auth/guards";
import { clock } from "@/server/clock";
import { isoInstant } from "@/server/dates";
import { json, readQuery, route } from "@/server/http";
import { openSlotsQuery } from "@/server/schemas";
import { parseId } from "@/server/validation";
import { getClinicOpenSlots } from "@/services/slots";

export const GET = route<{ id: string }>(async ({ req, params }) => {
  const actor = await requireActor(req);
  const clinicId = parseId(params.id, "Clinic");
  const { date } = readQuery(req, openSlotsQuery);
  const result = await getClinicOpenSlots(actor, clinicId, date, clock.now());
  return json({
    timezone: result.timezone,
    date,
    providers: result.providers.map((provider) => ({
      providerId: provider.providerId,
      slots: provider.slots.map((slot) => ({
        startsAt: isoInstant(slot.startsAt),
        endsAt: isoInstant(slot.endsAt),
      })),
    })),
  });
});
