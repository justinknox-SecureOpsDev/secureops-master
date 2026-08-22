/**
 * Static UI feature-gate coverage for the admin portal.
 *
 * The server's `requireFeature` middleware is the authoritative gate (see
 * api-server `__tests__/featureGating.test.ts`). The admin portal only HIDES a
 * locked feature, via one of four mechanisms:
 *   - a `feature`-annotated nav entry disappears from the sidebar
 *   - the route it points to is wrapped in `<FeatureGuard feature="X">`
 *   - a generic table grid gates via the `TABLE_FEATURE` map (whole table)
 *   - a single `Field` in lib/tables.ts declares `feature: "X"` (one field
 *     within an otherwise-ungated table), or a page/component inline-checks
 *     `isFeatureEnabled("X")` to gate one section of an otherwise-ungated page
 * A deep-link / bookmark to a gated surface then shows the upgrade card (or,
 * for a field/section gate, a compact locked note) instead of empty/forbidden
 * data.
 *
 * This test mirrors the server check on the UI side. It enumerates every
 * FeatureKey and asserts each one is guarded by one of the four mechanisms
 * above, or is explicitly "absent" (no admin-portal surface exists for it at
 * all — mobile-only). It also asserts that every `feature`-annotated nav
 * entry actually points at guarded content — so a new gated nav entry whose
 * page forgets the wrap fails here.
 */

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { FEATURE_KEYS as FEATURE_KEY_REGISTRY } from "@workspace/feature-keys";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, "..");
const APP_FILE = path.join(SRC, "App.tsx");
const APPSHELL_FILE = path.join(SRC, "pages", "AppShell.tsx");
const TABLEPAGE_FILE = path.join(SRC, "pages", "TablePage.tsx");
const TABLES_FILE = path.join(SRC, "lib", "tables.ts");

// Single source of truth: the shared feature-key registry. The test pins to it
// directly (rather than regexing brand.ts, which only re-exports the type) so
// that adding a key in lib/feature-keys/src/index.ts flows here automatically.
const FEATURE_KEYS: string[] = [...FEATURE_KEY_REGISTRY];

/** route path → feature, for every `<Route path="X">{() => <FeatureGuard feature="Y">...`. */
function parseRouteGuards(): Record<string, string> {
  const src = readFileSync(APP_FILE, "utf8");
  const out: Record<string, string> = {};
  for (const m of src.matchAll(
    /<Route path="([^"]+)">\{\(\)\s*=>\s*<FeatureGuard feature="([^"]+)">/g,
  )) {
    out[m[1]] = m[2];
  }
  return out;
}

/** table name → feature, from the TABLE_FEATURE map in TablePage.tsx. */
function parseTableFeature(): Record<string, string> {
  const src = readFileSync(TABLEPAGE_FILE, "utf8");
  const block = src.match(/TABLE_FEATURE[^=]*=\s*\{([\s\S]*?)\};/);
  if (!block) throw new Error("Could not locate TABLE_FEATURE map in TablePage.tsx");
  const out: Record<string, string> = {};
  for (const m of block[1].matchAll(/(?:"([\w-]+)"|([\w-]+))\s*:\s*"([^"]+)"/g)) {
    out[m[1] ?? m[2]] = m[3];
  }
  return out;
}

/** Every nav entry that declares a feature: { href, feature }. */
function parseNavFeatures(): { href: string; feature: string }[] {
  const src = readFileSync(APPSHELL_FILE, "utf8");
  return [...src.matchAll(/href:\s*"([^"]+)"[^}]*?feature:\s*"([^"]+)"/g)].map((m) => ({
    href: m[1],
    feature: m[2],
  }));
}

/** Field-level gates: `feature: "<key>"` on a Field descriptor in lib/tables.ts.
 *  These hide a single field (grid column, edit-form field, Excel import)
 *  within an otherwise-ungated table — e.g. employees.availability. */
