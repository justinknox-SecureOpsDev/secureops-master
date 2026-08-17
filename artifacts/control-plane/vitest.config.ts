import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Serialize test FILE execution so concurrent ensureSchema() calls in
    // separate beforeAll hooks don't race on CREATE TABLE (which creates an
    // implicit Postgres composite type; two concurrent CREATE TABLE IF NOT
    // EXISTS for the same table can still collide on pg_type).
    fileParallelism: false,
    globalSetup: "./src/__tests__/globalSetup.ts",
  },
});
