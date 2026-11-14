import type { PgDatabase } from "drizzle-orm/pg-core";
import { drizzle, type PostgresJsQueryResultHKT } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { getEnv } from "@/env";
import * as schema from "./schema";

function createClient() {
  return postgres(getEnv().DATABASE_URL, { max: 10, onnotice: () => {} });
}

// Reuse one pool across hot reloads in development.
const globalForDb = globalThis as unknown as { cmsSql?: ReturnType<typeof createClient> };
const sqlClient = globalForDb.cmsSql ?? createClient();
if (getEnv().NODE_ENV !== "production") globalForDb.cmsSql = sqlClient;

export const db = drizzle(sqlClient, { schema });

export type Database = typeof db;
/** Either the pool-level database or an open transaction. */
export type Executor = PgDatabase<PostgresJsQueryResultHKT, typeof schema>;

export async function closeDb(): Promise<void> {
  await sqlClient.end({ timeout: 5 });
  globalForDb.cmsSql = undefined;
}
