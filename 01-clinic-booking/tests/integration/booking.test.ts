import { describe, expect, it } from "vitest";
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
  type ClinicFixture,
} from "./helpers";

const APPOINTMENTS = "/api/appointments";
const morning = { startLocal: "09:00", endLocal: "12:00", slotMinutes: 30 };

async function scenario(
  clinic: ClinicFixture = {},
  now = "2026-07-01T12:00:00Z",
  window = morning,
) {
  freezeTime(now);
  const created = await createClinic({ timezone: "America/New_York", ...clinic });
  const provider = await createProvider(created.id);
  await addDailyRule(provider.providerId, window);
  const patient = await createPatient();
  return { clinic: created, provider, patient };
}

function book(token: string, body: Record<string, unknown>, headers?: Record<string, string>) {
  return call(createAppointment, { method: "POST", path: APPOINTMENTS, token, body, headers });
}

describe("booking", () => {
  it("books an open slot with the slot's end time and both reminders", async () => {
    const { provider, patient } = await scenario();
    const res = await book(patient.token, {
      providerId: provider.providerId,
      startsAt: "2026-07-06T13:00:00Z",
      reason: "Annual check-up",
    });

    expect(res.status).toBe(201);
    expect(res.body.appointment).toMatchObject({
      status: "BOOKED",
      startsAt: "2026-07-06T13:00:00.000Z",
      endsAt: "2026-07-06T13:30:00.000Z",
      reason: "Annual check-up",
      patient: { id: patient.patientId },
      clinic: { timezone: "America/New_York" },
    });
    const reminders = await db.reminder.findMany({ orderBy: { scheduledFor: "asc" } });
    expect(reminders.map((r) => [r.kind, r.scheduledFor.toISOString(), r.status])).toEqual([
      ["T24H", "2026-07-05T13:00:00.000Z", "PENDING"],
      ["T2H", "2026-07-06T11:00:00.000Z", "PENDING"],
    ]);
  });

  it("normalises a start given with a non-UTC offset", async () => {
    const { provider, patient } = await scenario();
    const res = await book(patient.token, {
      providerId: provider.providerId,
      startsAt: "2026-07-06T22:00:00+09:00",
    });
    expect(res.status).toBe(201);
    expect(res.body.appointment.startsAt).toBe("2026-07-06T13:00:00.000Z");
  });

  it("rejects a start one millisecond off the slot grid", async () => {
    const { provider, patient } = await scenario();
    const res = await book(patient.token, {
      providerId: provider.providerId,
      startsAt: "2026-07-06T13:00:00.001Z",
    });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("not_a_slot");
  });

  it("ignores a client-supplied end time", async () => {
    const { provider, patient } = await scenario();
    const res = await book(patient.token, {
      providerId: provider.providerId,
      startsAt: "2026-07-06T13:00:00Z",
      endsAt: "2026-07-06T15:00:00Z",
    });
    expect(res.status).toBe(400);
    expect(await db.appointment.count()).toBe(0);
  });

  it("accepts back-to-back appointments for the same provider", async () => {
    const { provider, patient } = await scenario();
    const other = await createPatient();
    const first = await book(patient.token, {
      providerId: provider.providerId,
      startsAt: "2026-07-06T13:00:00Z",
    });
    const second = await book(other.token, {
      providerId: provider.providerId,
      startsAt: "2026-07-06T13:30:00Z",
    });
    expect([first.status, second.status]).toEqual([201, 201]);
  });

  it("refuses an overlapping appointment for the same patient with another provider", async () => {
    const { clinic, provider, patient } = await scenario();
    const hourly = await createProvider(clinic.id);
    await addDailyRule(hourly.providerId, { ...morning, slotMinutes: 60 });

    const first = await book(patient.token, {
      providerId: provider.providerId,
      startsAt: "2026-07-06T13:30:00Z",
    });
    const second = await book(patient.token, {
      providerId: hourly.providerId,
      startsAt: "2026-07-06T13:00:00Z",
    });
    expect(first.status).toBe(201);
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe("patient_conflict");
  });

  it("refuses a slot inside the lead time for patients but not for staff", async () => {
    const { clinic, provider, patient } = await scenario({}, "2026-07-06T13:30:00Z");
    const staff = await createStaff(clinic.id);
    const body = { providerId: provider.providerId, startsAt: "2026-07-06T14:00:00Z" };

    const asPatient = await book(patient.token, body);
    expect(asPatient.status).toBe(422);
    expect(asPatient.body.error.code).toBe("too_soon");

    const asStaff = await book(staff.token, { ...body, patientId: patient.patientId });
    expect(asStaff.status).toBe(201);
    expect(await db.reminder.count()).toBe(0);

    const past = await book(staff.token, {
      providerId: provider.providerId,
      startsAt: "2026-07-06T13:00:00Z",
      patientId: patient.patientId,
    });
    expect(past.status).toBe(422);
    expect(past.body.error.code).toBe("in_past");
  });

  it("creates only the two-hour reminder three hours ahead and none 90 minutes ahead", async () => {
    const { provider, patient } = await scenario({}, "2026-07-06T12:00:00Z");
    const other = await createPatient();

    const providerId = provider.providerId;
    await book(patient.token, { providerId, startsAt: "2026-07-06T15:00:00Z" });
    await book(other.token, { providerId, startsAt: "2026-07-06T13:30:00Z" });

    const reminders = await db.reminder.findMany({ include: { appointment: true } });
    expect(reminders.map((r) => [r.kind, r.appointment.patientId])).toEqual([
      ["T2H", patient.patientId],
    ]);
  });

  it("uses the clinic's date for the daily limit and the horizon", async () => {
    // 22:00 on 07-01 in Los Angeles is already 07-02 in UTC and in Tokyo.
    const { provider } = await scenario(
      { timezone: "America/Los_Angeles" },
      "2026-07-02T05:00:00Z",
      { startLocal: "07:00", endLocal: "18:00", slotMinutes: 30 },
    );
    const patient = await createPatient({ timezone: "Asia/Tokyo" });
    const providerId = provider.providerId;
    const at = (startsAt: string) => book(patient.token, { providerId, startsAt });

    // 07:30 and 08:00 in Los Angeles fall on different Tokyo dates.
    expect((await at("2026-07-06T07:30:00-07:00")).status).toBe(201);
    const acrossTokyoMidnight = await at("2026-07-06T08:00:00-07:00");
    expect(acrossTokyoMidnight.status).toBe(422);
    expect(acrossTokyoMidnight.body.error.code).toBe("daily_limit");

    // 16:30 and 17:00 in Los Angeles fall on different UTC dates.
    expect((await at("2026-07-08T16:30:00-07:00")).status).toBe(201);
    const acrossUtcMidnight = await at("2026-07-08T17:00:00-07:00");
    expect(acrossUtcMidnight.body.error.code).toBe("daily_limit");

    expect((await at("2026-07-07T07:00:00-07:00")).status).toBe(201);

    expect((await at("2026-09-29T09:00:00-07:00")).status).toBe(201);
    const pastHorizon = await at("2026-09-30T09:00:00-07:00");
    expect(pastHorizon.status).toBe(422);
    expect(pastHorizon.body.error.code).toBe("beyond_horizon");
  });

  it("refuses inactive providers and staff booking outside their clinic", async () => {
    const { provider, patient } = await scenario();
    const otherClinic = await createClinic({ name: "Elsewhere" });
    const outsider = await createStaff(otherClinic.id);
    const retired = await createProvider(otherClinic.id, { active: false });
    await addDailyRule(retired.providerId, morning);

    const inactive = await book(patient.token, {
      providerId: retired.providerId,
      startsAt: "2026-07-06T13:00:00Z",
    });
    expect(inactive.status).toBe(404);

    const crossClinic = await book(outsider.token, {
      providerId: provider.providerId,
      startsAt: "2026-07-06T13:00:00Z",
      patientId: patient.patientId,
    });
    expect(crossClinic.status).toBe(403);
    expect(await db.appointment.count()).toBe(0);
  });

  it("requires a patient when staff book and refuses providers outright", async () => {
    const { clinic, provider, patient } = await scenario();
    const staff = await createStaff(clinic.id);
    const body = { providerId: provider.providerId, startsAt: "2026-07-06T13:00:00Z" };

    const missingPatient = await book(staff.token, body);
    expect(missingPatient.status).toBe(400);
    expect(missingPatient.body.error.details.fields[0].path).toBe("patientId");

    const asProvider = await book(provider.token, { ...body, patientId: patient.patientId });
    expect(asProvider.status).toBe(403);
  });
});

