import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    setupFiles: ["src/__tests__/setup.ts"],
    pool: "forks",
    forks: { singleFork: true },
  },
});
