import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const ROOT = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    // Mirror the tsconfig "@/*" → "./*" path alias so tests can import (or
    // vi.mock) project modules by their "@/..." specifier.
    alias: { "@": ROOT },
  },
  test: {
    environment: "node",
    include: ["**/*.test.ts"],
    exclude: ["node_modules/**", "dist/**", "web-dist/**", ".expo/**"],
  },
});
