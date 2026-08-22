/**
 * Static "no quiet fallback to defaults" coverage for admin *platform
 * settings* pages — surfaces that load ONE stored configuration object and
 * let an admin edit + save it, as opposed to CRUD pages that manage an
 * open-ended list of independent records (Policies, Radio channels, the
 * Application Builder's custom questions, ...).
 *
 * Legal & Agreements, Branding, Customer account, Feature flags, and
 * Permissions were each fixed one at a time for the same defect class (see
 * `.agents/memory/unknown-vs-empty-ui-state.md`):
 *   1. A failed read must never be drawn as "nothing is stored" — that looks
 *      identical to an empty/unconfigured setting and made a stored value
 *      (or a document that WAS uploaded) look like it silently vanished.
 *   2. The write response is authoritative: a mutation must apply it to
 *      local/query state *before* the confirming re-read, so a re-read that
 *      fails right after a good save can't make the save look like it never
 *      happened.
 * The shared helpers for this now live in `@/lib/settingsStatus` and
 * `@/components/SettingsStatus`, but using them is a convention, not
 * something the compiler enforces. This test is the enforcement:
 *
 *  - `discoverSettingsSurfaces` scans every top-level page component for the
 *    telltale shape of a platform-settings surface: a GET to a fixed (no
 *    `${}`) path under `/admin/platform/` or `/admin/permissions` that is
 *    later written back to with PUT/PATCH. Those two prefixes are what
 *    distinguish a global, singleton configuration resource from a
 *    per-record CRUD collection in this codebase's routing conventions.
 *  - Every surface it finds MUST have a matching entry in `SETTINGS_SURFACES`
 *    below (and vice versa) — so a brand-new settings page under those
 *    prefixes can't ship un-registered, and a renamed/removed one can't leave
 *    a stale, silently-vacuous registry entry behind.
 *  - Every registered entry is checked for both rules above via small,
 *    file-specific probes (mirroring the tailored parsers in
 *    `featureGuards.test.ts`) so a regression in an already-fixed page is
 *    caught too, not just a brand-new one.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, "..");
const PAGES_DIR = path.join(SRC, "pages");

const HELP = "See @/lib/settingsStatus and @/components/SettingsStatus.";

// ---------------------------------------------------------------------------
// Discovery: find every GET-then-PUT/PATCH "singleton config" shape.
// ---------------------------------------------------------------------------

type ApiCall = { method: string; isTemplate: boolean; staticPrefix: string; full: string };

/** Small scanner for `api(...)`/`api<T>(...)` call sites: walks the balanced
 * argument list of each call (respecting nested parens/braces and string
 * literals, so a later, unrelated call's `method:` can never bleed into this
 * one) and pulls out the literal path (cut at the first `${` for template
 * literals) plus the HTTP method from that same call's option object, if any
 * (default GET). */
