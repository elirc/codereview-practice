import { describe, expect, it } from "vitest";
import { rulesConflict, ruleShapeProblems } from "@/domain/availability";
import type { RuleSpec } from "@/domain/slots";

function rule(overrides: Partial<RuleSpec> = {}): RuleSpec {
  return {
    weekday: 2,
    startLocal: "09:00",
    endLocal: "12:00",
    slotMinutes: 30,
    validFrom: "2026-07-01",
    validTo: null,
    ...overrides,
  };
}

describe("rule conflicts", () => {
  it("flags overlapping wall-clock windows on the same weekday", () => {
    expect(rulesConflict(rule(), rule({ startLocal: "11:30", endLocal: "13:00" }))).toBe(true);
  });

  it("allows windows that only touch", () => {
    expect(rulesConflict(rule(), rule({ startLocal: "12:00", endLocal: "13:00" }))).toBe(false);
  });

  it("allows the same hours on a different weekday", () => {
    expect(rulesConflict(rule(), rule({ weekday: 3 }))).toBe(false);
  });

  it("allows the same hours in validity periods that do not intersect", () => {
    const july = rule({ validTo: "2026-07-31" });
    const august = rule({ validFrom: "2026-08-01" });
    expect(rulesConflict(july, august)).toBe(false);
  });

  it("allows intersecting periods that contain no date of that weekday", () => {
    // 2026-07-08 is a Wednesday; the shared period 07-08..07-10 has no Tuesday.
    const first = rule({ validTo: "2026-07-10" });
    const second = rule({ validFrom: "2026-07-08", validTo: "2026-07-12" });
    expect(rulesConflict(first, second)).toBe(false);
    expect(rulesConflict(first, rule({ validFrom: "2026-07-07" }))).toBe(true);
  });
});

describe("rule shape", () => {
  it("requires the window to end after it starts", () => {
    expect(ruleShapeProblems(rule({ endLocal: "09:00" }))).toEqual([
      { path: "endLocal", message: "Must be later than startLocal" },
    ]);
  });

  it("requires validTo to be on or after validFrom", () => {
    expect(ruleShapeProblems(rule({ validTo: "2026-06-30" }))).toHaveLength(1);
    expect(ruleShapeProblems(rule({ validTo: "2026-07-01" }))).toHaveLength(0);
  });
});
