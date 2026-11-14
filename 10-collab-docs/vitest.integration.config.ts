import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['server/test/integration/**/*.test.ts'],
    environment: 'node',
    globalSetup: ['server/test/integration/globalSetup.ts'],
    fileParallelism: false,
    testTimeout: 15_000,
    hookTimeout: 15_000,
  },
});
