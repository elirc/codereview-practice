import { sql, type RawBuilder } from 'kysely';

const ISO_MICROS = 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"';

/**
 * Renders a timestamptz column as `YYYY-MM-DDTHH:MM:SS.ffffffZ` so cursors keep the full
 * microsecond precision that a JS Date would drop.
 */
export function isoMicros(column: string): RawBuilder<string> {
  return sql<string>`to_char(${sql.ref(column)} at time zone 'UTC', ${sql.lit(ISO_MICROS)})`;
}

export type SortDirection = 'asc' | 'desc';

/**
 * Keyset predicate for the rows that follow (`value`, `id`) when ordered by `column` and then
 * `idColumn`, both in `direction`. Spelled out with OR/AND rather than a row comparison so
 * the planner can use the leading column of the composite indexes.
 */
export function keysetAfter(
  column: string,
  idColumn: string,
  direction: SortDirection,
  value: RawBuilder<unknown>,
  id: string,
): RawBuilder<boolean> {
  const beyond = sql.raw(direction === 'desc' ? '<' : '>');
  return sql<boolean>`(
    ${sql.ref(column)} ${beyond} ${value}
    or (${sql.ref(column)} = ${value} and ${sql.ref(idColumn)} < ${id}::uuid)
  )`;
}

/** A cursor timestamp as a bound timestamptz value. */
export function timestampValue(value: string | number): RawBuilder<unknown> {
  return sql`${value}::timestamptz`;
}
