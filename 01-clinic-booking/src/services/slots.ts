import type { DateTime } from "luxon";
import { annotateSlots, type AnnotatedSlot } from "@/domain/slots";
import { addDays, enumerateDates, localDayStart, type LocalDate } from "@/domain/time";
import { fromDbInstant } from "@/server/dates";
import { db } from "@/server/db";
import { notFound } from "@/server/errors";
import { loadSchedule, scheduleSlots } from "./schedule";

export interface ProviderSlots {
  timezone: string;
  days: { date: LocalDate; slots: AnnotatedSlot[] }[];
}

/** Slots for each clinic-local date in `[from, to]`, with availability as a patient sees it. */
export async function getProviderSlots(
  providerId: string,
  from: LocalDate,
  to: LocalDate,
  now: DateTime,
): Promise<ProviderSlots> {
  const provider = await db.provider.findUnique({
    where: { id: providerId },
    include: { clinic: true },
  });
  if (!provider) throw notFound("Provider");

  const zone = provider.clinic.timezone;
  const dates = enumerateDates(from, to);
  if (!provider.active) {
    return { timezone: zone, days: dates.map((date) => ({ date, slots: [] })) };
  }

  const schedule = await loadSchedule(db, providerId, from, to);
  const rangeStart = localDayStart(from, zone);
  const rangeEnd = localDayStart(addDays(to, 1), zone);
  const booked = await db.appointment.findMany({
    where: {
      providerId,
      status: "BOOKED",
      startsAt: { lt: rangeEnd.toJSDate() },
      endsAt: { gt: rangeStart.toJSDate() },
    },
    select: { startsAt: true, endsAt: true },
  });
  const bookedRanges = booked.map((a) => ({
    startsAt: fromDbInstant(a.startsAt),
    endsAt: fromDbInstant(a.endsAt),
  }));

  const window = {
    now,
    zone,
    minLeadMinutes: provider.clinic.minLeadMinutes,
    bookingHorizonDays: provider.clinic.bookingHorizonDays,
  };
  return {
    timezone: zone,
    days: dates.map((date) => ({
      date,
      slots: annotateSlots(scheduleSlots(schedule, date, zone), window, bookedRanges),
    })),
  };
}
