import { requireActor } from "@/server/auth/guards";
import { clock } from "@/server/clock";
import { isoInstant } from "@/server/dates";
import { json, readQuery, route } from "@/server/http";
import { slotRangeQuery } from "@/server/schemas";
import { parseId } from "@/server/validation";
import { getProviderSlots } from "@/services/slots";

export const GET = route<{ id: string }>(async ({ req, params }) => {
  await requireActor(req);
  const providerId = parseId(params.id, "Provider");
  const { from, to } = readQuery(req, slotRangeQuery);
  const result = await getProviderSlots(providerId, from, to, clock.now());
  return json({
    timezone: result.timezone,
    days: result.days.map((day) => ({
      date: day.date,
      slots: day.slots.map((slot) => ({
        startsAt: isoInstant(slot.startsAt),
        endsAt: isoInstant(slot.endsAt),
        available: slot.available,
        ...(slot.reason ? { reason: slot.reason } : {}),
      })),
    })),
  });
});
