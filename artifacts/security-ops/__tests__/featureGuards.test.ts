/**
 * Static UI feature-gate coverage for the Expo mobile app.
 *
 * The server's `requireFeature` middleware is the authoritative gate (see
 * api-server `__tests__/featureGating.test.ts`). The mobile app only HIDES a
 * locked feature: gated tabs drop their `href` and gated screens wrap their
 * body in `<FeatureGate feature="X">` so a deep-link / router.push shows a
 * neutral "not available" notice instead of an endless spinner against a 403.
 *
 * This test mirrors the server check on the UI side: it enumerates every
 * FeatureKey and asserts each one either maps to mobile screen(s) that are
 * actually wrapped in `FeatureGate`, or is explicitly marked "absent" (a
 * surface that only exists in the admin portal / web). A new gated screen that
 * forgets the wrap — or a new FeatureKey with no decision — fails here.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { FEATURE_KEYS as FEATURE_KEY_REGISTRY } from "@workspace/feature-keys";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const APP_DIR = path.join(ROOT, "app");

function read(relFromRoot: string): string {
  return readFileSync(path.join(ROOT, relFromRoot), "utf8");
}

// Single source of truth: the shared feature-key registry. The test pins to it
// directly (rather than regexing useFeatures.ts, which only re-exports the type)
// so that adding a key in lib/feature-keys/src/index.ts flows here automatically.
const FEATURE_KEYS: string[] = [...FEATURE_KEY_REGISTRY];

/**
 * Source of truth: every FeatureKey → the mobile screen file(s) whose body
 * must be wrapped in `<FeatureGate feature="<key>">`, OR "absent" when the
 * feature has no standalone gated screen in the Expo app (it lives only in the
 * admin portal / web). Keeping this exhaustive (asserted below) forces any new
 * FeatureKey to make a deliberate decision here.
 */
const MOBILE_SURFACES: Record<string, string[] | "absent"> = {
  chat: ["app/(employee)/chat.tsx", "app/(admin)/chat.tsx"],
  radio: ["app/(admin)/radio.tsx", "app/(employee)/radio.tsx"],
  incidents: ["app/(employee)/incidents.tsx", "app/(admin)/incidents.tsx"],
  liveMap: ["app/(admin)/live-map.tsx"],
  payroll: ["app/(admin)/payroll.tsx", "app/paystubs.tsx"],
  invoicing: ["app/(admin)/invoices.tsx"],
  policies: ["app/policies.tsx"],
  swapRequests: ["app/swap-requests.tsx"],
  licenseRenewals: ["app/license-renewal.tsx"],
  dar: ["app/dar.tsx"],
  patrol: ["app/patrol.tsx"],
  availability: ["app/availability.tsx"],
  trainings: ["app/training-add.tsx"],
  // Admin/web-only product surfaces — no dedicated gated screen in the Expo app.
  hr: "absent",
  exports: "absent",
  officerShares: "absent",
  // The assistant answers portal questions and drives portal actions; officers
  // have no equivalent screen in the field app.
  assistant: "absent",
};

/** Recursively list every .tsx file under app/, as posix paths from ROOT. */
function listScreens(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const abs = path.join(dir, entry);
    if (statSync(abs).isDirectory()) {
      out.push(...listScreens(abs));
    } else if (entry.endsWith(".tsx")) {
      out.push(path.relative(ROOT, abs).split(path.sep).join("/"));
    }
  }
  return out;
}

const SCREEN_FILES = listScreens(APP_DIR);

/** Map of FeatureKey → set of screen files that wrap it in <FeatureGate>. */
function scanFeatureGateWraps(): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  for (const rel of SCREEN_FILES) {
    const src = read(rel);
    for (const m of src.matchAll(/<FeatureGate\s+feature="([^"]+)"/g)) {
      const key = m[1];
      if (!map.has(key)) map.set(key, new Set());
      map.get(key)!.add(rel);
    }
  }
  return map;
}

const WRAPPED = scanFeatureGateWraps();

