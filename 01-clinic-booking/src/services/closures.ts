import type { DateTime } from "luxon";
import { evaluateCancellation } from "@/domain/policies";
import { localDayStart, type LocalDate } from "@/domain/time";
import type { Actor } from "@/server/auth/actor";
import { fromDbInstant, toDbDate } from "@/server/dates";
import { db, LOCKING_TX_OPTIONS } from "@/server/db";
import { isUniqueViolation } from "@/server/db-errors";
import { forbidden, notFound } from "@/server/errors";
import { cancellerRole } from "./access";
import { exceptionExists, lockProvider } from "./availability";
import { getClinic } from "./clinics";

export interface CloseDayInput {
  providerId: string;
  localDate: LocalDate;
  reason?: string;
}

const DEFAULT_CLOSURE_REASON = "The provider is unavailable on this day.";

function assertClinicManager(actor: Actor, clinicId: string): void {
  if (actor.role === "ADMIN") return;
  if (actor.role === "STAFF" && actor.clinicId === clinicId) return;
  throw forbidden();
}

/**
 * Closes a provider's clinic-local date with a `CLOSED` exception and cancels the bookings on it
 * that have not started yet. Returns the exception and the ids of the cancelled appointments.
 */
export async function closeProviderDay(
  actor: Actor,
  clinicId: string,
  input: CloseDayInput,
  now: DateTime,
) {
  assertClinicManager(actor, clinicId);
  const role = cancellerRole(actor);
  const clinic = await getClinic(clinicId);
  const provider = await db.provider.findUnique({ where: { id: input.providerId } });
  if (!provider) throw notFound("Provider");

  const dayStart = localDayStart(input.localDate, clinic.timezone);
  const dayEnd = dayStart.plus({ days: 1 });
  const localDate = toDbDate(input.localDate);
  const reason = input.reason ?? DEFAULT_CLOSURE_REASON;

  try {
    return await db.$transaction(async (tx) => {
      await lockProvider(tx, provider.id);
      const existing = await tx.availabilityException.findUnique({
        where: { providerId_localDate: { providerId: provider.id, localDate } },
      });
      if (existing) throw exceptionExists(input.localDate);
      const exception = await tx.availabilityException.create({
        data: { providerId: provider.id, localDate, kind: "CLOSED" },
      });

      const booked = await tx.appointment.findMany({
        where: {
          providerId: provider.id,
          status: "BOOKED",
          startsAt: { gte: dayStart.toJSDate(), lt: dayEnd.toJSDate() },
        },
        select: { id: true, startsAt: true },
        orderBy: { startsAt: "asc" },
      });

      const cancelled: string[] = [];
      for (const appointment of booked) {
        const decision = evaluateCancellation(role, fromDbInstant(appointment.startsAt), now);
        if (!decision.allowed) continue;
        await tx.appointment.update({
          where: { id: appointment.id },
          data: {
            status: "CANCELLED",
            cancelledAt: now.toJSDate(),
            cancelledByUserId: actor.userId,
            cancelReason: reason,
            lateCancel: decision.lateCancel,
          },
        });
        cancelled.push(appointment.id);
      }

      if (cancelled.length > 0) {
        await tx.reminder.updateMany({
          where: { appointmentId: { in: cancelled }, status: "PENDING" },
          data: { status: "SKIPPED" },
        });
        await tx.appointmentNotification.createMany({
          data: cancelled.map((appointmentId) => ({
            appointmentId,
            kind: "CANCELLATION" as const,
            createdAt: now.toJSDate(),
          })),
          skipDuplicates: true,
        });
      }
      return { exception, cancelledAppointments: cancelled };
    }, LOCKING_TX_OPTIONS);
  } catch (err) {
    if (isUniqueViolation(err)) throw exceptionExists(input.localDate);
    throw err;
  }
}
