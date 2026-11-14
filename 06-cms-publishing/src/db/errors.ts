type PostgresErrorLike = { code?: unknown; constraint_name?: unknown };

/** True for a Postgres unique violation (23505), optionally on a specific constraint. */
export function isUniqueViolation(err: unknown, constraint?: string): boolean {
  if (typeof err !== "object" || err === null) return false;
  const pgErr = err as PostgresErrorLike;
  if (pgErr.code !== "23505") return false;
  return constraint === undefined || pgErr.constraint_name === constraint;
}
