import { describe, expect, it } from "vitest";
import { DELETE as deleteRule, PATCH as patchRule } from "@/app/api/availability-rules/[id]/route";
import { DELETE as deleteException } from "@/app/api/exceptions/[id]/route";
import {
  GET as listRules,
  POST as createRule,
} from "@/app/api/providers/[id]/availability-rules/route";
import {
  GET as listExceptions,
  POST as createException,
} from "@/app/api/providers/[id]/exceptions/route";
import { db } from "@/server/db";
import {
  addRule,
  call,
  createClinic,
  createPatient,
  createProvider,
  createStaff,
  freezeTime,
  insertAppointment,
} from "./helpers";

async function setup() {
  freezeTime("2026-07-01T12:00:00Z");
  const clinic = await createClinic({ timezone: "America/New_York" });
  const provider = await createProvider(clinic.id);
  const staff = await createStaff(clinic.id);
  const patient = await createPatient();
  return { clinic, provider, staff, patient };
}

const mondayMorning = {
  weekday: 1,
  startLocal: "09:00",
  endLocal: "12:00",
  slotMinutes: 30,
  validFrom: "2026-07-01",
};

describe("availability rules API", () => {
  it("creates a rule", async () => {
    const { provider, staff } = await setup();
    const res = await call(createRule, {
      method: "POST",
      path: `/api/providers/${provider.providerId}/availability-rules`,
      params: { id: provider.providerId },
      token: staff.token,
      body: mondayMorning,
    });

    expect(res.status).toBe(201);
    expect(res.body.rule).toMatchObject({ ...mondayMorning, validTo: null });
    expect(res.body.affectedAppointments).toEqual([]);

    const list = await call(listRules, {
      path: `/api/providers/${provider.providerId}/availability-rules`,
      params: { id: provider.providerId },
      token: staff.token,
    });
    expect(list.body.rules).toHaveLength(1);
  });

  it("rejects a rule that overlaps an existing rule on the same weekday", async () => {
    const { provider, staff } = await setup();
    const existing = await addRule(provider.providerId, mondayMorning);
    const res = await call(createRule, {
      method: "POST",
      path: `/api/providers/${provider.providerId}/availability-rules`,
      params: { id: provider.providerId },
      token: staff.token,
      body: { ...mondayMorning, startLocal: "11:00", endLocal: "13:00" },
    });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("rule_overlap");
    expect(res.body.error.details).toEqual({ ruleId: existing.id });
  });

  it("accepts the same hours in a validity period that starts after the first ends", async () => {
    const { provider, staff } = await setup();
    await addRule(provider.providerId, { ...mondayMorning, validTo: "2026-08-31" });
    const res = await call(createRule, {
      method: "POST",
      path: `/api/providers/${provider.providerId}/availability-rules`,
      params: { id: provider.providerId },
      token: staff.token,
      body: { ...mondayMorning, validFrom: "2026-09-01" },
    });
    expect(res.status).toBe(201);
  });

  it("validates rule fields", async () => {
    const { provider, staff } = await setup();
    const malformed = await call(createRule, {
      method: "POST",
      path: `/api/providers/${provider.providerId}/availability-rules`,
      params: { id: provider.providerId },
      token: staff.token,
      body: {
        weekday: 8,
        startLocal: "9:00",
        endLocal: "12:00",
        slotMinutes: 25,
        validFrom: "2026-02-30",
      },
    });
    expect(malformed.status).toBe(400);
    const paths = malformed.body.error.details.fields.map((f: { path: string }) => f.path);
    expect(paths).toEqual(
      expect.arrayContaining(["weekday", "startLocal", "slotMinutes", "validFrom"]),
    );

    const backwards = await call(createRule, {
      method: "POST",
      path: `/api/providers/${provider.providerId}/availability-rules`,
      params: { id: provider.providerId },
      token: staff.token,
      body: { ...mondayMorning, startLocal: "12:00", endLocal: "09:00" },
    });
    expect(backwards.status).toBe(400);
    expect(backwards.body.error.details.fields[0].path).toBe("endLocal");
  });

  it("reports appointments that no longer fit a narrowed rule without changing them", async () => {
    const { provider, staff, patient } = await setup();
    const rule = await addRule(provider.providerId, mondayMorning);
    const base = {
      providerId: provider.providerId,
      patientId: patient.patientId,
      bookedByUserId: staff.userId,
    };
    const early = await insertAppointment({ ...base, startsAt: "2026-07-06T09:00:00-04:00" });
    const late = await insertAppointment({ ...base, startsAt: "2026-07-13T11:30:00-04:00" });

    const res = await call(patchRule, {
      method: "PATCH",
      path: `/api/availability-rules/${rule.id}`,
      params: { id: rule.id },
      token: staff.token,
      body: { endLocal: "11:00" },
    });

    expect(res.status).toBe(200);
    expect(res.body.rule.endLocal).toBe("11:00");
    expect(res.body.affectedAppointments).toEqual([late.id]);
    const untouched = await db.appointment.findUniqueOrThrow({ where: { id: late.id } });
    expect(untouched.status).toBe("BOOKED");

    const removed = await call(deleteRule, {
      method: "DELETE",
      path: `/api/availability-rules/${rule.id}`,
      params: { id: rule.id },
      token: staff.token,
    });
    expect(removed.status).toBe(200);
    expect(removed.body.affectedAppointments).toEqual([early.id, late.id]);
  });

  it("returns 404 for an unknown rule id", async () => {
    const { staff } = await setup();
    const id = "6f1c2b9e-8d4a-4e1b-9c3f-2a7d5e6b8c90";
    const res = await call(patchRule, {
      method: "PATCH",
      path: `/api/availability-rules/${id}`,
      params: { id },
      token: staff.token,
      body: { endLocal: "11:00" },
    });
    expect(res.status).toBe(404);
  });
});

