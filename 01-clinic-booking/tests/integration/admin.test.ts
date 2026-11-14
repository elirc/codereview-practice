import { describe, expect, it } from "vitest";
import { PATCH as patchClinic } from "@/app/api/admin/clinics/[id]/route";
import { POST as createClinic } from "@/app/api/admin/clinics/route";
import { PATCH as patchProvider } from "@/app/api/admin/providers/[id]/route";
import { POST as createProvider } from "@/app/api/admin/providers/route";
import { POST as createStaff } from "@/app/api/admin/staff/route";
import { POST as login } from "@/app/api/auth/login/route";
import { db } from "@/server/db";
import {
  call,
  createAdmin,
  createClinic as clinicFixture,
  createStaff as staffFixture,
} from "./helpers";

describe("admin API", () => {
  it("creates a clinic and rejects an unknown time zone", async () => {
    const admin = await createAdmin();
    const created = await call(createClinic, {
      method: "POST",
      path: "/api/admin/clinics",
      token: admin.token,
      body: { name: "Bayside", timezone: "Australia/Sydney", minLeadMinutes: 30 },
    });
    expect(created.status).toBe(201);
    expect(created.body.clinic).toMatchObject({
      name: "Bayside",
      timezone: "Australia/Sydney",
      minLeadMinutes: 30,
      bookingHorizonDays: 90,
    });

    const invalid = await call(createClinic, {
      method: "POST",
      path: "/api/admin/clinics",
      token: admin.token,
      body: { name: "Nowhere", timezone: "Atlantis/Central" },
    });
    expect(invalid.status).toBe(400);
    expect(invalid.body.error.code).toBe("validation_failed");
    expect(invalid.body.error.details.fields[0].path).toBe("timezone");
  });

  it("updates clinic settings but not the time zone", async () => {
    const admin = await createAdmin();
    const clinic = await clinicFixture();
    const params = { id: clinic.id };
    const path = `/api/admin/clinics/${clinic.id}`;

    const updated = await call(patchClinic, {
      method: "PATCH",
      path,
      params,
      token: admin.token,
      body: { minLeadMinutes: 120 },
    });
    expect(updated.body.clinic.minLeadMinutes).toBe(120);

    const rezoned = await call(patchClinic, {
      method: "PATCH",
      path,
      params,
      token: admin.token,
      body: { timezone: "Europe/London" },
    });
    expect(rezoned.status).toBe(400);
  });

  it("creates provider and staff accounts that can sign in", async () => {
    const admin = await createAdmin();
    const clinic = await clinicFixture();

    const provider = await call(createProvider, {
      method: "POST",
      path: "/api/admin/providers",
      token: admin.token,
      body: {
        email: "Dr.Kim@Example.com",
        password: "provider-password",
        clinicId: clinic.id,
        displayName: "Dr. Kim",
        specialty: "Dermatology",
      },
    });
    expect(provider.status).toBe(201);
    expect(provider.body.provider).toMatchObject({ email: "dr.kim@example.com", active: true });

    const staff = await call(createStaff, {
      method: "POST",
      path: "/api/admin/staff",
      token: admin.token,
      body: { email: "desk@example.com", password: "staff-password", clinicId: clinic.id },
    });
    expect(staff.status).toBe(201);
    expect(staff.body.staff).toMatchObject({ role: "STAFF", clinicId: clinic.id });

    const duplicate = await call(createStaff, {
      method: "POST",
      path: "/api/admin/staff",
      token: admin.token,
      body: { email: "desk@example.com", password: "staff-password", clinicId: clinic.id },
    });
    expect(duplicate.status).toBe(409);

    const signedIn = await call(login, {
      method: "POST",
      path: "/api/auth/login",
      body: { email: "dr.kim@example.com", password: "provider-password" },
    });
    expect(signedIn.body.user).toMatchObject({ role: "PROVIDER", clinicId: clinic.id });
  });

  it("deactivates a provider", async () => {
    const admin = await createAdmin();
    const clinic = await clinicFixture();
    const created = await call(createProvider, {
      method: "POST",
      path: "/api/admin/providers",
      token: admin.token,
      body: {
        email: "lee@example.com",
        password: "provider-password",
        clinicId: clinic.id,
        displayName: "Dr. Lee",
        specialty: "General practice",
      },
    });
    const id = created.body.provider.id;

    const res = await call(patchProvider, {
      method: "PATCH",
      path: `/api/admin/providers/${id}`,
      params: { id },
      token: admin.token,
      body: { active: false },
    });
    expect(res.body.provider.active).toBe(false);
    expect((await db.provider.findUniqueOrThrow({ where: { id } })).active).toBe(false);
  });

  it("is closed to non-admins", async () => {
    const clinic = await clinicFixture();
    const staff = await staffFixture(clinic.id);
    const res = await call(createClinic, {
      method: "POST",
      path: "/api/admin/clinics",
      token: staff.token,
      body: { name: "Rogue", timezone: "UTC" },
    });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("forbidden");
  });
});
