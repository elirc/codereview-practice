import { describe, expect, it } from "vitest";
import { POST as closeDay } from "@/app/api/clinics/[id]/closures/route";
import { GET as getSlots } from "@/app/api/providers/[id]/slots/route";
import { db } from "@/server/db";
import {
  addDailyRule,
  call,
  createClinic,
  createPatient,
  createProvider,
  createStaff,
  freezeTime,
  insertAppointment,
  type TestUser,
} from "./helpers";

async function scenario() {
  freezeTime("2026-07-01T12:00:00Z");
  const clinic = await createClinic({ timezone: "America/New_York" });
  const provider = await createProvider(clinic.id);
  await addDailyRule(provider.providerId, {
    startLocal: "09:00",
    endLocal: "12:00",
    slotMinutes: 30,
  });
  const staff = await createStaff(clinic.id);
  const patient = await createPatient();
  const at = (startsAt: string) =>
    insertAppointment({
      providerId: provider.providerId,
      patientId: patient.patientId,
      bookedByUserId: patient.userId,
      startsAt,
    });
  return { clinic, provider, staff, patient, at };
}

function close(user: TestUser, clinicId: string, body: Record<string, unknown>) {
  return call(closeDay, {
    method: "POST",
    path: `/api/clinics/${clinicId}/closures`,
    params: { id: clinicId },
    token: user.token,
    body,
  });
}

describe("closing a provider's day", () => {
  it("closes the date, cancels its bookings and queues their emails", async () => {
    const { clinic, provider, staff, at } = await scenario();
    const morning = await at("2026-07-06T09:00:00-04:00");
    const late = await at("2026-07-06T11:30:00-04:00");
    const nextDay = await at("2026-07-07T09:00:00-04:00");
    await db.reminder.create({
      data: {
        appointmentId: morning.id,
        kind: "T24H",
        scheduledFor: new Date("2026-07-05T13:00:00Z"),
      },
    });

    const res = await close(staff, clinic.id, {
      providerId: provider.providerId,
      localDate: "2026-07-06",
      reason: "Provider unwell",
    });

    expect(res.status).toBe(201);
    expect(res.body.exception).toMatchObject({ localDate: "2026-07-06", kind: "CLOSED" });
    expect(res.body.cancelledAppointments.sort()).toEqual([morning.id, late.id].sort());

    const rows = await db.appointment.findMany({ orderBy: { startsAt: "asc" } });
    expect(rows.map((row) => [row.id, row.status])).toEqual([
      [morning.id, "CANCELLED"],
      [late.id, "CANCELLED"],
      [nextDay.id, "BOOKED"],
    ]);
    expect(rows[0]).toMatchObject({ cancelReason: "Provider unwell", lateCancel: false });
    expect(await db.reminder.findMany()).toMatchObject([{ status: "SKIPPED" }]);
    const notices = await db.appointmentNotification.findMany();
    expect(notices.map((n) => n.kind)).toEqual(["CANCELLATION", "CANCELLATION"]);

    const slots = await call(getSlots, {
      path: `/api/providers/${provider.providerId}/slots?from=2026-07-06&to=2026-07-06`,
      params: { id: provider.providerId },
      token: staff.token,
    });
    expect(slots.body.days[0].slots).toEqual([]);
  });

  it("refuses a date that already has an exception", async () => {
    const { clinic, provider, staff } = await scenario();
    const body = { providerId: provider.providerId, localDate: "2026-07-06" };

    expect((await close(staff, clinic.id, body)).status).toBe(201);
    const again = await close(staff, clinic.id, body);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe("exception_exists");
  });

  it("is limited to staff of the clinic and admins", async () => {
    const { clinic, provider, patient } = await scenario();
    const elsewhere = await createClinic({ name: "Elsewhere" });
    const outsider = await createStaff(elsewhere.id);
    const body = { providerId: provider.providerId, localDate: "2026-07-06" };

    expect((await close(outsider, clinic.id, body)).status).toBe(403);
    expect((await close(patient, clinic.id, body)).status).toBe(403);
    expect((await close(provider, clinic.id, body)).status).toBe(403);
    expect(await db.availabilityException.count()).toBe(0);
  });
});
