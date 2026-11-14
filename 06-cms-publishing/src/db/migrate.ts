import { fileURLToPath, pathToFileURL } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

const migrationsFolder = fileURLToPath(new URL("../../drizzle", import.meta.url));

/** Applies every pending migration in `drizzle/` to the given database. */
export async function runMigrations(databaseUrl: string): Promise<void> {
  const client = postgres(databaseUrl, { max: 1, onnotice: () => {} });
  try {
    await migrate(drizzle(client), { migrationsFolder });
  } finally {
    await client.end();
  }
}

async function main() {
  const { getEnv } = await import("@/env");
  const { logger } = await import("@/logger");
  logger.info({ migrationsFolder }, "applying migrations");
  await runMigrations(getEnv().DATABASE_URL);
  logger.info("migrations applied");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
