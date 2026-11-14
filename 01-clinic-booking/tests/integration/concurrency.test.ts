import { describe, expect, it } from "vitest";
import { POST as cancel } from "@/app/api/appointments/[id]/cancel/route";
import { POST as reschedule } from "@/app/api/appointments/[id]/reschedule/route";
import { POST as createAppointment } from "@/app/api/appointments/route";
import { POST as createRule } from "@/app/api/providers/[id]/availability-rules/route";
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

const SLOT = "2026-07-06T13:00:00Z";
const morning = { startLocal: "09:00", endLocal: "12:00", slotMinutes: 30 };

async function scenario() {
  freezeTime("2026-07-01T12:00:00Z");
  const clinic = await createClinic({ timezone: "America/New_York" });
  const provider = await createProvider(clinic.id);
  await addDailyRule(provider.providerId, morning);
  return { clinic, provider };
}

function book(user: TestUser, body: Record<string, unknown>, headers?: Record<string, string>) {
  return call(createAppointment, {
    method: "POST",
    path: "/api/appointments",
    token: user.token,
    body,
    headers,
  });
}

function statuses(results: { status: number }[]): number[] {
  return results.map((res) => res.status).sort((a, b) => a - b);
}

async function overlappingBookedPairs(): Promise<number> {
  const rows = await db.$queryRaw<{ count: bigint }[]>`
    SELECT count(*) AS count
    FROM appointments a
    JOIN appointments b ON a.id < b.id
    WHERE a.status = 'BOOKED' AND b.status = 'BOOKED'
      AND (a.provider_id = b.provider_id OR a.patient_id = b.patient_id)
      AND tstzrange(a.starts_at, a.ends_at, '[)') && tstzrange(b.starts_at, b.ends_at, '[)')`;
  return Number(rows[0].count);
}

describe("concurrent requests", () => {
  it("lets exactly one of many simultaneous bookings take a slot", async () => {
    const { provider } = await scenario();
    const patients = await Promise.all(Array.from({ length: 8 }, () => createPatient()));

    const results = await Promise.all(
      patients.map((patient) => book(patient, { providerId: provider.providerId, startsAt: SLOT })),
    );

    expect(statuses(results)).toEqual([201, 409, 409, 409, 409, 409, 409, 409]);
    const conflicts = results.filter((res) => res.status === 409);
    expect(conflicts.every((res) => res.body.error.code === "slot_taken")).toBe(true);
    expect(await db.appointment.count({ where: { status: "BOOKED" } })).toBe(1);
    expect(await db.reminder.count()).toBe(2);
  });

  it("lets a patient hold only one of two overlapping bookings made at once", async () => {
    const { clinic, provider } = await scenario();
    const hourly = await createProvider(clinic.id);
    await addDailyRule(hourly.providerId, { ...morning, slotMinutes: 60 });
    const patient = await createPatient();

    const results = await Promise.all([
      book(patient, { providerId: provider.providerId, startsAt: "2026-07-06T13:30:00Z" }),
      book(patient, { providerId: hourly.providerId, startsAt: "2026-07-06T13:00:00Z" }),
    ]);

    expect(statuses(results)).toEqual([201, 409]);
    const loser = results.find((res) => res.status === 409);
    expect(loser?.body.error.code).toBe("patient_conflict");
    expect(await overlappingBookedPairs()).toBe(0);
  });

  it("creates one appointment for simultaneous requests sharing an idempotency key", async () => {
    const { provider } = await scenario();
    const patient = await createPatient();
    const headers = { "idempotency-key": "retry-4b1d" };

    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        book(patient, { providerId: provider.providerId, startsAt: SLOT }, headers),
      ),
    );

    expect(statuses(results)).toEqual([200, 200, 200, 200, 201]);
    expect(new Set(results.map((res) => res.body.appointment.id)).size).toBe(1);
    expect(await db.appointment.count()).toBe(1);
  });

  it("never leaves two bookings on a slot when a cancellation races a new booking", async () => {
    const { provider } = await scenario();
    const first = await createPatient();
    const second = await createPatient();
    const original = await book(first, { providerId: provider.providerId, startsAt: SLOT });
    const id = original.body.appointment.id;

    const [cancelled, rebooked] = await Promise.all([
      call(cancel, {
        method: "POST",
        path: `/api/appointments/${id}/cancel`,
        params: { id },
        token: first.token,
      }),
      book(second, { providerId: provider.providerId, startsAt: SLOT }),
    ]);

    expect(cancelled.status).toBe(200);
    expect([201, 409]).toContain(rebooked.status);
    expect(await overlappingBookedPairs()).toBe(0);
    const booked = await db.appointment.count({ where: { status: "BOOKED" } });
    expect(booked).toBe(rebooked.status === 201 ? 1 : 0);
  });

  it("applies only one of two simultaneous reschedules of the same appointment", async () => {
    const { provider } = await scenario();
    const patient = await createPatient();
    const original = await book(patient, { providerId: provider.providerId, startsAt: SLOT });
    const id = original.body.appointment.id;
    const move = (startsAt: string) =>
      call(reschedule, {
        method: "POST",
        path: `/api/appointments/${id}/reschedule`,
        params: { id },
        token: patient.token,
        body: { startsAt },
      });

    const results = await Promise.all([move("2026-07-07T13:00:00Z"), move("2026-07-08T13:00:00Z")]);

    expect(statuses(results)).toEqual([201, 409]);
    expect(results.find((res) => res.status === 409)?.body.error.code).toBe("invalid_state");
    expect(await db.appointment.count({ where: { status: "BOOKED" } })).toBe(1);
  });

  it("refuses one of two overlapping rules created at the same time", async () => {
    const { clinic, provider } = await scenario();
    const staff = await createStaff(clinic.id);
    const create = (startLocal: string, endLocal: string) =>
      call(createRule, {
        method: "POST",
        path: `/api/providers/${provider.providerId}/availability-rules`,
        params: { id: provider.providerId },
        token: staff.token,
        body: { weekday: 3, startLocal, endLocal, slotMinutes: 30, validFrom: "2026-07-01" },
      });

    const results = await Promise.all([create("13:00", "15:00"), create("14:00", "16:00")]);

    expect(statuses(results)).toEqual([201, 422]);
    expect(results.find((res) => res.status === 422)?.body.error.code).toBe("rule_overlap");
  });
});