function scanApiCalls(src: string): ApiCall[] {
  const calls: ApiCall[] = [];
  const callRe = /\bapi(?:<[^>()]*>)?\(/g;
  let m: RegExpExecArray | null;
  while ((m = callRe.exec(src))) {
    const start = callRe.lastIndex;
    let depth = 1;
    let i = start;
    let inStr: string | null = null;
    while (i < src.length && depth > 0) {
      const c = src[i];
      if (inStr) {
        if (c === "\\") { i += 2; continue; }
        if (c === inStr) inStr = null;
      } else if (c === '"' || c === "'" || c === "`") {
        inStr = c;
      } else if (c === "(") {
        depth++;
      } else if (c === ")") {
        depth--;
      }
      i++;
    }
    const argsSrc = src.slice(start, i - 1);
    const pathMatch = argsSrc.match(/^\s*(`[^`]*`|"[^"]*")/);
    if (!pathMatch) continue;
    const methodMatch = argsSrc.match(/method:\s*"([A-Z]+)"/);
    const method = methodMatch ? methodMatch[1] : "GET";
    const raw = pathMatch[1].slice(1, -1);
    const dollarIdx = raw.indexOf("${");
    const isTemplate = dollarIdx !== -1;
    const staticPrefix = isTemplate ? raw.slice(0, dollarIdx) : raw;
    calls.push({ method, isTemplate, staticPrefix, full: raw });
  }
  return calls;
}

/**
 * Prefixes that denote a global, singleton "platform settings" resource in
 * this app's routing convention, as opposed to a per-record CRUD collection
 * (`/admin/policies`, `/admin/radio/channels`, `/admin/company-owners`, ...).
 * A new settings page almost always lands under one of these, so any GET
 * here that's later written back to is in scope for this check.
 */
const SETTINGS_PREFIXES = ["/admin/platform/", "/admin/permissions"];

type DiscoveredSurface = { file: string; getPath: string };

function discoverSettingsSurfaces(): DiscoveredSurface[] {
  const files = readdirSync(PAGES_DIR).filter(
    (f) => f.endsWith(".tsx") && statSync(path.join(PAGES_DIR, f)).isFile(),
  );
  const found: DiscoveredSurface[] = [];
  for (const file of files) {
    const src = readFileSync(path.join(PAGES_DIR, file), "utf8");
    const calls = scanApiCalls(src);
    const gets = calls.filter(
      (c) =>
        c.method === "GET" &&
        !c.isTemplate &&
        SETTINGS_PREFIXES.some((p) => c.full === p.replace(/\/$/, "") || c.full.startsWith(p)),
    );
    const writes = calls.filter((c) => c.method === "PUT" || c.method === "PATCH");
    for (const g of gets) {
      if (writes.some((w) => w.staticPrefix.startsWith(g.full))) {
        found.push({ file, getPath: g.full });
      }
    }
  }
  return found;
}

// ---------------------------------------------------------------------------
// Registry: every known settings surface, plus its two invariant probes.
// ---------------------------------------------------------------------------

/** Returns the substring of `src` from the first occurrence of `start` up to
 * (excluding) the first occurrence of `end` that follows it. Throws if either
 * anchor is missing, so a probe fails loudly instead of silently matching
 * against the whole file (or nothing). */
function sliceBetween(src: string, file: string, start: string, end: string): string {
  const a = src.indexOf(start);
  if (a === -1) throw new Error(`${file}: expected to find anchor ${JSON.stringify(start)}`);
  const b = src.indexOf(end, a + start.length);
  if (b === -1) throw new Error(`${file}: expected to find anchor ${JSON.stringify(end)} after ${JSON.stringify(start)}`);
  return src.slice(a, b);
}

/** Whether `before` occurs earlier in `block` than `after` (both required). */
function occursBefore(block: string, before: RegExp, after: RegExp): boolean {
  const a = block.search(before);
  const b = block.search(after);
  return a !== -1 && b !== -1 && a < b;
}

type SettingsSurface = {
  file: string;
  getPath: string;
  label: string;
  /** Renders an explicit "couldn't load" branch instead of drawing the
   * built-in blank/default form when the read fails. */
  hasLoadFailureBranch: (src: string) => boolean;
  /** A successful save applies the server's reply to local/query state
   * before the confirming re-read runs. */
  appliesWriteReplyBeforeRefetch: (src: string) => boolean;
};

const SETTINGS_SURFACES: SettingsSurface[] = [
  {
    file: "PlatformFeatures.tsx",
    getPath: "/admin/platform/brand",
    label: "branding",
    hasLoadFailureBranch: (src) => /brandQ\.isError\s*&&/.test(src),
    appliesWriteReplyBeforeRefetch: (src) => {
      const block = sliceBetween(src, "PlatformFeatures.tsx", "const saveBrand = useMutation(", "const brandDirty = ");
      return occursBefore(
        block,
        /qc\.setQueryData\(\["platform",\s*"brand"\],\s*reply\)/,
        /brandQ\.refetch\(\)/,
      );
    },
  },
  {
    file: "PlatformFeatures.tsx",
    getPath: "/admin/platform/customer-config",
    label: "customer account",
    hasLoadFailureBranch: (src) => /configQ\.isError\s*&&/.test(src),
    appliesWriteReplyBeforeRefetch: (src) => {
      const block = sliceBetween(src, "PlatformFeatures.tsx", "const saveConfig = useMutation(", "const configDirty = ");
      return occursBefore(
        block,
        /qc\.setQueryData\(\["platform",\s*"customer-config"\],\s*reply\)/,
        /configQ\.refetch\(\)/,
      );
    },
  },
  {
    file: "PlatformFeatures.tsx",
    getPath: "/admin/platform/features",
    label: "feature flag",
    hasLoadFailureBranch: (src) => /flagsQ\.isError\s*&&/.test(src),
    appliesWriteReplyBeforeRefetch: (src) => {
      const block = sliceBetween(src, "PlatformFeatures.tsx", "const save = useMutation(", "if (meQ.isLoading)");
      return occursBefore(
        block,
        /qc\.setQueryData\(\["platform",\s*"features"\],\s*reply\)/,
        /flagsQ\.refetch\(\)/,
      );
    },
  },
  {
    file: "Permissions.tsx",
    getPath: "/admin/permissions",
    label: "permission",
    hasLoadFailureBranch: (src) => /permsQ\.isError\s*&&/.test(src),
    appliesWriteReplyBeforeRefetch: (src) => {
      const block = sliceBetween(src, "Permissions.tsx", "async function applyRoles(", "if (permsQ.isLoading)");
      return occursBefore(
        block,
        /qc\.setQueryData<PermsResponse>\(PERMS_KEY,/,
        /permsQ\.refetch\(\)/,
      );
    },
  },
  {
    file: "LegalAgreements.tsx",
    getPath: "/admin/platform/agreements",
    label: "legal agreement",
    hasLoadFailureBranch: (src) => /statusFailed\s*&&/.test(src),
    appliesWriteReplyBeforeRefetch: (src) => {
      const block = sliceBetween(src, "LegalAgreements.tsx", "async function uploadCustom(", "async function revertToTemplate(");
      return occursBefore(
        block,
        /setStatuses\(\(prev\) => \(\{ \.\.\.\(prev \?\? EMPTY_SLOT_MAP\), \[slot\]: saved\?\.custom/,
        /await loadStatus\(\)/,
      );
    },
  },
];

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

const DISCOVERED = discoverSettingsSurfaces();

function key(s: { file: string; getPath: string }): string {
  return `${s.file}::${s.getPath}`;
}

describe("admin portal settings-surface coverage", () => {
  it("finds at least the known settings surfaces (discovery sanity check)", () => {
    // If this drops to 0, the discovery regex itself broke (e.g. the `api()`
    // call shape changed) — every other assertion below would then vacuously
    // pass, so fail loudly here instead.
    expect(DISCOVERED.length).toBeGreaterThanOrEqual(SETTINGS_SURFACES.length);
  });

  it("every discovered settings-shaped page is registered in SETTINGS_SURFACES", () => {
    const registered = new Set(SETTINGS_SURFACES.map(key));
    for (const d of DISCOVERED) {
      expect(
        registered.has(key(d)),
        `${d.file} has a new settings surface at GET ${d.getPath} (loads a stored config under ` +
          `/admin/platform/* or /admin/permissions and writes it back with PUT/PATCH) that isn't ` +
          `registered in settingsSurfaceGuards.test.ts. Add it to SETTINGS_SURFACES with a check that ` +
          `it (a) renders an explicit load-failure notice instead of the blank/default form, and ` +
          `(b) applies the write's reply before the confirming re-read. ${HELP}`,
      ).toBe(true);
    }
  });

  it("every registered settings surface is still discoverable (no stale entries)", () => {
    const discovered = new Set(DISCOVERED.map(key));
    for (const s of SETTINGS_SURFACES) {
      expect(
        discovered.has(key(s)),
        `SETTINGS_SURFACES has an entry for ${s.file} GET ${s.getPath} that no longer matches any ` +
          `GET+PUT/PATCH pair in the source — the endpoint was renamed or removed. Update or remove ` +
          `this registry entry.`,
      ).toBe(true);
    }
  });

  for (const surface of SETTINGS_SURFACES) {
    describe(`${surface.file} — ${surface.label} (${surface.getPath})`, () => {
      const src = readFileSync(path.join(PAGES_DIR, surface.file), "utf8");

      it("renders an explicit load-failure branch instead of the blank/default form", () => {
        expect(
          surface.hasLoadFailureBranch(src),
          `${surface.file} (${surface.label}) doesn't appear to render an explicit "couldn't load" ` +
            `branch. A failed read must never fall through to the editable form with blank/default ` +
            `values — that's indistinguishable from "nothing is configured". ${HELP}`,
        ).toBe(true);
      });

      it("applies the write's reply before the confirming re-read", () => {
        expect(
          surface.appliesWriteReplyBeforeRefetch(src),
          `${surface.file} (${surface.label}) doesn't apply the server's write reply to local/query ` +
            `state before its confirming re-read. If that re-read fails right after a good save, the ` +
            `save can look like it silently didn't happen. ${HELP}`,
        ).toBe(true);
      });
    });
  }
});
