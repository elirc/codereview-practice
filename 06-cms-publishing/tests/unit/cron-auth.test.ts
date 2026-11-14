import { describe, expect, it } from "vitest";
import { isValidBearer } from "@/http/cron-auth";

const SECRET = "s3cret-value-that-is-long-enough-0123";

describe("isValidBearer", () => {
  it("accepts the exact secret", () => {
    expect(isValidBearer(`Bearer ${SECRET}`, SECRET)).toBe(true);
  });

  it("rejects a missing or non-bearer header", () => {
    expect(isValidBearer(null, SECRET)).toBe(false);
    expect(isValidBearer("", SECRET)).toBe(false);
    expect(isValidBearer(`Basic ${SECRET}`, SECRET)).toBe(false);
    expect(isValidBearer(`bearer ${SECRET}`, SECRET)).toBe(false);
  });

  it("rejects a wrong secret of the same length", () => {
    const wrong = SECRET.slice(0, -1) + "4";
    expect(wrong).toHaveLength(SECRET.length);
    expect(isValidBearer(`Bearer ${wrong}`, SECRET)).toBe(false);
  });

  it("rejects shorter and longer secrets without throwing", () => {
    expect(() => isValidBearer("Bearer x", SECRET)).not.toThrow();
    expect(isValidBearer("Bearer x", SECRET)).toBe(false);
    expect(isValidBearer(`Bearer ${SECRET}extra`, SECRET)).toBe(false);
    expect(isValidBearer("Bearer ", SECRET)).toBe(false);
  });

  it("compares bytes, so multi-byte characters of equal string length do not match", () => {
    const lookalike = SECRET.slice(0, -1) + "é";
    expect(isValidBearer(`Bearer ${lookalike}`, SECRET)).toBe(false);
  });
});