describe("idempotent booking", () => {
  it("replays the original appointment for the same key and slot", async () => {
    const { provider, patient } = await scenario();
    const body = { providerId: provider.providerId, startsAt: "2026-07-06T13:00:00Z" };
    const headers = { "idempotency-key": "booking-7f3a" };

    const first = await book(patient.token, body, headers);
    const again = await book(patient.token, body, headers);

    expect(first.status).toBe(201);
    expect(again.status).toBe(200);
    expect(again.body.appointment.id).toBe(first.body.appointment.id);
    expect(await db.appointment.count()).toBe(1);
  });

  it("rejects the same key for a different slot", async () => {
    const { provider, patient } = await scenario();
    const headers = { "idempotency-key": "booking-7f3a" };
    const providerId = provider.providerId;
    await book(patient.token, { providerId, startsAt: "2026-07-06T13:00:00Z" }, headers);

    const otherSlot = { providerId, startsAt: "2026-07-07T13:00:00Z" };
    const reused = await book(patient.token, otherSlot, headers);
    expect(reused.status).toBe(422);
    expect(reused.body.error.code).toBe("idempotency_key_reused");
  });

  it("rejects keys longer than 64 characters", async () => {
    const { provider, patient } = await scenario();
    const res = await book(
      patient.token,
      { providerId: provider.providerId, startsAt: "2026-07-06T13:00:00Z" },
      { "idempotency-key": "k".repeat(65) },
    );
    expect(res.status).toBe(400);
  });
});
