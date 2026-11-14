import type { Actor } from "@/server/auth/actor";
import { hashPassword } from "@/server/auth/password";
import { db } from "@/server/db";
import { isUniqueViolation } from "@/server/db-errors";
import { AppError, forbidden, notFound } from "@/server/errors";
import { getClinic } from "./clinics";

function assertAdmin(actor: Actor): void {
  if (actor.role !== "ADMIN") throw forbidden();
}

function emailTaken(): AppError {
  return new AppError("email_taken", "An account with this email already exists.");
}

export interface ClinicInput {
  name: string;
  timezone: string;
  minLeadMinutes?: number;
  bookingHorizonDays?: number;
}

export type ClinicPatch = Partial<Omit<ClinicInput, "timezone">>;

export async function createClinic(actor: Actor, input: ClinicInput) {
  assertAdmin(actor);
  return db.clinic.create({ data: input });
}

export async function updateClinic(actor: Actor, clinicId: string, patch: ClinicPatch) {
  assertAdmin(actor);
  await getClinic(clinicId);
  return db.clinic.update({ where: { id: clinicId }, data: patch });
}

export const providerListInclude = { clinic: true, user: { select: { email: true } } } as const;

export async function listAllProviders(actor: Actor) {
  assertAdmin(actor);
  return db.provider.findMany({
    include: providerListInclude,
    orderBy: [{ clinic: { name: "asc" } }, { displayName: "asc" }],
  });
}

export interface ProviderInput {
  email: string;
  password: string;
  clinicId: string;
  displayName: string;
  specialty: string;
}

export async function createProvider(actor: Actor, input: ProviderInput) {
  assertAdmin(actor);
  await getClinic(input.clinicId);
  try {
    const user = await db.user.create({
      data: {
        email: input.email,
        passwordHash: await hashPassword(input.password),
        role: "PROVIDER",
        clinicId: input.clinicId,
        provider: {
          create: {
            clinicId: input.clinicId,
            displayName: input.displayName,
            specialty: input.specialty,
          },
        },
      },
      include: { provider: { include: providerListInclude } },
    });
    if (!user.provider) throw new Error("provider row was not created");
    return user.provider;
  } catch (err) {
    if (isUniqueViolation(err)) throw emailTaken();
    throw err;
  }
}

export interface ProviderPatch {
  displayName?: string;
  specialty?: string;
  active?: boolean;
}

export async function updateProvider(actor: Actor, providerId: string, patch: ProviderPatch) {
  assertAdmin(actor);
  const existing = await db.provider.findUnique({ where: { id: providerId } });
  if (!existing) throw notFound("Provider");
  return db.provider.update({
    where: { id: providerId },
    data: patch,
    include: providerListInclude,
  });
}

export interface StaffInput {
  email: string;
  password: string;
  clinicId: string;
}

export async function createStaff(actor: Actor, input: StaffInput) {
  assertAdmin(actor);
  await getClinic(input.clinicId);
  try {
    return await db.user.create({
      data: {
        email: input.email,
        passwordHash: await hashPassword(input.password),
        role: "STAFF",
        clinicId: input.clinicId,
      },
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw emailTaken();
    throw err;
  }
}

export async function listStaff(actor: Actor) {
  assertAdmin(actor);
  return db.user.findMany({
    where: { role: "STAFF" },
    include: { clinic: true },
    orderBy: { email: "asc" },
  });
}
