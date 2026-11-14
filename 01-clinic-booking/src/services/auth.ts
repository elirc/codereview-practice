import { randomBytes } from "node:crypto";
import type { DateTime } from "luxon";
import { toActor, type Actor } from "@/server/auth/actor";
import { hashPassword, verifyPassword } from "@/server/auth/password";
import { createSession } from "@/server/auth/session";
import { db } from "@/server/db";
import { isUniqueViolation } from "@/server/db-errors";
import { AppError } from "@/server/errors";

export interface RegisterInput {
  email: string;
  password: string;
  fullName: string;
  timezone: string;
  phone?: string;
}

export interface AuthResult {
  actor: Actor;
  token: string;
  expiresAt: Date;
}

function emailTaken(): AppError {
  return new AppError("email_taken", "An account with this email already exists.");
}

export async function registerPatient(input: RegisterInput, now: DateTime): Promise<AuthResult> {
  const existing = await db.user.findUnique({ where: { email: input.email } });
  if (existing) throw emailTaken();

  const passwordHash = await hashPassword(input.password);
  const user = await db.user
    .create({
      data: {
        email: input.email,
        passwordHash,
        role: "PATIENT",
        patient: {
          create: { fullName: input.fullName, timezone: input.timezone, phone: input.phone },
        },
      },
      include: { patient: true, provider: true },
    })
    .catch((err: unknown) => {
      throw isUniqueViolation(err) ? emailTaken() : err;
    });

  const session = await createSession(user.id, now);
  return { actor: toActor(user), ...session };
}

let dummyHash: Promise<string> | undefined;

// Unknown emails still pay for one scrypt run so timing does not reveal which emails exist.
function getDummyHash(): Promise<string> {
  dummyHash ??= hashPassword(randomBytes(16).toString("hex"));
  return dummyHash;
}

export async function login(email: string, password: string, now: DateTime): Promise<AuthResult> {
  const user = await db.user.findUnique({
    where: { email },
    include: { patient: true, provider: true },
  });
  const ok = await verifyPassword(password, user?.passwordHash ?? (await getDummyHash()));
  if (!user || !ok) {
    throw new AppError("invalid_credentials", "Email or password is incorrect.");
  }
  const session = await createSession(user.id, now);
  return { actor: toActor(user), ...session };
}

export async function getProfile(actor: Actor) {
  const user = await db.user.findUniqueOrThrow({
    where: { id: actor.userId },
    include: { patient: true, provider: true, clinic: true },
  });
  return {
    id: user.id,
    email: user.email,
    role: user.role,
    clinicId: user.clinicId,
    clinicName: user.clinic?.name ?? null,
    patient: user.patient
      ? {
          id: user.patient.id,
          fullName: user.patient.fullName,
          phone: user.patient.phone,
          timezone: user.patient.timezone,
        }
      : null,
    provider: user.provider
      ? {
          id: user.provider.id,
          displayName: user.provider.displayName,
          specialty: user.provider.specialty,
        }
      : null,
  };
}
