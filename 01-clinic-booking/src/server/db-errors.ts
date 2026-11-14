import { Prisma } from "@prisma/client";

/** Constraint names defined in the initial migration that the application reacts to. */
export const CONSTRAINTS = {
  providerOverlap: "appointments_provider_no_overlap",
  patientOverlap: "appointments_patient_no_overlap",
  idempotencyKey: "appointments_patient_idempotency_key",
} as const;

export type ConstraintName = (typeof CONSTRAINTS)[keyof typeof CONSTRAINTS];

const KNOWN = Object.values(CONSTRAINTS);

/**
 * Returns the name of the constraint a failed write violated, when it is one we know about.
 *
 * Prisma reports unique violations as P2002 but surfaces exclusion violations (SQLSTATE 23P01)
 * only through the error message, so both the message and the metadata are inspected.
 */
export function violatedConstraint(err: unknown): ConstraintName | null {
  if (
    !(err instanceof Prisma.PrismaClientKnownRequestError) &&
    !(err instanceof Prisma.PrismaClientUnknownRequestError)
  ) {
    return null;
  }
  const meta = err instanceof Prisma.PrismaClientKnownRequestError ? err.meta : undefined;
  const text = `${err.message} ${JSON.stringify(meta ?? {})}`;
  return KNOWN.find((name) => text.includes(name)) ?? null;
}

/** True for Prisma's unique-constraint error, whichever index raised it. */
export function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}
