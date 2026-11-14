import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("Set TEST_DATABASE_URL (or DATABASE_URL) to run the integration tests");
}

export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    include: ["tests/integration/**/*.test.ts"],
    environment: "node",
    setupFiles: ["tests/integration/setup.ts"],
    // Every file truncates the same database, so files must not run concurrently.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
    env: {
      NODE_ENV: "test",
      DATABASE_URL: databaseUrl,
      APP_ORIGIN: "http://localhost:3000",
      LOG_LEVEL: "silent",
      MAILER: "memory",
      MAIL_FROM: "appointments@clinic.example",
    },
  },
});
