import { describe, expect, it } from "vitest";
import { POST as cancel } from "@/app/api/appointments/[id]/cancel/route";
import { POST as complete } from "@/app/api/appointments/[id]/complete/route";
import { POST as noShow } from "@/app/api/appointments/[id]/no-show/route";
import { POST as reschedule } from "@/app/api/appointments/[id]/reschedule/route";
import { POST as createAppointment } from "@/app/api/appointments/route";
import { db } from "@/server/db";
import {
  addDailyRule,
  call,
  createClinic,
  createPatient,
  createProvider,
  createStaff,
  freezeTime,
  type TestUser,
} from "./helpers";

const morning = { startLocal: "09:00", endLocal: "12:00", slotMinutes: 30 };

async function scenario() {
  freezeTime("2026-07-01T12:00:00Z");
  const clinic = await createClinic({ timezone: "America/New_York" });
  const provider = await createProvider(clinic.id);
  await addDailyRule(provider.providerId, morning);
  const patient = await createPatient();
  const staff = await createStaff(clinic.id);
  return { clinic, provider, patient, staff };
}

async function book(user: TestUser, providerId: string, startsAt: string, patientId?: string) {
  const res = await call(createAppointment, {
    method: "POST",
    path: "/api/appointments",
    token: user.token,
    body: { providerId, startsAt, ...(patientId ? { patientId } : {}) },
  });
  expect(res.status).toBe(201);
  return res.body.appointment.id as string;
}

function act(
  handler: typeof cancel,
  action: string,
  user: TestUser,
  id: string,
  body: Record<string, unknown> = {},
) {
  return call(handler, {
    method: "POST",
    path: `/api/appointments/${id}/${action}`,
    params: { id },
    token: user.token,
    body,
  });
}

async function queuedNotifications(): Promise<[string, string, string][]> {
  const rows = await db.appointmentNotification.findMany({ orderBy: { createdAt: "asc" } });
  return rows.map((row) => [row.kind, row.appointmentId, row.status]);
}

describe("cancellation", () => {
  it("cancels, skips pending reminders, queues one email and frees the slot", async () => {
    const { provider, patient } = await scenario();
    const id = await book(patient, provider.providerId, "2026-07-06T13:00:00Z");

    const res = await act(cancel, "cancel", patient, id, { reason: "Feeling better" });
    expect(res.status).toBe(200);
    expect(res.body.appointment).toMatchObject({
      status: "CANCELLED",
      lateCancel: false,
      cancelReason: "Feeling better",
    });
    const reminders = await db.reminder.findMany({ where: { appointmentId: id } });
    expect(reminders.map((r) => r.status)).toEqual(["SKIPPED", "SKIPPED"]);
    expect(await queuedNotifications()).toEqual([["CANCELLATION", id, "PENDING"]]);

    const other = await createPatient();
    await book(other, provider.providerId, "2026-07-06T13:00:00Z");
  });

  it("refuses to cancel twice and queues no second email", async () => {
    const { provider, patient } = await scenario();
    const id = await book(patient, provider.providerId, "2026-07-06T13:00:00Z");

    await act(cancel, "cancel", patient, id);
    const again = await act(cancel, "cancel", patient, id);

    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe("invalid_state");
    expect(await queuedNotifications()).toEqual([["CANCELLATION", id, "PENDING"]]);
  });

  it("lets a patient cancel at exactly 24 hours' notice but not a second later", async () => {
    const { provider, patient } = await scenario();
    const onTime = await book(patient, provider.providerId, "2026-07-06T13:00:00Z");
    const late = await book(patient, provider.providerId, "2026-07-07T13:00:00Z");

    freezeTime("2026-07-05T13:00:00Z");
    expect((await act(cancel, "cancel", patient, onTime)).status).toBe(200);

    freezeTime("2026-07-06T13:00:01Z");
    const refused = await act(cancel, "cancel", patient, late);
    expect(refused.status).toBe(422);
    expect(refused.body.error.code).toBe("cancellation_window_closed");
    expect(await queuedNotifications()).toEqual([["CANCELLATION", onTime, "PENDING"]]);
  });

  it("lets staff cancel late, flagging it, but not after the start", async () => {
    const { provider, patient, staff } = await scenario();
    const soon = await book(patient, provider.providerId, "2026-07-06T13:00:00Z");
    const started = await book(patient, provider.providerId, "2026-07-07T13:00:00Z");

    freezeTime("2026-07-06T12:00:00Z");
    const res = await act(cancel, "cancel", staff, soon);
    expect(res.status).toBe(200);
    expect(res.body.appointment.lateCancel).toBe(true);

    freezeTime("2026-07-07T13:00:00Z");
    const refused = await act(cancel, "cancel", staff, started);
    expect(refused.status).toBe(422);
    expect(refused.body.error.code).toBe("already_started");
  });
});

