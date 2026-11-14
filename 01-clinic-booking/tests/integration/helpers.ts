import { randomBytes } from "node:crypto";
import type { Role } from "@prisma/client";
import { DateTime } from "luxon";
import { vi } from "vitest";
import { hashPassword } from "@/server/auth/password";
import { hashToken } from "@/server/auth/session";
import { clock } from "@/server/clock";
import { db } from "@/server/db";

export const ORIGIN = "http://localhost:3000";
export const PASSWORD = "correct-horse-battery";

let cachedHash: Promise<string> | undefined;
let sequence = 0;

function passwordHash(): Promise<string> {
  cachedHash ??= hashPassword(PASSWORD);
  return cachedHash;
}

export async function resetDatabase(): Promise<void> {
  await db.$executeRaw`TRUNCATE TABLE reminders, appointments, availability_exceptions, availability_rules, sessions, patients, providers, users, clinics CASCADE`;
}

export function freezeTime(iso: string): DateTime {
  const now = DateTime.fromISO(iso, { setZone: true }).toUTC();
  vi.spyOn(clock, "now").mockReturnValue(now);
  return now;
}

export interface TestUser {
  userId: string;
  email: string;
  token: string;
}

async function createUser(role: Role, clinicId: string | null, label: string): Promise<TestUser> {
  sequence += 1;
  const email = `${label}-${sequence}@example.test`;
  const user = await db.user.create({
    data: { email, role, clinicId, passwordHash: await passwordHash() },
  });
  const token = randomBytes(24).toString("base64url");
  await db.session.create({
    data: { userId: user.id, tokenHash: hashToken(token), expiresAt: new Date("2100-01-01") },
  });
  return { userId: user.id, email, token };
}

export interface ClinicFixture {
  name?: string;
  timezone?: string;
  minLeadMinutes?: number;
  bookingHorizonDays?: number;
}

export async function createClinic(data: ClinicFixture = {}) {
  return db.clinic.create({
    data: { name: "Harbour Clinic", timezone: "America/New_York", ...data },
  });
}

export async function createPatient(
  opts: { timezone?: string; fullName?: string } = {},
): Promise<TestUser & { patientId: string }> {
  const user = await createUser("PATIENT", null, "patient");
  const patient = await db.patient.create({
    data: {
      userId: user.userId,
      fullName: opts.fullName ?? `Patient ${sequence}`,
      timezone: opts.timezone ?? "America/New_York",
    },
  });
  return { ...user, patientId: patient.id };
}

export async function createProvider(
  clinicId: string,
  opts: { active?: boolean; displayName?: string } = {},
): Promise<TestUser & { providerId: string }> {
  const user = await createUser("PROVIDER", clinicId, "provider");
  const provider = await db.provider.create({
    data: {
      userId: user.userId,
      clinicId,
      displayName: opts.displayName ?? `Dr. Provider ${sequence}`,
      specialty: "General practice",
      active: opts.active ?? true,
    },
  });
  return { ...user, providerId: provider.id };
}

export function createStaff(clinicId: string): Promise<TestUser> {
  return createUser("STAFF", clinicId, "staff");
}

export function createAdmin(): Promise<TestUser> {
  return createUser("ADMIN", null, "admin");
}

export interface RuleFixture {
  weekday: number;
  startLocal: string;
  endLocal: string;
  slotMinutes: number;
  validFrom?: string;
  validTo?: string | null;
}

export async function addRule(providerId: string, rule: RuleFixture) {
  return db.availabilityRule.create({
    data: {
      providerId,
      weekday: rule.weekday,
      startLocal: rule.startLocal,
      endLocal: rule.endLocal,
      slotMinutes: rule.slotMinutes,
      validFrom: new Date(`${rule.validFrom ?? "2026-01-01"}T00:00:00Z`),
      validTo: rule.validTo ? new Date(`${rule.validTo}T00:00:00Z`) : null,
    },
  });
}

/** Adds the same rule for Monday through Sunday. */
export async function addDailyRule(providerId: string, rule: Omit<RuleFixture, "weekday">) {
  for (let weekday = 1; weekday <= 7; weekday += 1) {
    await addRule(providerId, { ...rule, weekday });
  }
}

type Handler<P> = (req: Request, ctx: { params: Promise<P> }) => Promise<Response>;

export interface CallOptions<P> {
  method?: string;
  path: string;
  token?: string;
  body?: unknown;
  params?: P;
  headers?: Record<string, string>;
}

export interface CallResult {
  status: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
  headers: Headers;
}

/** Invokes a route handler the way the App Router would, with a same-origin JSON request. */
export async function call<P extends Record<string, string>>(
  handler: Handler<P>,
  opts: CallOptions<P>,
): Promise<CallResult> {
  const method = opts.method ?? "GET";
  const headers = new Headers(opts.headers);
  if (method !== "GET") {
    if (!headers.has("content-type")) headers.set("content-type", "application/json");
    if (!headers.has("origin")) headers.set("origin", ORIGIN);
  }
  if (opts.token) headers.set("cookie", `cb_session=${opts.token}`);
  const req = new Request(`${ORIGIN}${opts.path}`, {
    method,
    headers,
    body: method === "GET" ? undefined : JSON.stringify(opts.body ?? {}),
  });
  const res = await handler(req, { params: Promise.resolve((opts.params ?? {}) as P) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers };
}
