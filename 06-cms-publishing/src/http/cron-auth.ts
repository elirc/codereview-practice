const BEARER_PREFIX = "Bearer ";

function matches(provided: Buffer, secret: string): boolean {
  const expected = Buffer.from(secret, "utf8");
  return provided.length === expected.length && provided.compare(expected) === 0;
}

/** Checks an `Authorization: Bearer <secret>` header against any of the accepted secrets. */
export function isValidBearer(header: string | null, secrets: readonly string[]): boolean {
  if (!header || !header.startsWith(BEARER_PREFIX)) return false;
  const provided = Buffer.from(header.slice(BEARER_PREFIX.length), "utf8");
  return secrets.some((secret) => matches(provided, secret));
}
