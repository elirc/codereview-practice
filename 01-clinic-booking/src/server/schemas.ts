import { z } from "zod";
import { daysBetween, wallTimeToMinutes } from "@/domain/time";
import {
  email,
  ianaZone,
  instant,
  localDate,
  password,
  slotMinutes,
  uuid,
  wallTime,
} from "./validation";

export const MAX_SLOT_RANGE_DAYS = 31;

const ruleFields = {
  weekday: z.number().int().min(1).max(7),
  startLocal: wallTime,
  endLocal: wallTime,
  slotMinutes,
  validFrom: localDate,
  validTo: localDate.nullable().optional(),
};

export const createRuleBody = z.object(ruleFields).strict();

export const updateRuleBody = z.object(ruleFields).partial().strict();

export const createExceptionBody = z
  .discriminatedUnion("kind", [
    z.object({ kind: z.literal("CLOSED"), localDate }).strict(),
    z
      .object({
        kind: z.literal("CUSTOM_HOURS"),
        localDate,
        startLocal: wallTime,
        endLocal: wallTime,
        slotMinutes,
      })
      .strict(),
  ])
  .superRefine((value, ctx) => {
    if (
      value.kind === "CUSTOM_HOURS" &&
      wallTimeToMinutes(value.startLocal) >= wallTimeToMinutes(value.endLocal)
    ) {
      ctx.addIssue({ code: "custom", path: ["endLocal"], message: "Must be after startLocal" });
    }
  });

export const slotRangeQuery = z
  .object({ from: localDate, to: localDate })
  .superRefine((value, ctx) => {
    const span = daysBetween(value.from, value.to);
    if (span < 0) {
      ctx.addIssue({ code: "custom", path: ["to"], message: "Must not be earlier than from" });
    } else if (span + 1 > MAX_SLOT_RANGE_DAYS) {
      ctx.addIssue({
        code: "custom",
        path: ["to"],
        message: `The range may cover at most ${MAX_SLOT_RANGE_DAYS} days`,
      });
    }
  });

export const idempotencyKeyHeader = z.string().min(1).max(64);

const reason = z.string().trim().max(500);

export const bookingBody = z
  .object({
    providerId: uuid,
    startsAt: instant,
    reason: reason.optional(),
    patientId: uuid.optional(),
  })
  .strict();

export const cancelBody = z.object({ reason: reason.optional() }).strict();

export const rescheduleBody = z.object({ providerId: uuid.optional(), startsAt: instant }).strict();

export const appointmentListQuery = z.object({
  scope: z.enum(["mine", "clinic"]).default("mine"),
  date: localDate.optional(),
  providerId: uuid.optional(),
  clinicId: uuid.optional(),
  status: z.enum(["BOOKED", "CANCELLED", "COMPLETED", "NO_SHOW"]).optional(),
});

const clinicSettings = {
  name: z.string().trim().min(1).max(200),
  minLeadMinutes: z.number().int().min(0).max(10_080),
  bookingHorizonDays: z.number().int().min(1).max(730),
};

export const createClinicBody = z
  .object({
    ...clinicSettings,
    timezone: ianaZone,
    minLeadMinutes: clinicSettings.minLeadMinutes.optional(),
    bookingHorizonDays: clinicSettings.bookingHorizonDays.optional(),
  })
  .strict();

export const updateClinicBody = z.object(clinicSettings).partial().strict();

const providerProfile = {
  displayName: z.string().trim().min(1).max(200),
  specialty: z.string().trim().min(1).max(200),
};

export const createProviderBody = z
  .object({ ...providerProfile, email, password, clinicId: uuid })
  .strict();

export const updateProviderBody = z
  .object({ ...providerProfile, active: z.boolean() })
  .partial()
  .strict();

export const createStaffBody = z.object({ email, password, clinicId: uuid }).strict();
