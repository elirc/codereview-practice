import { sql, type RawBuilder } from 'kysely';

/**
 * Renders a timestamptz column as `YYYY-MM-DDTHH:MM:SS.ffffffZ` so cursors keep the full
 * microsecond precision that a JS Date would drop.
 */
export function isoMicros(column: string): RawBuilder<string> {
  return sql<string>`to_char(${sql.ref(column)} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
}
