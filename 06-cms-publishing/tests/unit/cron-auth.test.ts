import { describe, expect, it } from "vitest";
import { isValidBearer } from "@/http/cron-auth";

const SECRET = "s3cret-value-that-is-long-enough-0123";
const PREVIOUS = "older-secret-value-still-accepted-4567";
const SECRETS = [SECRET];

describe("isValidBearer", () => {
  it("accepts the exact secret", () => {
    expect(isValidBearer(`Bearer ${SECRET}`, SECRETS)).toBe(true);
  });

  it("rejects a missing or non-bearer header", () => {
    expect(isValidBearer(null, SECRETS)).toBe(false);
    expect(isValidBearer("", SECRETS)).toBe(false);
    expect(isValidBearer(`Basic ${SECRET}`, SECRETS)).toBe(false);
    expect(isValidBearer(`bearer ${SECRET}`, SECRETS)).toBe(false);
  });

  it("rejects a wrong secret of the same length", () => {
    const wrong = SECRET.slice(0, -1) + "4";
    expect(wrong).toHaveLength(SECRET.length);
    expect(isValidBearer(`Bearer ${wrong}`, SECRETS)).toBe(false);
  });

  it("rejects shorter and longer secrets without throwing", () => {
    expect(() => isValidBearer("Bearer x", SECRETS)).not.toThrow();
    expect(isValidBearer("Bearer x", SECRETS)).toBe(false);
    expect(isValidBearer(`Bearer ${SECRET}extra`, SECRETS)).toBe(false);
    expect(isValidBearer("Bearer ", SECRETS)).toBe(false);
  });

  it("compares bytes, so multi-byte characters of equal string length do not match", () => {
    const lookalike = SECRET.slice(0, -1) + "é";
    expect(isValidBearer(`Bearer ${lookalike}`, SECRETS)).toBe(false);
  });

  it("accepts any of several secrets while one is being rotated out", () => {
    expect(isValidBearer(`Bearer ${SECRET}`, [SECRET, PREVIOUS])).toBe(true);
    expect(isValidBearer(`Bearer ${PREVIOUS}`, [SECRET, PREVIOUS])).toBe(true);
    expect(isValidBearer(`Bearer ${PREVIOUS}`, [SECRET])).toBe(false);
  });
});
