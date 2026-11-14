import { runMigrations } from "../../src/db/migrate";

export default async function setup() {
  const url = process.env.TEST_DATABASE_URL ?? "postgres://cms:cms@localhost:5456/cms_test";
  await runMigrations(url);
}
