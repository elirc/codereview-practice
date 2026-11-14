import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const databaseUrl =
  process.env.TEST_DATABASE_URL ?? "postgres://cms:cms@localhost:5456/cms_test";

export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    environment: "node",
    include: ["tests/integration/**/*.test.ts"],
    globalSetup: ["tests/integration/global-setup.ts"],
    setupFiles: ["tests/integration/setup.ts"],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
    env: {
      DATABASE_URL: databaseUrl,
      CRON_SECRET: "integration-test-cron-secret-0123456789",
      STORAGE_DRIVER: "memory",
      S3_ENDPOINT: "http://localhost:9006",
      S3_REGION: "us-east-1",
      S3_BUCKET: "cms-media",
      S3_ACCESS_KEY_ID: "unused",
      S3_SECRET_ACCESS_KEY: "unused",
      LOG_LEVEL: "silent",
    },
  },
});