describe("rescheduling", () => {
  it("moves the appointment, links the new one and queues one email", async () => {
    const { provider, patient } = await scenario();
    const id = await book(patient, provider.providerId, "2026-07-06T13:00:00Z");

    const res = await act(reschedule, "reschedule", patient, id, {
      startsAt: "2026-07-08T14:00:00Z",
    });

    expect(res.status).toBe(201);
    const moved = res.body.appointment;
    expect(moved).toMatchObject({
      status: "BOOKED",
      startsAt: "2026-07-08T14:00:00.000Z",
      rescheduledFromId: id,
    });
    const original = await db.appointment.findUniqueOrThrow({
      where: { id },
      include: { reminders: true },
    });
    expect(original.status).toBe("CANCELLED");
    expect(original.reminders.every((r) => r.status === "SKIPPED")).toBe(true);
    const pending = { appointmentId: moved.id, status: "PENDING" as const };
    expect(await db.reminder.count({ where: pending })).toBe(2);
    expect(await queuedNotifications()).toEqual([["RESCHEDULED", moved.id, "PENDING"]]);
  });

  it("leaves the original untouched when the new slot is taken", async () => {
    const { provider, patient } = await scenario();
    const other = await createPatient();
    const id = await book(patient, provider.providerId, "2026-07-06T13:00:00Z");
    await book(other, provider.providerId, "2026-07-08T14:00:00Z");

    const res = await act(reschedule, "reschedule", patient, id, {
      startsAt: "2026-07-08T14:00:00Z",
    });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("slot_taken");
    const original = await db.appointment.findUniqueOrThrow({
      where: { id },
      include: { reminders: true },
    });
    expect(original.status).toBe("BOOKED");
    expect(original.cancelledAt).toBeNull();
    expect(original.reminders.map((r) => r.status)).toEqual(["PENDING", "PENDING"]);
    expect(await db.appointment.count()).toBe(2);
    expect(await queuedNotifications()).toEqual([]);
  });

  it("can move into a window that overlaps the appointment being replaced", async () => {
    const { clinic, patient } = await scenario();
    const hourly = await createProvider(clinic.id);
    await addDailyRule(hourly.providerId, { ...morning, slotMinutes: 60 });
    const halfHourly = await createProvider(clinic.id);
    await addDailyRule(halfHourly.providerId, morning);
    const id = await book(patient, hourly.providerId, "2026-07-06T13:00:00Z");

    const res = await act(reschedule, "reschedule", patient, id, {
      providerId: halfHourly.providerId,
      startsAt: "2026-07-06T13:30:00Z",
    });

    expect(res.status).toBe(201);
    expect(res.body.appointment.provider.id).toBe(halfHourly.providerId);
  });

  it("only moves to providers in the same clinic", async () => {
    const { provider, patient } = await scenario();
    const elsewhere = await createClinic({ name: "Elsewhere" });
    const outsider = await createProvider(elsewhere.id);
    await addDailyRule(outsider.providerId, morning);
    const id = await book(patient, provider.providerId, "2026-07-06T13:00:00Z");

    const res = await act(reschedule, "reschedule", patient, id, {
      providerId: outsider.providerId,
      startsAt: "2026-07-08T13:00:00Z",
    });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("provider_not_in_clinic");
  });

  it("applies the patient's 24-hour rule to the appointment being moved", async () => {
    const { provider, patient } = await scenario();
    const id = await book(patient, provider.providerId, "2026-07-06T13:00:00Z");

    freezeTime("2026-07-05T14:00:00Z");
    const res = await act(reschedule, "reschedule", patient, id, {
      startsAt: "2026-07-08T13:00:00Z",
    });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("cancellation_window_closed");
  });
});

describe("completion and no-shows", () => {
  it("records outcomes only after the start and only once", async () => {
    const { provider, patient, staff } = await scenario();
    const first = await book(patient, provider.providerId, "2026-07-06T13:00:00Z");
    const second = await book(patient, provider.providerId, "2026-07-07T13:00:00Z");

    const early = await act(complete, "complete", provider, first);
    expect(early.status).toBe(422);
    expect(early.body.error.code).toBe("not_started");

    freezeTime("2026-07-07T13:00:00Z");
    const done = await act(complete, "complete", provider, first);
    expect(done.status).toBe(200);
    expect(done.body.appointment.status).toBe("COMPLETED");

    const twice = await act(noShow, "no-show", staff, first);
    expect(twice.status).toBe(409);

    const missed = await act(noShow, "no-show", staff, second);
    expect(missed.body.appointment.status).toBe("NO_SHOW");

    const byPatient = await act(cancel, "cancel", patient, second);
    expect(byPatient.status).toBe(409);
  });
});
