import { DateTime } from "luxon";
import type { LocalDate } from "@/domain/time";

/** Postgres `date` columns arrive from Prisma as midnight UTC. */
export function fromDbDate(value: Date): LocalDate {
  return value.toISOString().slice(0, 10);
}

export function toDbDate(value: LocalDate): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

export function fromDbInstant(value: Date): DateTime {
  return DateTime.fromJSDate(value, { zone: "utc" });
}

export function isoInstant(value: Date | DateTime): string {
  return (value instanceof Date ? value : value.toJSDate()).toISOString();
}
