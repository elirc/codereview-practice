import { beforeEach, describe, expect, it } from "vitest";
import { GET as getAppointment } from "@/app/api/appointments/[id]/route";
import { POST as cancel } from "@/app/api/appointments/[id]/cancel/route";
import { POST as complete } from "@/app/api/appointments/[id]/complete/route";
import { POST as reschedule } from "@/app/api/appointments/[id]/reschedule/route";
import { PATCH as patchRule } from "@/app/api/availability-rules/[id]/route";
import { POST as createException } from "@/app/api/providers/[id]/exceptions/route";
import {
  GET as listRules,
  POST as createRule,
} from "@/app/api/providers/[id]/availability-rules/route";
import {
  addDailyRule,
  addRule,
  call,
  createAdmin,
  createClinic,
  createPatient,
  createProvider,
  createStaff,
  freezeTime,
  insertAppointment,
  type TestUser,
} from "./helpers";

type World = Awaited<ReturnType<typeof buildWorld>>;
type Who =
  | "owner"
  | "otherPatient"
  | "provider"
  | "otherProvider"
  | "staff"
  | "otherStaff"
  | "admin";

async function buildWorld() {
  freezeTime("2026-07-01T12:00:00Z");
  const home = await createClinic({ name: "Home" });
  const away = await createClinic({ name: "Away" });
  const provider = await createProvider(home.id);
  const otherProvider = await createProvider(away.id);
  await addDailyRule(provider.providerId, {
    startLocal: "09:00",
    endLocal: "12:00",
    slotMinutes: 30,
  });
  const owner = await createPatient();
  const users: Record<Who, TestUser> = {
    owner,
    otherPatient: await createPatient(),
    provider,
    otherProvider,
    staff: await createStaff(home.id),
    otherStaff: await createStaff(away.id),
    admin: await createAdmin(),
  };
  return { users, provider, otherProvider, owner };
}

async function appointmentFor(world: World, startsAt = "2026-07-06T09:00:00-04:00") {
  return insertAppointment({
    providerId: world.provider.providerId,
    patientId: world.owner.patientId,
    bookedByUserId: world.owner.userId,
    startsAt,
  });
}

let world: World;

beforeEach(async () => {
  world = await buildWorld();
});

describe("appointment access", () => {
  it.each<[Who, number]>([
    ["owner", 200],
    ["otherPatient", 404],
    ["provider", 200],
    ["otherProvider", 404],
    ["staff", 200],
    ["otherStaff", 404],
    ["admin", 200],
  ])("lets %s read an appointment with status %i", async (role, status) => {
    const appointment = await appointmentFor(world);
    const res = await call(getAppointment, {
      path: `/api/appointments/${appointment.id}`,
      params: { id: appointment.id },
      token: world.users[role].token,
    });
    expect(res.status).toBe(status);
  });

  it("answers a foreign appointment exactly like a missing one", async () => {
    const appointment = await appointmentFor(world);
    const missing = "0b7e8f7a-3c55-4c1e-9d0e-6a8b5f2c1d3e";
    const token = world.users.otherPatient.token;

    const foreign = await call(getAppointment, {
      path: `/api/appointments/${appointment.id}`,
      params: { id: appointment.id },
      token,
    });
    const absent = await call(getAppointment, {
      path: `/api/appointments/${missing}`,
      params: { id: missing },
      token,
    });
    const malformed = await call(getAppointment, {
      path: "/api/appointments/not-an-id",
      params: { id: "not-an-id" },
      token,
    });

    for (const res of [absent, malformed]) {
      expect(res.status).toBe(foreign.status);
      expect(res.body.error.code).toBe(foreign.body.error.code);
      expect(res.body.error.message).toBe(foreign.body.error.message);
    }
  });

  it.each<[Who, number]>([
    ["owner", 200],
    ["otherPatient", 404],
    ["provider", 403],
    ["otherProvider", 404],
    ["staff", 200],
    ["otherStaff", 404],
    ["admin", 200],
  ])("lets %s cancel an appointment with status %i", async (role, status) => {
    const appointment = await appointmentFor(world);
    const res = await call(cancel, {
      method: "POST",
      path: `/api/appointments/${appointment.id}/cancel`,
      params: { id: appointment.id },
      token: world.users[role].token,
    });
    expect(res.status).toBe(status);
  });

  it.each<[Who, number]>([
    ["owner", 201],
    ["otherPatient", 404],
    ["provider", 403],
    ["staff", 201],
  ])("lets %s reschedule an appointment with status %i", async (role, status) => {
    const appointment = await appointmentFor(world);
    const res = await call(reschedule, {
      method: "POST",
      path: `/api/appointments/${appointment.id}/reschedule`,
      params: { id: appointment.id },
      token: world.users[role].token,
      body: { startsAt: "2026-07-08T13:00:00Z" },
    });
    expect(res.status).toBe(status);
  });

  it.each<[Who, number]>([
    ["owner", 403],
    ["otherPatient", 404],
    ["provider", 200],
    ["otherProvider", 404],
    ["staff", 200],
    ["otherStaff", 404],
    ["admin", 200],
  ])("lets %s record an outcome with status %i", async (role, status) => {
    const appointment = await appointmentFor(world);
    freezeTime("2026-07-06T13:30:00Z");
    const res = await call(complete, {
      method: "POST",
      path: `/api/appointments/${appointment.id}/complete`,
      params: { id: appointment.id },
      token: world.users[role].token,
    });
    expect(res.status).toBe(status);
  });
});

