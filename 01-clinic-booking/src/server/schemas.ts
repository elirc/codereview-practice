import { z } from "zod";
import { daysBetween, wallTimeToMinutes } from "@/domain/time";
import { localDate, slotMinutes, wallTime } from "./validation";

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
