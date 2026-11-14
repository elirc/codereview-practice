import { describe, expect, it } from "vitest";
import { GET as listAppointments } from "@/app/api/appointments/route";
import {
  call,
  createAdmin,
  createClinic,
  createPatient,
  createProvider,
  createStaff,
  insertAppointment,
  type TestUser,
} from "./helpers";

async function clinicWithAppointments(startTimes: string[]) {
  const clinic = await createClinic({ timezone: "America/New_York" });
  const provider = await createProvider(clinic.id);
  const staff = await createStaff(clinic.id);
  const patient = await createPatient();
  const ids: string[] = [];
  for (const startsAt of startTimes) {
    const appointment = await insertAppointment({
      providerId: provider.providerId,
      patientId: patient.patientId,
      bookedByUserId: staff.userId,
      startsAt,
    });
    ids.push(appointment.id);
  }
  return { clinic, provider, staff, patient, ids };
}

async function list(user: TestUser, query: string) {
  return call(listAppointments, { path: `/api/appointments?${query}`, token: user.token });
}

function ids(res: Awaited<ReturnType<typeof list>>): string[] {
  return res.body.appointments.map((a: { id: string }) => a.id);
}

describe("day view boundaries", () => {
  it("covers all 25 hours of a fall-back day", async () => {
    const { staff, ids: created } = await clinicWithAppointments([
      "2026-10-31T23:30:00-04:00",
      "2026-11-01T00:00:00-04:00",
      "2026-11-01T23:30:00-05:00",
      "2026-11-02T00:00:00-05:00",
    ]);
    const res = await list(staff, "scope=clinic&date=2026-11-01");
    expect(res.status).toBe(200);
    expect(ids(res)).toEqual([created[1], created[2]]);
  });

  it("covers the 23 hours of a spring-forward day", async () => {
    const { staff, ids: created } = await clinicWithAppointments([
      "2026-03-07T23:30:00-05:00",
      "2026-03-08T00:00:00-05:00",
      "2026-03-08T23:30:00-04:00",
      "2026-03-09T00:00:00-04:00",
    ]);
    const res = await list(staff, "scope=clinic&date=2026-03-08");
    expect(ids(res)).toEqual([created[1], created[2]]);
  });
});

describe("listing scopes", () => {
  it("limits each role to what it may see", async () => {
    const { clinic, provider, patient, staff, ids: created } = await clinicWithAppointments([
      "2026-07-06T09:00:00-04:00",
    ]);
    const colleague = await createProvider(clinic.id);
    const otherPatient = await createPatient();
    const theirs = await insertAppointment({
      providerId: colleague.providerId,
      patientId: otherPatient.patientId,
      bookedByUserId: staff.userId,
      startsAt: "2026-07-06T09:00:00-04:00",
    });
    const elsewhere = await createClinic({ name: "Elsewhere" });
    const outsider = await createStaff(elsewhere.id);
    const admin = await createAdmin();

    expect(ids(await list(staff, "scope=clinic&date=2026-07-06"))).toHaveLength(2);
    expect(ids(await list(provider, "scope=clinic"))).toEqual(created);
    expect(ids(await list(outsider, "scope=clinic"))).toEqual([]);
    expect(ids(await list(patient, "scope=mine"))).toEqual(created);
    expect(ids(await list(otherPatient, "scope=mine"))).toEqual([theirs.id]);
    expect((await list(patient, "scope=clinic")).status).toBe(403);
    expect((await list(staff, "scope=mine")).status).toBe(403);
    const foreignFilter = await list(provider, `scope=clinic&providerId=${colleague.providerId}`);
    expect(foreignFilter.status).toBe(403);

    const adminNoClinic = await list(admin, "scope=clinic&date=2026-07-06");
    expect(adminNoClinic.status).toBe(400);
    const adminForClinic = await list(admin, `scope=clinic&date=2026-07-06&clinicId=${clinic.id}`);
    expect(ids(adminForClinic)).toHaveLength(2);
  });

  it("filters by status", async () => {
    const { staff, ids: created } = await clinicWithAppointments(["2026-07-06T09:00:00-04:00"]);
    expect(ids(await list(staff, "scope=clinic&status=BOOKED"))).toEqual(created);
    expect(ids(await list(staff, "scope=clinic&status=CANCELLED"))).toEqual([]);
  });
});