describe("availability management access", () => {
  it.each<[Who, number]>([
    ["owner", 403],
    ["provider", 200],
    ["otherProvider", 403],
    ["staff", 200],
    ["otherStaff", 403],
    ["admin", 200],
  ])("lets %s read a provider's rules with status %i", async (role, status) => {
    const id = world.provider.providerId;
    const res = await call(listRules, {
      path: `/api/providers/${id}/availability-rules`,
      params: { id },
      token: world.users[role].token,
    });
    expect(res.status).toBe(status);
  });

  it.each<[Who, number]>([
    ["owner", 403],
    ["provider", 403],
    ["otherStaff", 403],
    ["staff", 201],
    ["admin", 201],
  ])("lets %s create rules and exceptions with status %i", async (role, status) => {
    const id = world.provider.providerId;
    const token = world.users[role].token;
    const rule = await call(createRule, {
      method: "POST",
      path: `/api/providers/${id}/availability-rules`,
      params: { id },
      token,
      body: {
        weekday: 1,
        startLocal: "14:00",
        endLocal: "16:00",
        slotMinutes: 30,
        validFrom: "2026-07-01",
      },
    });
    const exception = await call(createException, {
      method: "POST",
      path: `/api/providers/${id}/exceptions`,
      params: { id },
      token,
      body: { kind: "CLOSED", localDate: "2026-07-10" },
    });
    expect([rule.status, exception.status]).toEqual([status, status]);
  });

  it("refuses rule edits from staff of another clinic", async () => {
    const rule = await addRule(world.provider.providerId, {
      weekday: 1,
      startLocal: "14:00",
      endLocal: "16:00",
      slotMinutes: 30,
    });
    const edit = (user: TestUser) =>
      call(patchRule, {
        method: "PATCH",
        path: `/api/availability-rules/${rule.id}`,
        params: { id: rule.id },
        token: user.token,
        body: { endLocal: "15:00" },
      });

    expect((await edit(world.users.otherStaff)).status).toBe(403);
    expect((await edit(world.users.staff)).status).toBe(200);
  });

  it("requires a session", async () => {
    const id = world.provider.providerId;
    const path = `/api/providers/${id}/availability-rules`;
    const res = await call(listRules, { path, params: { id } });
    expect(res.status).toBe(401);
  });
});
