import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // Only pick up Vitest unit specs (*.test.ts). The DB-backed integration
    // tests use the node:test runner and are named `test-*.ts`, so they are
    // intentionally excluded here and run via their own `test-*` scripts.
    include: ["src/**/*.test.ts"],
  },
});