function parseFieldFeatures(): Set<string> {
  const src = readFileSync(TABLES_FILE, "utf8");
  return new Set([...src.matchAll(/feature:\s*"([^"]+)"/g)].map((m) => m[1]));
}

/** Inline `isFeatureEnabled("<key>")` checks gating a section of an otherwise
 *  ungated page (e.g. the Patrol checkpoints card on a site's detail page).
 *  Scans every page/component source file for a literal-string call. */
function parseInlineFeatureChecks(): Set<string> {
  const out = new Set<string>();
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!/\.tsx?$/.test(entry.name)) continue;
      const src = readFileSync(full, "utf8");
      for (const m of src.matchAll(/isFeatureEnabled\("([^"]+)"\)/g)) out.add(m[1]);
    }
  };
  walk(path.join(SRC, "pages"));
  walk(path.join(SRC, "components"));
  return out;
}

const ROUTE_GUARDS = parseRouteGuards();
const TABLE_FEATURE = parseTableFeature();
const NAV_FEATURES = parseNavFeatures();
const FIELD_FEATURES = parseFieldFeatures();
const INLINE_FEATURE_CHECKS = parseInlineFeatureChecks();

/** Features that intentionally have no admin-portal surface (mobile-only). */
const ADMIN_ABSENT = new Set<string>([]);

/** Resolve the feature a given nav href is guarded by, or null. */
function guardedFeatureForHref(href: string): string | null {
  if (ROUTE_GUARDS[href]) return ROUTE_GUARDS[href];
  if (href.startsWith("/tables/")) {
    const table = href.slice("/tables/".length).split("?")[0];
    return TABLE_FEATURE[table] ?? null;
  }
  return null;
}

describe("admin portal UI feature-gate coverage", () => {
  it("every FeatureKey is either guarded by an admin surface or marked absent", () => {
    const guarded = new Set<string>([
      ...Object.values(ROUTE_GUARDS),
      ...Object.values(TABLE_FEATURE),
      ...FIELD_FEATURES,
      ...INLINE_FEATURE_CHECKS,
    ]);
    for (const key of FEATURE_KEYS) {
      const isGuarded = guarded.has(key);
      const isAbsent = ADMIN_ABSENT.has(key);
      expect(
        isGuarded !== isAbsent,
        `Feature "${key}" must be EITHER guarded by a FeatureGuard route / TABLE_FEATURE ` +
          `entry, OR listed in ADMIN_ABSENT (mobile-only) — exactly one. ` +
          `(guarded=${isGuarded}, absent=${isAbsent})`,
      ).toBe(true);
    }
  });

  it("every feature-annotated nav entry points at guarded content", () => {
    expect(NAV_FEATURES.length).toBeGreaterThan(0);
    for (const { href, feature } of NAV_FEATURES) {
      const guardedBy = guardedFeatureForHref(href);
      expect(
        guardedBy,
        `Nav entry "${href}" is annotated feature="${feature}" but its route is not ` +
          `wrapped in <FeatureGuard feature="${feature}"> (App.tsx) and is not a ` +
          `TABLE_FEATURE-gated table. Wrap the page or add the table to TABLE_FEATURE.`,
      ).toBe(feature);
    }
  });

  it("every guard / TABLE_FEATURE / nav feature key is a known FeatureKey", () => {
    const known = new Set(FEATURE_KEYS);
    const used = [
      ...Object.values(ROUTE_GUARDS),
      ...Object.values(TABLE_FEATURE),
      ...NAV_FEATURES.map((n) => n.feature),
      ...FIELD_FEATURES,
      ...INLINE_FEATURE_CHECKS,
    ];
    for (const key of used) {
      expect(
        known.has(key),
        `Unknown feature "${key}" used in a route guard / table map / nav entry — ` +
          `typo, or the FeatureKey union is out of date.`,
      ).toBe(true);
    }
  });

  it("no feature is both guarded and marked absent", () => {
    const guarded = new Set<string>([
      ...Object.values(ROUTE_GUARDS),
      ...Object.values(TABLE_FEATURE),
      ...FIELD_FEATURES,
      ...INLINE_FEATURE_CHECKS,
    ]);
    for (const key of ADMIN_ABSENT) {
      expect(
        guarded.has(key),
        `Feature "${key}" is in ADMIN_ABSENT but is actually guarded by an admin surface — ` +
          `remove it from ADMIN_ABSENT.`,
      ).toBe(false);
    }
  });
});
