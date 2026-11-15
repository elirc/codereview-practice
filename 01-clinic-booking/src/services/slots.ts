import type { DateTime } from "luxon";
import { annotateSlots, type AnnotatedSlot, type Slot } from "@/domain/slots";
import { addDays, enumerateDates, localDayStart, type LocalDate } from "@/domain/time";
import type { Actor } from "@/server/auth/actor";
import { fromDbInstant, toDbDate } from "@/server/dates";
import { db } from "@/server/db";
import { forbidden, notFound } from "@/server/errors";
import { getClinic } from "./clinics";
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

export interface ClinicOpenSlots {
  timezone: string;
  providers: { providerId: string; slots: Slot[] }[];
}

/**
 * Unbooked slots that have not started yet on a clinic-local date, for each active provider of
 * the clinic. Staff book without the online lead time, so it is not applied here.
 */
export async function getClinicOpenSlots(
  actor: Actor,
  clinicId: string,
  date: LocalDate,
  now: DateTime,
): Promise<ClinicOpenSlots> {
  if (actor.role !== "ADMIN" && !(actor.role === "STAFF" && actor.clinicId === clinicId)) {
    throw forbidden();
  }
  const clinic = await getClinic(clinicId);
  const providers = await db.provider.findMany({
    where: { clinicId, active: true },
    orderBy: { displayName: "asc" },
  });
  const booked = await db.appointment.findMany({
    where: {
      providerId: { in: providers.map((provider) => provider.id) },
      status: "BOOKED",
      startsAt: { gte: toDbDate(date), lt: toDbDate(addDays(date, 1)) },
    },
    select: { providerId: true, startsAt: true, endsAt: true },
  });

  const result: ClinicOpenSlots["providers"] = [];
  for (const provider of providers) {
    const schedule = await loadSchedule(db, provider.id, date, date);
    const taken = booked.filter((appointment) => appointment.providerId === provider.id);
    const slots = scheduleSlots(schedule, date, clinic.timezone).filter((slot) => {
      const start = slot.startsAt.toMillis();
      const end = slot.endsAt.toMillis();
      if (start <= now.toMillis()) return false;
      return !taken.some(
        (appointment) =>
          start <= appointment.endsAt.getTime() && appointment.startsAt.getTime() <= end,
      );
    });
    result.push({ providerId: provider.id, slots });
  }
  return { timezone: clinic.timezone, providers: result };
}
