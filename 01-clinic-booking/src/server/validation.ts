import { IANAZone } from "luxon";
import { z } from "zod";
import { SLOT_LENGTHS } from "@/domain/slots";
import { isLocalDate, isWallTime } from "@/domain/time";
import { notFound } from "./errors";

export const uuid = z.string().uuid();

export const email = z.string().trim().toLowerCase().email().max(254);

export const password = z.string().min(10, "Must be at least 10 characters").max(200);

export const ianaZone = z
  .string()
  .min(1)
  .max(64)
  .refine((value) => IANAZone.isValidZone(value), "Must be a valid IANA time zone");

export const localDate = z.string().refine(isLocalDate, "Must be a date in YYYY-MM-DD format");

export const wallTime = z.string().refine(isWallTime, "Must be a time in HH:MM format");

export const slotMinutes = z
  .number()
  .int()
  .refine(
    (value) => (SLOT_LENGTHS as readonly number[]).includes(value),
    "Must be one of 15, 20, 30, 45 or 60",
  );

/** Path ids that are not UUIDs cannot exist, so they are reported exactly like missing rows. */
export function parseId(raw: string | undefined, what = "Resource"): string {
  if (!raw || !uuid.safeParse(raw).success) throw notFound(what);
  return raw;
}
