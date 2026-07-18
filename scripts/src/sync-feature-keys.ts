/**
 * Keep the OpenAPI `FeatureKey` enum in sync with the single source of truth in
 * `lib/feature-keys/src/index.ts`.
 *
 * Why this exists:
 *   `FEATURE_KEYS` already drives the `FeatureKey` TypeScript union shared by the
 *   admin portal, mobile app, and API server. But `lib/api-spec/openapi.yaml`
 *   carries its own hand-maintained `FeatureKey` enum that feeds Orval codegen
 *   (the generated React Query hooks + Zod schemas). A developer who adds a key
 *   to `FEATURE_KEYS` would otherwise have to remember to edit the YAML by hand,
 *   and the drift would only surface on the next codegen run.
 *
 *   This script rewrites the enum block between the
 *   `# >>> FEATURE_KEYS:START ... <<<` / `# >>> FEATURE_KEYS:END <<<` markers in
 *   `openapi.yaml` from `FEATURE_KEYS`, so adding a key in one place is enough.
 *   It runs automatically as a pre-step of the `@workspace/api-spec` codegen
 *   script, and can also be used as a CI lint via `--check`.
 *
 * Usage:
 *   pnpm --filter @workspace/scripts run sync-feature-keys           # rewrite YAML
 *   pnpm --filter @workspace/scripts run sync-feature-keys -- --check # assert in sync (CI)
 *
 * Exit codes: 0 = in sync / written; 1 = drift (in --check mode) or error.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { FEATURE_KEYS } from "@workspace/feature-keys";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const OPENAPI_PATH = path.resolve(repoRoot, "lib", "api-spec", "openapi.yaml");

const START_MARKER = "# >>> FEATURE_KEYS:START";
const END_MARKER = "# >>> FEATURE_KEYS:END <<<";

/**
 * Build the YAML lines for the enum block, preserving the leading indentation of
 * the `FeatureKey:` schema (6 spaces for the schema key, 8 for nested props).
 */
function buildEnumLines(): string {
  const lines = [
    "    FeatureKey:",
    "      type: string",
    "      description: >-",
    "        Identifier for an owner-controlled, optionally-paid feature. Single",
    "        source of truth is lib/feature-keys/src/index.ts; this enum is kept in",
    "        sync by the sync-feature-keys script.",
    "      enum:",
    ...FEATURE_KEYS.map((k) => `        - ${k}`),
  ];
  return lines.join("\n");
}

function extractRegion(src: string): { startIdx: number; endIdx: number } {
  const startIdx = src.indexOf(START_MARKER);
  const endIdx = src.indexOf(END_MARKER);
  if (startIdx === -1 || endIdx === -1) {
    throw new Error(
      `Could not find the FEATURE_KEYS markers in ${OPENAPI_PATH}.\n` +
        `Expected both "${START_MARKER} ... <<<" and "${END_MARKER}".`,
    );
  }
  if (endIdx < startIdx) {
    throw new Error(`FEATURE_KEYS:END marker appears before FEATURE_KEYS:START in ${OPENAPI_PATH}.`);
  }
  return { startIdx, endIdx };
}

function render(src: string): string {
  const { startIdx, endIdx } = extractRegion(src);

  // Keep everything up to and including the START marker line, then the start
  // comment block stays as authored. We only regenerate the FeatureKey schema
  // between the end of the START comment block and the END marker.
  const beforeEndMarker = src.slice(0, endIdx);
  const fromEndMarker = src.slice(endIdx);

  // Find the line that starts the FeatureKey schema so we replace exactly the
  // enum schema (not the explanatory START comment lines above it).
  const schemaStart = beforeEndMarker.indexOf("    FeatureKey:", startIdx);
  if (schemaStart === -1) {
    throw new Error(
      `Found FEATURE_KEYS markers but no "    FeatureKey:" schema between them in ${OPENAPI_PATH}.`,
    );
  }

  const head = beforeEndMarker.slice(0, schemaStart);
  return `${head}${buildEnumLines()}\n    ${fromEndMarker}`;
}

function main(): void {
  const checkMode = process.argv.includes("--check");
  const src = readFileSync(OPENAPI_PATH, "utf8");
  const next = render(src);

  if (next === src) {
    console.log("✓ openapi.yaml FeatureKey enum is in sync with FEATURE_KEYS.");
    return;
  }

  if (checkMode) {
    console.error(
      "✗ openapi.yaml FeatureKey enum is OUT OF SYNC with lib/feature-keys/src/index.ts.\n" +
        "  Run: pnpm --filter @workspace/scripts run sync-feature-keys",
    );
    process.exit(1);
  }

  writeFileSync(OPENAPI_PATH, next, "utf8");
  console.log(
    `✓ Synced openapi.yaml FeatureKey enum from FEATURE_KEYS (${FEATURE_KEYS.length} keys).`,
  );
}

main();
