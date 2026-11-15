import { describe, expect, it } from "vitest";
import { POST as createAppointment } from "@/app/api/appointments/route";
import { GET as openSlots } from "@/app/api/clinics/[id]/open-slots/route";
import { GET as findPatient } from "@/app/api/patients/route";
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
  freezeTime("2026-07-06T13:10:00Z");
  const clinic = await createClinic({ timezone: "America/New_York" });
  const provider = await createProvider(clinic.id, { displayName: "Dr. Adams" });
  await addDailyRule(provider.providerId, {
    startLocal: "09:00",
    endLocal: "12:00",
    slotMinutes: 30,
  });
  const staff = await createStaff(clinic.id);
  const patient = await createPatient({ fullName: "Rosa Diaz" });
  return { clinic, provider, staff, patient };
}

function listOpen(user: TestUser, clinicId: string, date: string) {
  return call(openSlots, {
    path: `/api/clinics/${clinicId}/open-slots?date=${date}`,
    params: { id: clinicId },
    token: user.token,
  });
}

function lookup(user: TestUser, email: string) {
  return call(findPatient, {
    path: `/api/patients?${new URLSearchParams({ email }).toString()}`,
    token: user.token,
  });
}

describe("open slots for staff", () => {
  it("lists future unbooked slots without applying the online lead time", async () => {
    const { clinic, provider, staff, patient } = await scenario();
    await insertAppointment({
      providerId: provider.providerId,
      patientId: patient.patientId,
      bookedByUserId: patient.userId,
      startsAt: "2026-07-06T11:00:00-04:00",
    });

    const res = await listOpen(staff, clinic.id, "2026-07-06");

    expect(res.status).toBe(200);
    expect(res.body.timezone).toBe("America/New_York");
    const [column] = res.body.providers;
    expect(column.providerId).toBe(provider.providerId);
    const starts = column.slots.map((slot: { startsAt: string }) => slot.startsAt);
    // 09:00 local has started; 09:30 is inside the lead time but still offered to staff.
    expect(starts).not.toContain("2026-07-06T13:00:00.000Z");
    expect(starts).toContain("2026-07-06T13:30:00.000Z");
    expect(starts).toContain("2026-07-06T14:00:00.000Z");
    expect(starts).not.toContain("2026-07-06T15:00:00.000Z");
  });

  it("is limited to staff of the clinic and admins", async () => {
    const { clinic, patient, provider } = await scenario();
    const elsewhere = await createClinic({ name: "Elsewhere" });
    const outsider = await createStaff(elsewhere.id);

    expect((await listOpen(outsider, clinic.id, "2026-07-06")).status).toBe(403);
    expect((await listOpen(patient, clinic.id, "2026-07-06")).status).toBe(403);
    expect((await listOpen(provider, clinic.id, "2026-07-06")).status).toBe(403);
  });
});

describe("booking for a patient found by email", () => {
  it("finds the patient and books the slot on their behalf", async () => {
    const { provider, staff, patient } = await scenario();

    const found = await lookup(staff, patient.email.toUpperCase());
    expect(found.status).toBe(200);
    expect(found.body.patient).toEqual({
      id: patient.patientId,
      fullName: "Rosa Diaz",
      timezone: "America/New_York",
    });

    const booked = await call(createAppointment, {
      method: "POST",
      path: "/api/appointments",
      token: staff.token,
      body: {
        providerId: provider.providerId,
        startsAt: "2026-07-06T13:30:00Z",
        patientId: found.body.patient.id,
      },
    });
    expect(booked.status).toBe(201);
    expect(booked.body.appointment.patient.id).toBe(patient.patientId);
  });

  it("answers unknown emails with 404 and refuses patients", async () => {
    const { staff, patient } = await scenario();

    expect((await lookup(staff, "nobody@example.test")).status).toBe(404);
    expect((await lookup(patient, patient.email)).status).toBe(403);
  });
});
