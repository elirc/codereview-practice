import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    environment: "node",
    include: ["tests/unit/**/*.test.ts"],
    env: {
      DATABASE_URL: "postgres://cms:cms@localhost:5456/cms_test",
      CRON_SECRET: "unit-test-cron-secret-0123456789abcdef",
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