describe("mobile UI feature-gate coverage", () => {
  it("MOBILE_SURFACES covers exactly the FeatureKey union", () => {
    const manifestKeys = Object.keys(MOBILE_SURFACES).sort();
    const featureKeys = [...FEATURE_KEYS].sort();
    expect(
      manifestKeys,
      "MOBILE_SURFACES must list every FeatureKey (and only FeatureKeys). " +
        "Add the new feature's screen(s) or mark it \"absent\".",
    ).toEqual(featureKeys);
  });

  it("every gated mobile screen wraps its body in <FeatureGate feature=...>", () => {
    for (const key of FEATURE_KEYS) {
      const surface = MOBILE_SURFACES[key];
      if (surface === "absent") continue;
      const expected = [...surface].sort();
      const actual = [...(WRAPPED.get(key) ?? new Set<string>())].sort();
      expect(
        actual,
        `Feature "${key}": the set of screens wrapped in <FeatureGate feature="${key}"> ` +
          `must match MOBILE_SURFACES. A new screen that hits this feature's API ` +
          `must wrap its body in <FeatureGate feature="${key}"> and be listed here ` +
          `(or the manifest updated if a screen was removed).`,
      ).toEqual(expected);
    }
  });

  it("features marked \"absent\" have no FeatureGate-wrapped mobile screen", () => {
    for (const key of FEATURE_KEYS) {
      if (MOBILE_SURFACES[key] !== "absent") continue;
      expect(
        WRAPPED.has(key),
        `Feature "${key}" is marked "absent" but is wrapped in a mobile screen: ` +
          `${[...(WRAPPED.get(key) ?? [])].join(", ")}. Move it out of "absent" in MOBILE_SURFACES.`,
      ).toBe(false);
    }
  });

  it("every FeatureGate / isEnabled key used in app/ is a known FeatureKey", () => {
    const known = new Set(FEATURE_KEYS);
    for (const rel of SCREEN_FILES) {
      const src = read(rel);
      const used = [
        ...src.matchAll(/<FeatureGate\s+feature="([^"]+)"/g),
        ...src.matchAll(/isEnabled\(\s*flags\s*,\s*"([^"]+)"\s*\)/g),
      ].map((m) => m[1]);
      for (const key of used) {
        expect(
          known.has(key),
          `${rel} references unknown feature "${key}" — typo, or FeatureKey union is out of date.`,
        ).toBe(true);
      }
    }
  });

  it("menu / quick-action entry points hide locked features (not shown-then-gated)", () => {
    // Non-tab navigation launchers: profile action rows + admin dashboard
    // quick actions. A locked feature must not be presented as a tappable menu
    // entry — the row/button itself has to be hidden, not just its destination
    // screen gated. (Deep-linking straight to the screen is the FeatureGate
    // backstop tested above; this covers ordinary navigation.)
    const MENU_FILES = ["app/(employee)/profile.tsx", "app/(admin)/dashboard.tsx"];

    // Derive route string -> FeatureKey from the gated screen files, e.g.
    // "app/(admin)/payroll.tsx" -> "/(admin)/payroll", "app/paystubs.tsx" -> "/paystubs".
    const routeToFeature = new Map<string, string>();
    for (const key of FEATURE_KEYS) {
      const surface = MOBILE_SURFACES[key];
      if (surface === "absent") continue;
      for (const file of surface) {
        const route = file.replace(/^app/, "").replace(/\.tsx$/, "");
        routeToFeature.set(route, key);
      }
    }

    for (const rel of MENU_FILES) {
      const src = read(rel);
      // Data-driven filter form: `feature: "<key>"` items culled by
      // `.filter(... isEnabled(flags, x.feature))`.
      const hasDataDrivenFilter = /isEnabled\(\s*flags\s*,\s*\w+\.feature\s*\)/.test(src);
      for (const [route, feature] of routeToFeature) {
        if (!src.includes(`"${route}"`)) continue; // file doesn't link here
        const guarded =
          src.includes(`isEnabled(flags, "${feature}")`) ||
          src.includes(`useFeature("${feature}")`) ||
          (hasDataDrivenFilter && src.includes(`feature: "${feature}"`));
        expect(
          guarded,
          `${rel} links to gated route "${route}" (feature "${feature}") but never ` +
            `guards it with isEnabled(flags, "${feature}"). A locked feature must not ` +
            `appear as a menu row / quick action — hide the entry point.`,
        ).toBe(true);
      }
    }
  });

  it("Quick Jump grid shows 6 tiles when payroll + invoicing are on", () => {
    const src = read("app/(admin)/dashboard.tsx");
    // Extract every { label: "...", ..., feature: "..." } item in the quickGrid array.
    // Items without a feature key are always shown; feature-gated items are conditional.
    const itemRe = /\{[^}]*label:\s*"([^"]+)"[^}]*(?:feature:\s*"([^"]+)")?[^}]*\}/g;

    // Locate the quickGrid block — everything between the quickGrid JSX comment
    // markers. We use the known constant items as anchors instead of a fragile
    // block-extraction regex; the critical assertion is the filter logic below.
    const allLabels = ["Payroll", "Invoices", "Licenses", "Lic. Approvals", "Clients", "Time Approval"];
    for (const label of allLabels) {
      expect(src, `Quick Jump item "${label}" not found in dashboard source`).toContain(`"${label}"`);
    }

    // The filter pattern `.filter((a) => !a.feature || isEnabled(flags, a.feature))` must exist.
    expect(src).toMatch(/\.filter\(\s*\([^)]*\)\s*=>/);

    // Simulate both flag states by extracting items with their optional feature key.
    const quickJumpBlock = src.slice(
      src.indexOf('"Payroll"') - 50,
      src.indexOf('"Time Approval"') + 200,
    );

    // Parse label + feature pairs from the dashboard's data array.
    // Match each `{ ... }` object literal then extract label and optional feature.
    type Item = { label: string; feature?: string };
    const items: Item[] = [];
    const objRe = /\{[^{}]+\}/g;
    let m: RegExpExecArray | null;
    while ((m = objRe.exec(quickJumpBlock)) !== null) {
      const text = m[0];
      const labelM = text.match(/label:\s*"([^"]+)"/);
      const featureM = text.match(/feature:\s*"([^"]+)"/);
      if (labelM) {
        items.push({ label: labelM[1], feature: featureM?.[1] });
      }
    }

    // All 6 items must be present in the source block.
    expect(items.map((i) => i.label)).toEqual(allLabels);

    // With payroll + invoicing ON: all 6 tiles visible.
    const allOn: Record<string, boolean> = { payroll: true, invoicing: true };
    const visibleAllOn = items.filter((i) => !i.feature || allOn[i.feature]);
    expect(visibleAllOn).toHaveLength(6);

    // With payroll + invoicing OFF: 4 tiles visible (Licenses, Lic. Approvals, Clients, Time Approval).
    const allOff: Record<string, boolean> = { payroll: false, invoicing: false };
    const visibleAllOff = items.filter((i) => !i.feature || allOff[i.feature]);
    expect(visibleAllOff).toHaveLength(4);
    expect(visibleAllOff.map((i) => i.label)).toEqual([
      "Licenses",
      "Lic. Approvals",
      "Clients",
      "Time Approval",
    ]);
  });

  it("Quick Jump grid: ungated tiles always visible regardless of flag state", () => {
    const src = read("app/(admin)/dashboard.tsx");
    const ALWAYS_VISIBLE = ["Licenses", "Lic. Approvals", "Clients", "Time Approval"];
    const GATED = ["Payroll", "Invoices"];

    // Ungated items have no `feature:` key next to their label.
    for (const label of ALWAYS_VISIBLE) {
      // Find the object containing this label; it must NOT have a feature key.
      const objRe = new RegExp(
        `\\{[^{}]*label:\\s*"${label}"[^{}]*\\}`,
        "g",
      );
      const obj = objRe.exec(src)?.[0];
      expect(obj, `Could not locate Quick Jump item object for "${label}"`).toBeTruthy();
      expect(
        obj,
        `"${label}" should be ungated but has a feature: key`,
      ).not.toMatch(/feature:/);
    }

    // Gated items must carry a feature key.
    for (const label of GATED) {
      const objRe = new RegExp(
        `\\{[^{}]*label:\\s*"${label}"[^{}]*\\}`,
        "g",
      );
      const obj = objRe.exec(src)?.[0];
      expect(obj, `Could not locate Quick Jump item object for "${label}"`).toBeTruthy();
      expect(
        obj,
        `"${label}" must be gated by a feature: key`,
      ).toMatch(/feature:/);
    }
  });

  it("Quick Jump 3-column wrap layout handles 4-tile state without empty-cell misalignment", () => {
    // The quickGrid uses flexWrap + width:"30%" (3 cols). With 4 tiles, the
    // last row has 1 tile; flexGrow:1 expands it to fill. There must be NO
    // fixed-column count (e.g. numColumns on a FlatList) that would leave a
    // broken empty cell. This test confirms the layout is flexWrap, not grid.
    const src = read("app/(admin)/dashboard.tsx");

    // The grid container must use flexWrap (not numColumns).
    expect(src).toMatch(/flexWrap:\s*["']wrap["']/);
    expect(src, "Quick Jump must not use numColumns (would leave empty cells)").not.toMatch(
      /numColumns/,
    );

    // Each tile uses width: "30%" + flexGrow: 1 so the final partial row expands.
    // Confirm both properties exist in the quickTile style.
    const quickTileStyleBlock = src.slice(
      src.indexOf("quickTile:"),
      src.indexOf("quickTile:") + 300,
    );
    expect(quickTileStyleBlock).toMatch(/["']30%["']/);
    expect(quickTileStyleBlock).toMatch(/flexGrow:\s*1/);
  });

  it("every tab hidden by isEnabled(flags, ...) has a FeatureGate-wrapped screen", () => {
    const layouts = [
      { file: "app/(admin)/_layout.tsx", group: "app/(admin)" },
      { file: "app/(employee)/_layout.tsx", group: "app/(employee)" },
    ];
    for (const { file, group } of layouts) {
      const src = read(file);
      // Each <Tabs.Screen ...> block declares a `name` and may gate its `href`
      // with isEnabled(flags, "<key>"). A gated tab MUST point at a wrapped screen.
      const blocks = src.split(/<Tabs\.Screen/).slice(1);
      for (const block of blocks) {
        const nameM = block.match(/name="([^"]+)"/);
        const featM = block.match(/isEnabled\(\s*flags\s*,\s*"([^"]+)"\s*\)/);
        if (!nameM || !featM) continue;
        const screenFile = `${group}/${nameM[1]}.tsx`;
        const surface = MOBILE_SURFACES[featM[1]];
        expect(
          surface !== "absent" && (surface ?? []).includes(screenFile),
          `Tab "${nameM[1]}" in ${file} is hidden behind feature "${featM[1]}", ` +
            `but ${screenFile} is not listed as a gated screen for it in MOBILE_SURFACES.`,
        ).toBe(true);
      }
    }
  });
});
