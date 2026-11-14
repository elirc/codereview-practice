import { DateTime } from "luxon";
import { describe, expect, it } from "vitest";
import {
  addDays,
  daysBetween,
  enumerateDates,
  isoWeekday,
  localDateOf,
  localDayRange,
  localDayStart,
  overlaps,
  resolveLocal,
} from "@/domain/time";

const NEW_YORK = "America/New_York";
const SYDNEY = "Australia/Sydney";

function iso(value: DateTime | null): string | null {
  return value ? value.toUTC().toFormat("yyyy-MM-dd'T'HH:mm'Z'") : null;
}

function utc(value: string): DateTime {
  return DateTime.fromISO(value, { zone: "utc" });
}

describe("resolveLocal", () => {
  it("maps an ordinary wall time to its single instant", () => {
    expect(iso(resolveLocal("2026-07-01", "09:00", NEW_YORK))).toBe("2026-07-01T13:00Z");
    expect(iso(resolveLocal("2026-07-01", "09:00", SYDNEY))).toBe("2026-06-30T23:00Z");
  });

  it("returns null for wall times skipped by a forward transition", () => {
    expect(resolveLocal("2026-03-08", "02:00", NEW_YORK)).toBeNull();
    expect(resolveLocal("2026-03-08", "02:30", NEW_YORK)).toBeNull();
    expect(resolveLocal("2026-10-04", "02:30", SYDNEY)).toBeNull();
  });

  it("keeps the times either side of a forward transition", () => {
    expect(iso(resolveLocal("2026-03-08", "01:59", NEW_YORK))).toBe("2026-03-08T06:59Z");
    expect(iso(resolveLocal("2026-03-08", "03:00", NEW_YORK))).toBe("2026-03-08T07:00Z");
  });

  it("picks the first occurrence of a wall time repeated by a backward transition", () => {
    expect(iso(resolveLocal("2026-11-01", "01:30", NEW_YORK))).toBe("2026-11-01T05:30Z");
    expect(iso(resolveLocal("2026-04-05", "02:30", SYDNEY))).toBe("2026-04-04T15:30Z");
  });

  it("handles fixed-offset zones", () => {
    expect(iso(resolveLocal("2026-03-08", "02:30", "UTC"))).toBe("2026-03-08T02:30Z");
    expect(iso(resolveLocal("2026-03-08", "08:00", "Asia/Tokyo"))).toBe("2026-03-07T23:00Z");
  });
});

describe("local days", () => {
  function hours(date: string, zone: string): number {
    const { start, end } = localDayRange(date, zone);
    return end.diff(start, "hours").hours;
  }

  it("is 24 hours on an ordinary day", () => {
    expect(hours("2026-07-01", NEW_YORK)).toBe(24);
  });

  it("is 23 hours on spring-forward days in both hemispheres", () => {
    expect(hours("2026-03-08", NEW_YORK)).toBe(23);
    expect(hours("2026-10-04", SYDNEY)).toBe(23);
  });

  it("is 25 hours on fall-back days in both hemispheres", () => {
    expect(hours("2026-11-01", NEW_YORK)).toBe(25);
    expect(hours("2026-04-05", SYDNEY)).toBe(25);
  });

  it("starts at the transition when midnight itself is skipped", () => {
    expect(iso(localDayStart("2018-11-04", "America/Sao_Paulo"))).toBe("2018-11-04T03:00Z");
    expect(hours("2018-11-04", "America/Sao_Paulo")).toBe(23);
  });

  it("starts at local midnight", () => {
    const { start, end } = localDayRange("2026-11-01", NEW_YORK);
    expect(iso(start)).toBe("2026-11-01T04:00Z");
    expect(iso(end)).toBe("2026-11-02T05:00Z");
  });
});

describe("civil date helpers", () => {
  it("adds days across month and year ends", () => {
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
  });

  it("uses ISO weekdays", () => {
    expect(isoWeekday("2026-03-09")).toBe(1);
    expect(isoWeekday("2026-03-08")).toBe(7);
  });

  it("reads the local date of an instant in a zone", () => {
    const instant = utc("2026-07-02T03:30:00");
    expect(localDateOf(instant, NEW_YORK)).toBe("2026-07-01");
    expect(localDateOf(instant, "Asia/Tokyo")).toBe("2026-07-02");
  });

  it("enumerates an inclusive range", () => {
    expect(daysBetween("2026-03-07", "2026-03-09")).toBe(2);
    expect(enumerateDates("2026-03-07", "2026-03-09")).toEqual([
      "2026-03-07",
      "2026-03-08",
      "2026-03-09",
    ]);
  });
});

describe("overlaps", () => {
  const range = (start: string, end: string) => ({ startsAt: utc(start), endsAt: utc(end) });

  it("treats ranges that only touch as disjoint", () => {
    const first = range("2026-01-01T09:00", "2026-01-01T09:30");
    const second = range("2026-01-01T09:30", "2026-01-01T10:00");
    expect(overlaps(first, second)).toBe(false);
    expect(overlaps(second, first)).toBe(false);
  });

  it("detects partial overlap", () => {
    const first = range("2026-01-01T09:00", "2026-01-01T10:00");
    const second = range("2026-01-01T09:30", "2026-01-01T10:30");
    expect(overlaps(first, second)).toBe(true);
  });
});
