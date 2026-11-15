import type { NotificationKind, Prisma } from "@prisma/client";
import type { DateTime } from "luxon";
import { evaluateCancellation, outcomeProblem, type AppointmentStatus } from "@/domain/policies";
import { localDayRange, type LocalDate } from "@/domain/time";
import type { Actor } from "@/server/auth/actor";
import { fromDbInstant } from "@/server/dates";
import { db, LOCKING_TX_OPTIONS, type DbClient } from "@/server/db";
import { AppError, forbidden, invalidState, notFound, validationError } from "@/server/errors";
import {
  appointmentInclude,
  assertCanRecordOutcome,
  cancellerRole,
  getAppointmentView,
  loadVisibleAppointment,
  type AppointmentView,
} from "./access";
import { insertBooking, lockPatient } from "./booking";

const CANCELLATION_MESSAGES = {
  cancellation_window_closed:
    "Appointments can only be cancelled online up to 24 hours before they start.",
  already_started: "The appointment has already started; record it as a no-show instead.",
} as const;

export function getAppointment(actor: Actor, id: string): Promise<AppointmentView> {
  return loadVisibleAppointment(actor, id);
}

async function cancelInTransaction(
  tx: DbClient,
  actor: Actor,
  appointment: AppointmentView,
  reason: string | null,
  now: DateTime,
): Promise<void> {
  if (appointment.status !== "BOOKED") throw invalidState();
  const role = cancellerRole(actor);
  const decision = evaluateCancellation(role, fromDbInstant(appointment.startsAt), now);
  if (!decision.allowed) throw new AppError(decision.code, CANCELLATION_MESSAGES[decision.code]);

  const { count } = await tx.appointment.updateMany({
    where: { id: appointment.id, status: "BOOKED" },
    data: {
      status: "CANCELLED",
      cancelledAt: now.toJSDate(),
      cancelledByUserId: actor.userId,
      cancelReason: reason,
      lateCancel: decision.lateCancel,
    },
  });
  if (count === 0) throw invalidState();

  await tx.reminder.updateMany({
    where: { appointmentId: appointment.id, status: "PENDING" },
    data: { status: "SKIPPED" },
  });
}

/** Records a patient email to be sent by the worker once this transaction commits. */
async function queueNotification(
  tx: DbClient,
  appointmentId: string,
  kind: NotificationKind,
  now: DateTime,
): Promise<void> {
  await tx.appointmentNotification.create({
    data: { appointmentId, kind, createdAt: now.toJSDate() },
  });
}

export async function cancelAppointment(
  actor: Actor,
  id: string,
  reason: string | null,
  now: DateTime,
): Promise<AppointmentView> {
  const appointment = await loadVisibleAppointment(actor, id);
  cancellerRole(actor);
  await db.$transaction(async (tx) => {
    await cancelInTransaction(tx, actor, appointment, reason, now);
    await queueNotification(tx, id, "CANCELLATION", now);
  });
  return getAppointmentView(id);
}

/** Replaces the visit reason on an upcoming booked appointment. */
export async function updateAppointmentReason(
  actor: Actor,
  id: string,
  reason: string | null,
  now: DateTime,
): Promise<AppointmentView> {
  cancellerRole(actor);
  const appointment = await db.appointment.findUnique({ where: { id } });
  if (!appointment) throw notFound("Appointment");
  if (appointment.status !== "BOOKED" || appointment.startsAt.getTime() <= now.toMillis()) {
    throw invalidState();
  }

  const { count } = await db.appointment.updateMany({
    where: { id, status: "BOOKED" },
    data: { reason },
  });
  if (count === 0) throw invalidState();
  return getAppointmentView(id);
}

export interface RescheduleRequest {
  providerId?: string;
  startsAt: DateTime;
}