describe("availability exceptions API", () => {
  it("closes a day, refuses a second exception for it and can be removed", async () => {
    const { provider, staff, patient } = await setup();
    await addRule(provider.providerId, mondayMorning);
    const appointment = await insertAppointment({
      providerId: provider.providerId,
      patientId: patient.patientId,
      bookedByUserId: staff.userId,
      startsAt: "2026-07-06T10:00:00-04:00",
    });
    const path = `/api/providers/${provider.providerId}/exceptions`;
    const params = { id: provider.providerId };

    const created = await call(createException, {
      method: "POST",
      path,
      params,
      token: staff.token,
      body: { kind: "CLOSED", localDate: "2026-07-06" },
    });
    expect(created.status).toBe(201);
    expect(created.body.exception).toMatchObject({ kind: "CLOSED", localDate: "2026-07-06" });
    expect(created.body.affectedAppointments).toEqual([appointment.id]);

    const duplicate = await call(createException, {
      method: "POST",
      path,
      params,
      token: staff.token,
      body: {
        kind: "CUSTOM_HOURS",
        localDate: "2026-07-06",
        startLocal: "13:00",
        endLocal: "14:00",
        slotMinutes: 30,
      },
    });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error.code).toBe("exception_exists");

    const list = await call(listExceptions, { path, params, token: staff.token });
    expect(list.body.exceptions).toHaveLength(1);

    const exceptionId = created.body.exception.id;
    const removed = await call(deleteException, {
      method: "DELETE",
      path: `/api/exceptions/${exceptionId}`,
      params: { id: exceptionId },
      token: staff.token,
    });
    expect(removed.status).toBe(200);
    expect(removed.body.affectedAppointments).toEqual([]);
  });

  it("requires hours for custom-hours exceptions and forbids them on closed days", async () => {
    const { provider, staff } = await setup();
    const path = `/api/providers/${provider.providerId}/exceptions`;
    const params = { id: provider.providerId };

    const missingHours = await call(createException, {
      method: "POST",
      path,
      params,
      token: staff.token,
      body: { kind: "CUSTOM_HOURS", localDate: "2026-07-11", startLocal: "10:00" },
    });
    expect(missingHours.status).toBe(400);

    const closedWithHours = await call(createException, {
      method: "POST",
      path,
      params,
      token: staff.token,
      body: { kind: "CLOSED", localDate: "2026-07-11", startLocal: "10:00" },
    });
    expect(closedWithHours.status).toBe(400);

    const backwards = await call(createException, {
      method: "POST",
      path,
      params,
      token: staff.token,
      body: {
        kind: "CUSTOM_HOURS",
        localDate: "2026-07-11",
        startLocal: "11:00",
        endLocal: "10:00",
        slotMinutes: 30,
      },
    });
    expect(backwards.status).toBe(400);
    expect(backwards.body.error.details.fields[0].path).toBe("endLocal");
  });
});
