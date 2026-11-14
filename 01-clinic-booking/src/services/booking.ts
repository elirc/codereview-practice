import type { Appointment } from "@prisma/client";
import type { DateTime } from "luxon";
import { checkBookingWindow, type BookingWindowViolation } from "@/domain/policies";
import { planReminders } from "@/domain/reminders";
import { findSlot } from "@/domain/slots";
import { localDateOf, localDayRange } from "@/domain/time";
import { isClinicStaff, type Actor } from "@/server/auth/actor";
import { db, LOCKING_TX_OPTIONS, type DbClient } from "@/server/db";
import { CONSTRAINTS, violatedConstraint } from "@/server/db-errors";
import { AppError, forbidden, notFound, validationError } from "@/server/errors";
import { getAppointmentView, type AppointmentView } from "./access";
import { loadSchedule, scheduleSlots } from "./schedule";

export interface BookingRequest {
  providerId: string;
  startsAt: DateTime;
  reason?: string;
  patientId?: string;
  idempotencyKey?: string;
}

export interface BookingResult {
  appointment: AppointmentView;
  replayed: boolean;
}

const WINDOW_MESSAGES: Record<BookingWindowViolation, string> = {
  in_past: "The requested time has already passed.",
  too_soon: "This slot starts too soon to be booked online.",
  beyond_horizon: "This slot is too far in the future to be booked yet.",
};

/** Locks the patient's row until the surrounding transaction ends. */
export async function lockPatient(tx: DbClient, patientId: string): Promise<void> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM patients WHERE id = ${patientId}::uuid FOR UPDATE`;
  if (rows.length === 0) throw notFound("Patient");
}

export interface InsertBookingArgs {
  actor: Actor;
  patientId: string;
  providerId: string;
  startsAt: DateTime;
  reason: string | null;
  idempotencyKey: string | null;
  rescheduledFromId: string | null;
  /** When set, the provider must belong to this clinic. */
  clinicId: string | null;
  now: DateTime;
}

/**
 * Validates a requested slot and inserts the appointment and its reminders. Must run inside a
 * transaction that already holds the patient lock.
 */
export async function insertBooking(tx: DbClient, args: InsertBookingArgs): Promise<Appointment> {
  const { actor, now } = args;
  const provider = await tx.provider.findUnique({
    where: { id: args.providerId },
    include: { clinic: true },
  });
  if (!provider || !provider.active) throw notFound("Provider");
  if (actor.role === "STAFF" && provider.clinicId !== actor.clinicId) throw forbidden();
  if (args.clinicId !== null && provider.clinicId !== args.clinicId) {
    throw new AppError(
      "provider_not_in_clinic",
      "Appointments can only move to a provider in the same clinic.",
    );
  }

  const { clinic } = provider;
  const zone = clinic.timezone;
  const date = localDateOf(args.startsAt, zone);
  const schedule = await loadSchedule(tx, provider.id, date, date);
  const slot = findSlot(scheduleSlots(schedule, date, zone), args.startsAt);
  if (!slot) {
    throw new AppError("not_a_slot", "The requested time is not a slot for this provider.");
  }

  const window = {
    now,
    zone,
    minLeadMinutes: clinic.minLeadMinutes,
    bookingHorizonDays: clinic.bookingHorizonDays,
  };
  const violation = checkBookingWindow(slot.startsAt, window, isClinicStaff(actor));
  if (violation) throw new AppError(violation, WINDOW_MESSAGES[violation]);

  const day = localDayRange(date, zone);
  const sameDay = await tx.appointment.count({
    where: {
      patientId: args.patientId,
      providerId: provider.id,
      status: "BOOKED",
      startsAt: { gte: day.start.toJSDate(), lt: day.end.toJSDate() },
    },
  });
  if (sameDay > 0) {
    throw new AppError(
      "daily_limit",
      "The patient already has an appointment with this provider on that day.",
    );
  }

  const appointment = await tx.appointment
    .create({
      data: {
        providerId: provider.id,
        patientId: args.patientId,
        startsAt: slot.startsAt.toJSDate(),
        endsAt: slot.endsAt.toJSDate(),
        reason: args.reason,
        bookedByUserId: actor.userId,
        rescheduledFromId: args.rescheduledFromId,
        idempotencyKey: args.idempotencyKey,
      },
    })
    .catch((err: unknown) => {
      throw overlapError(err);
    });

  const reminders = planReminders(slot.startsAt, now);
  if (reminders.length > 0) {
    await tx.reminder.createMany({
      data: reminders.map((reminder) => ({
        appointmentId: appointment.id,
        kind: reminder.kind,
        scheduledFor: reminder.scheduledFor.toJSDate(),
      })),
    });
  }
  return appointment;
}

function overlapError(err: unknown): unknown {
  switch (violatedConstraint(err)) {
    case CONSTRAINTS.providerOverlap:
      return new AppError("slot_taken", "That slot has just been booked. Please choose another.");
    case CONSTRAINTS.patientOverlap:
      return new AppError("patient_conflict", "The patient has another appointment at that time.");
    default:
      return err;
  }
}

function resolvePatientId(actor: Actor, requested: string | undefined): string {
  switch (actor.role) {
    case "PATIENT":
      if (!actor.patientId) throw forbidden();
      return actor.patientId;
    case "STAFF":
    case "ADMIN":
      if (!requested) {
        throw validationError([
          { path: "patientId", message: "Required when booking on behalf of a patient" },
        ]);
      }
      return requested;
    case "PROVIDER":
      throw forbidden();
  }
}

function findByIdempotencyKey(client: DbClient, patientId: string, key: string) {
  return client.appointment.findFirst({ where: { patientId, idempotencyKey: key } });
}

function replayOf(existing: Appointment, request: BookingRequest): string {
  const sameRequest =
    existing.providerId === request.providerId &&
    existing.startsAt.getTime() === request.startsAt.toMillis();
  if (!sameRequest) {
    throw new AppError(
      "idempotency_key_reused",
      "This Idempotency-Key was already used for a different booking.",
    );
  }
  return existing.id;
}

export async function bookAppointment(
  actor: Actor,
  request: BookingRequest,
  now: DateTime,
): Promise<BookingResult> {
  const patientId = resolvePatientId(actor, request.patientId);
  const key = request.idempotencyKey ?? null;

  const replay = async (client: DbClient) => {
    if (!key) return null;
    const existing = await findByIdempotencyKey(client, patientId, key);
    return existing ? replayOf(existing, request) : null;
  };

  const earlier = await replay(db);
  if (earlier) return { appointment: await getAppointmentView(earlier), replayed: true };

  let outcome: { id: string; replayed: boolean };
  try {
    outcome = await db.$transaction(async (tx) => {
      await lockPatient(tx, patientId);
      const concurrent = await replay(tx);
      if (concurrent) return { id: concurrent, replayed: true };
      const appointment = await insertBooking(tx, {
        actor,
        patientId,
        providerId: request.providerId,
        startsAt: request.startsAt,
        reason: request.reason ?? null,
        idempotencyKey: key,
        rescheduledFromId: null,
        clinicId: null,
        now,
      });
      return { id: appointment.id, replayed: false };
    }, LOCKING_TX_OPTIONS);
  } catch (err) {
    const winner = await replay(db);
    if (winner) return { appointment: await getAppointmentView(winner), replayed: true };
    throw err;
  }

  return { appointment: await getAppointmentView(outcome.id), replayed: outcome.replayed };
}
