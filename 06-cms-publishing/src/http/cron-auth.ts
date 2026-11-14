import { timingSafeEqual } from "node:crypto";

const BEARER_PREFIX = "Bearer ";

/** Checks an `Authorization: Bearer <secret>` header against the configured secret. */
export function isValidBearer(header: string | null, secret: string): boolean {
  if (!header || !header.startsWith(BEARER_PREFIX)) return false;
  const provided = Buffer.from(header.slice(BEARER_PREFIX.length), "utf8");
  const expected = Buffer.from(secret, "utf8");
  if (provided.length !== expected.length) {
    timingSafeEqual(expected, expected);
    return false;
  }
  return timingSafeEqual(provided, expected);
}
