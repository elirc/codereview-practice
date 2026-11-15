import { requireActor } from "@/server/auth/guards";
import { clock } from "@/server/clock";
import { isoInstant } from "@/server/dates";
import { json, readJson, route } from "@/server/http";
import { bookingBody } from "@/server/schemas";
import { checkBooking } from "@/services/booking";

export const POST = route(async ({ req }) => {
  const actor = await requireActor(req);
  const input = await readJson(req, bookingBody);
  const slot = await checkBooking(actor, input, clock.now());
  return json({ slot: { startsAt: isoInstant(slot.startsAt), endsAt: isoInstant(slot.endsAt) } });
});
