import type { RuleSpec } from "./slots";
import { addDays, daysBetween, isoWeekday, wallTimeToMinutes, type LocalDate } from "./time";

export interface ShapeProblem {
  path: string;
  message: string;
}

/** Cross-field checks on a complete rule; field formats are validated at the boundary. */
export function ruleShapeProblems(rule: RuleSpec): ShapeProblem[] {
  const problems: ShapeProblem[] = [];
  if (wallTimeToMinutes(rule.startLocal) >= wallTimeToMinutes(rule.endLocal)) {
    problems.push({ path: "endLocal", message: "Must be later than startLocal" });
  }
  if (rule.validTo !== null && rule.validTo < rule.validFrom) {
    problems.push({ path: "validTo", message: "Must not be earlier than validFrom" });
  }
  return problems;
}

function laterOf(a: LocalDate, b: LocalDate): LocalDate {
  return a > b ? a : b;
}

function earlierOf(a: LocalDate | null, b: LocalDate | null): LocalDate | null {
  if (a === null) return b;
  if (b === null) return a;
  return a < b ? a : b;
}

function sharesWeekdayDate(a: RuleSpec, b: RuleSpec): boolean {
  const from = laterOf(a.validFrom, b.validFrom);
  const to = earlierOf(a.validTo, b.validTo);
  if (to === null || daysBetween(from, to) >= 6) return true;
  for (let date = from; date <= to; date = addDays(date, 1)) {
    if (isoWeekday(date) === a.weekday) return true;
  }
  return false;
}

/** Two rules conflict when their wall-clock windows overlap on some date where both apply. */
export function rulesConflict(a: RuleSpec, b: RuleSpec): boolean {
  if (a.weekday !== b.weekday) return false;
  const windowsOverlap =
    wallTimeToMinutes(a.startLocal) < wallTimeToMinutes(b.endLocal) &&
    wallTimeToMinutes(b.startLocal) < wallTimeToMinutes(a.endLocal);
  return windowsOverlap && sharesWeekdayDate(a, b);
}