export async function rescheduleAppointment(
  actor: Actor,
  id: string,
  request: RescheduleRequest,
  now: DateTime,
): Promise<AppointmentView> {
  const original = await loadVisibleAppointment(actor, id);
  cancellerRole(actor);

  const created = await db.$transaction(async (tx) => {
    await lockPatient(tx, original.patientId);
    await cancelInTransaction(tx, actor, original, "Rescheduled", now);
    const appointment = await insertBooking(tx, {
      actor,
      patientId: original.patientId,
      providerId: request.providerId ?? original.providerId,
      startsAt: request.startsAt,
      reason: original.reason,
      idempotencyKey: null,
      rescheduledFromId: original.id,
      clinicId: original.provider.clinicId,
      now,
    });
    await queueNotification(tx, appointment.id, "RESCHEDULED", now);
    return appointment;
  }, LOCKING_TX_OPTIONS);

  return getAppointmentView(created.id);
}

export async function recordOutcome(
  actor: Actor,
  id: string,
  outcome: "COMPLETED" | "NO_SHOW",
  now: DateTime,
): Promise<AppointmentView> {
  const appointment = await loadVisibleAppointment(actor, id);
  assertCanRecordOutcome(actor);
  const problem = outcomeProblem(appointment.status, fromDbInstant(appointment.startsAt), now);
  if (problem === "invalid_state") throw invalidState();
  if (problem === "not_started") {
    throw new AppError("not_started", "The appointment has not started yet.");
  }

  const { count } = await db.appointment.updateMany({
    where: { id, status: "BOOKED" },
    data: { status: outcome },
  });
  if (count === 0) throw invalidState();
  return getAppointmentView(id);
}

export interface AppointmentQuery {
  scope: "mine" | "clinic";
  date?: LocalDate;
  providerId?: string;
  clinicId?: string;
  status?: AppointmentStatus;
}

function scopeFilter(actor: Actor, query: AppointmentQuery): Prisma.AppointmentWhereInput {
  if (query.scope === "mine") {
    if (actor.role !== "PATIENT" || !actor.patientId) throw forbidden();
    return { patientId: actor.patientId };
  }
  switch (actor.role) {
    case "PATIENT":
      throw forbidden();
    case "PROVIDER":
      if (!actor.providerId) throw forbidden();
      if (query.providerId && query.providerId !== actor.providerId) throw forbidden();
      return { providerId: actor.providerId };
    case "STAFF":
      if (!actor.clinicId) throw forbidden();
      if (query.clinicId && query.clinicId !== actor.clinicId) throw forbidden();
      return { provider: { clinicId: actor.clinicId } };
    case "ADMIN":
      return query.clinicId ? { provider: { clinicId: query.clinicId } } : {};
  }
}

/** The zone that defines a clinic-local `date` filter for this query. */
async function zoneForDate(actor: Actor, query: AppointmentQuery): Promise<string> {
  const clinicId = query.clinicId ?? (actor.role === "ADMIN" ? null : actor.clinicId);
  if (clinicId) {
    const clinic = await db.clinic.findUnique({ where: { id: clinicId } });
    if (!clinic) throw notFound("Clinic");
    return clinic.timezone;
  }
  if (query.providerId) {
    const provider = await db.provider.findUnique({
      where: { id: query.providerId },
      include: { clinic: true },
    });
    if (!provider) throw notFound("Provider");
    return provider.clinic.timezone;
  }
  throw validationError([
    { path: "date", message: "Filtering by date requires clinicId or providerId" },
  ]);
}

export async function listAppointments(
  actor: Actor,
  query: AppointmentQuery,
): Promise<AppointmentView[]> {
  const where: Prisma.AppointmentWhereInput = { ...scopeFilter(actor, query) };
  if (query.providerId) where.providerId = query.providerId;
  if (query.status) where.status = query.status;
  if (query.date) {
    const { start, end } = localDayRange(query.date, await zoneForDate(actor, query));
    where.startsAt = { gte: start.toJSDate(), lt: end.toJSDate() };
  }
  return db.appointment.findMany({
    where,
    include: appointmentInclude,
    orderBy: { startsAt: "asc" },
    take: 500,
  });
}
