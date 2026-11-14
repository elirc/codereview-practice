import { describe, expect, it } from "vitest";
import { GET as listProviders } from "@/app/api/clinics/[id]/providers/route";
import { GET as listClinics } from "@/app/api/clinics/route";
import { GET as getSlots } from "@/app/api/providers/[id]/slots/route";
import {
  addDailyRule,
  addRule,
  call,
  createClinic,
  createPatient,
  createProvider,
  createStaff,
  freezeTime,
  insertAppointment,
} from "./helpers";

function slotsPath(providerId: string, from: string, to: string) {
  return `/api/providers/${providerId}/slots?from=${from}&to=${to}`;
}

describe("slots API", () => {
  it("returns clinic-local days with availability and hides who booked", async () => {
    freezeTime("2026-07-01T12:00:00Z");
    const clinic = await createClinic({ timezone: "America/New_York" });
    const provider = await createProvider(clinic.id);
    const patient = await createPatient();
    const other = await createPatient();
    await addRule(provider.providerId, {
      weekday: 1,
      startLocal: "09:00",
      endLocal: "10:00",
      slotMinutes: 30,
    });
    await insertAppointment({
      providerId: provider.providerId,
      patientId: other.patientId,
      bookedByUserId: other.userId,
      startsAt: "2026-07-06T09:30:00-04:00",
    });

    const res = await call(getSlots, {
      path: slotsPath(provider.providerId, "2026-07-06", "2026-07-07"),
      params: { id: provider.providerId },
      token: patient.token,
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      timezone: "America/New_York",
      days: [
        {
          date: "2026-07-06",
          slots: [
            {
              startsAt: "2026-07-06T13:00:00.000Z",
              endsAt: "2026-07-06T13:30:00.000Z",
              available: true,
            },
            {
              startsAt: "2026-07-06T13:30:00.000Z",
              endsAt: "2026-07-06T14:00:00.000Z",
              available: false,
              reason: "booked",
            },
          ],
        },
        { date: "2026-07-07", slots: [] },
      ],
    });
  });

  it("computes each day of a range that crosses a DST change with that day's offset", async () => {
    freezeTime("2026-03-01T12:00:00Z");
    const clinic = await createClinic({ timezone: "America/New_York" });
    const provider = await createProvider(clinic.id);
    const patient = await createPatient();
    await addDailyRule(provider.providerId, {
      startLocal: "09:00",
      endLocal: "10:00",
      slotMinutes: 60,
    });

    const res = await call(getSlots, {
      path: slotsPath(provider.providerId, "2026-03-07", "2026-03-09"),
      params: { id: provider.providerId },
      token: patient.token,
    });

    type Day = { slots: { startsAt: string }[] };
    const starts = res.body.days.map((day: Day) => day.slots[0].startsAt);
    expect(starts).toEqual([
      "2026-03-07T14:00:00.000Z",
      "2026-03-08T13:00:00.000Z",
      "2026-03-09T13:00:00.000Z",
    ]);
  });

  it("accepts up to 31 days and rejects longer or reversed ranges", async () => {
    freezeTime("2026-07-01T12:00:00Z");
    const clinic = await createClinic();
    const provider = await createProvider(clinic.id);
    const patient = await createPatient();
    const params = { id: provider.providerId };

    const month = await call(getSlots, {
      path: slotsPath(provider.providerId, "2026-07-01", "2026-07-31"),
      params,
      token: patient.token,
    });
    expect(month.status).toBe(200);
    expect(month.body.days).toHaveLength(31);

    const tooLong = await call(getSlots, {
      path: slotsPath(provider.providerId, "2026-07-01", "2026-08-01"),
      params,
      token: patient.token,
    });
    expect(tooLong.status).toBe(400);
    expect(tooLong.body.error.code).toBe("validation_failed");

    const reversed = await call(getSlots, {
      path: slotsPath(provider.providerId, "2026-07-05", "2026-07-01"),
      params,
      token: patient.token,
    });
    expect(reversed.status).toBe(400);
  });

  it("offers no slots for an inactive provider", async () => {
    freezeTime("2026-07-01T12:00:00Z");
    const clinic = await createClinic();
    const provider = await createProvider(clinic.id, { active: false });
    const patient = await createPatient();
    await addDailyRule(provider.providerId, {
      startLocal: "09:00",
      endLocal: "12:00",
      slotMinutes: 30,
    });

    const res = await call(getSlots, {
      path: slotsPath(provider.providerId, "2026-07-06", "2026-07-07"),
      params: { id: provider.providerId },
      token: patient.token,
    });
    expect(res.body.days.every((day: { slots: unknown[] }) => day.slots.length === 0)).toBe(true);
  });

  it("requires a session", async () => {
    const clinic = await createClinic();
    const provider = await createProvider(clinic.id);
    const res = await call(getSlots, {
      path: slotsPath(provider.providerId, "2026-07-06", "2026-07-07"),
      params: { id: provider.providerId },
    });
    expect(res.status).toBe(401);
  });
});

describe("clinic and provider listings", () => {
  it("lists clinics and hides inactive providers from patients only", async () => {
    const clinic = await createClinic({ name: "Northside" });
    await createProvider(clinic.id, { displayName: "Dr. Active" });
    await createProvider(clinic.id, { displayName: "Dr. Retired", active: false });
    const patient = await createPatient();
    const staff = await createStaff(clinic.id);

    const clinics = await call(listClinics, { path: "/api/clinics", token: patient.token });
    expect(clinics.body.clinics.map((c: { name: string }) => c.name)).toEqual(["Northside"]);

    const path = `/api/clinics/${clinic.id}/providers`;
    const params = { id: clinic.id };
    const forPatient = await call(listProviders, { path, params, token: patient.token });
    const forStaff = await call(listProviders, { path, params, token: staff.token });
    const names = (res: typeof forPatient) =>
      res.body.providers.map((p: { displayName: string }) => p.displayName);
    expect(names(forPatient)).toEqual(["Dr. Active"]);
    expect(names(forStaff)).toEqual(["Dr. Active", "Dr. Retired"]);
  });
});
