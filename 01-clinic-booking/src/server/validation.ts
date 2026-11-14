import { IANAZone } from "luxon";
import { z } from "zod";
import { notFound } from "./errors";

export const uuid = z.string().uuid();

export const email = z.string().trim().toLowerCase().email().max(254);

export const password = z.string().min(10, "Must be at least 10 characters").max(200);

export const ianaZone = z
  .string()
  .min(1)
  .max(64)
  .refine((value) => IANAZone.isValidZone(value), "Must be a valid IANA time zone");

/** Path ids that are not UUIDs cannot exist, so they are reported exactly like missing rows. */
export function parseId(raw: string | undefined, what = "Resource"): string {
  if (!raw || !uuid.safeParse(raw).success) throw notFound(what);
  return raw;
}
