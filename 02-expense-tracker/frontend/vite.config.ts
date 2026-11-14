import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5172,
    proxy: {
      "/api": "http://localhost:8002",
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
