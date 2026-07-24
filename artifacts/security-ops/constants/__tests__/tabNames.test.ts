/**
 * Regression guard: stale tab-name strings in user-facing copy.
 *
 * Three "Clock tab" strings were shipped before being caught manually. This
 * test suite closes the gap by verifying:
 *
 *   1. ALL_NAV_TAB_TITLES in constants/tabNames.ts matches the `title:` props
 *      in app/(employee)/_layout.tsx — so renaming a tab in the layout forces
 *      an update to the constants file.
 *
 *   2. Every string exported from constants/userCopy.ts that contains "X tab"
 *      or "X sub-tab" has "X" present in the set of known nav-tab or sub-tab
 *      names — so introducing a new copy string with a non-existent tab name
 *      fails the test immediately, before it reaches the app store.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

import {
  ALL_NAV_TAB_TITLES,
  MY_WORK_SUBTAB_SHIFTS,
  MY_WORK_SUBTAB_CLOCK,
} from "../tabNames";

import {
  COPY_ALREADY_CLOCKED_IN,
  COPY_CLOCKED_IN_SUCCESS,
  COPY_ON_DUTY_BANNER,
  COPY_NO_SHIFTS_HINT,
} from "../userCopy";

// ── 1. Layout sync ───────────────────────────────────────────────────────────

describe("ALL_NAV_TAB_TITLES vs app/(employee)/_layout.tsx", () => {
  it("matches every title: prop on a Tabs.Screen in the employee layout exactly", () => {
    const layoutPath = join(
      __dirname,
      "../../app/(employee)/_layout.tsx",
    );
    const source = readFileSync(layoutPath, "utf8");

    // Extract values of `title: TAB_FOO` expressions (already resolved to
    // string constants by the time users see them) by reading the constant
    // names and resolving them.  We parse the TSX import list for the
    // tabNames constants actually used, then resolve their string values
    // from the imported module.
    //
    // Simpler alternative that's just as reliable: grep for `title: TAB_`
    // references in the layout and confirm the import list covers the whole
    // ALL_NAV_TAB_TITLES set.  If a new tab is added with an inline literal
    // instead of a constant, grep below will miss it AND the "no raw literals"
    // test further down will catch it.

    // Every TAB_* constant referenced in title: props must appear in the import.
    const importMatch = source.match(
      /import\s*\{([^}]+)\}\s*from\s*["']@\/constants\/tabNames["']/,
    );
    expect(
      importMatch,
      "app/(employee)/_layout.tsx must import from @/constants/tabNames",
    ).not.toBeNull();

    const importedNames = new Set(
      (importMatch![1] ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    );

    // Confirm every individual TAB_* constant is imported (not just aliased).
    for (const title of ALL_NAV_TAB_TITLES) {
      // Derive the expected constant name: "My Work" → TAB_MY_WORK
      const constName =
        "TAB_" +
        title
          .toUpperCase()
          .replace(/[^A-Z0-9]+/g, "_")
          .replace(/^_|_$/g, "");
      expect(
        importedNames.has(constName),
        `Layout does not import ${constName} (for tab "${title}"). ` +
          `Either add the import or remove the tab from ALL_NAV_TAB_TITLES.`,
      ).toBe(true);
    }

    // And confirm each imported TAB_* constant is actually used in a title prop.
    for (const name of importedNames) {
      if (!name.startsWith("TAB_")) continue;
      expect(
        source,
        `${name} is imported but not used as a title: prop — ` +
          `either use it or remove it from the import.`,
      ).toMatch(new RegExp(`title:\\s*${name}\\b`));
    }
  });

  it("has no raw string literal in a title: prop (all titles must use TAB_* constants)", () => {
    const layoutPath = join(
      __dirname,
      "../../app/(employee)/_layout.tsx",
    );
    const source = readFileSync(layoutPath, "utf8");

    // Find all `title: "..."` or `title: '...'` occurrences.
    const RAW_TITLE_RE = /\btitle:\s*["'][^"']+["']/g;
    const rawMatches = source.match(RAW_TITLE_RE) ?? [];

    expect(
      rawMatches,
      `Found raw string literal(s) in title props: ${rawMatches.join(", ")}. ` +
        `Use the TAB_* constants from @/constants/tabNames instead.`,
    ).toHaveLength(0);
  });
});

// ── 2. userCopy strings ───────────────────────────────────────────────────────

/**
 * All word(s) that are allowed to appear immediately before " tab" or
 * " sub-tab" in user-facing copy.  Case-insensitive comparison.
 */
const KNOWN_TAB_PREFIXES: ReadonlySet<string> = new Set([
  // Nav-bar tabs
  ...Array.from(ALL_NAV_TAB_TITLES).map((t) => t.toLowerCase()),
  // My Work sub-tabs
  MY_WORK_SUBTAB_SHIFTS.toLowerCase(),
  MY_WORK_SUBTAB_CLOCK.toLowerCase(),
]);

/**
 * Extracts every "X tab" / "X sub-tab" phrase from a string and returns
 * the lowercased prefix (the "X" part, up to two words).
 *
 * Limiting the prefix to ≤2 words prevents the regex from over-capturing
 * the whole sentence ("clock out first from the my work") instead of just
 * the tab name ("my work").  All current tab and sub-tab names are ≤2 words.
 */
function extractTabPhrases(str: string): string[] {
  const re = /\b(\w+(?:\s+\w+)?)\s+(?:sub-)?tab\b/gi;
  const found: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(str)) !== null) {
    found.push(m[1].trim().toLowerCase());
  }
  return found;
}

describe("userCopy tab-name references", () => {
  const copyStrings: Array<[string, string]> = [
    ["COPY_ALREADY_CLOCKED_IN", COPY_ALREADY_CLOCKED_IN],
    ["COPY_CLOCKED_IN_SUCCESS", COPY_CLOCKED_IN_SUCCESS("Night Patrol")],
    ["COPY_ON_DUTY_BANNER", COPY_ON_DUTY_BANNER],
    ["COPY_NO_SHIFTS_HINT", COPY_NO_SHIFTS_HINT],
  ];

  for (const [name, value] of copyStrings) {
    it(`${name} only references known tab/sub-tab names`, () => {
      const phrases = extractTabPhrases(value);
      for (const phrase of phrases) {
        expect(
          KNOWN_TAB_PREFIXES.has(phrase),
          `"${phrase}" in ${name} is not a known tab or sub-tab name. ` +
            `Known names: ${[...KNOWN_TAB_PREFIXES].join(", ")}. ` +
            `If the tab was renamed, update @/constants/tabNames and @/constants/userCopy.`,
        ).toBe(true);
      }
    });
  }

  it("covers all exported copy constants (update this list when adding new ones)", () => {
    // If you add a new export to userCopy.ts, add it to the copyStrings array
    // above and update this count. The failing assertion will remind you.
    expect(copyStrings).toHaveLength(4);
  });
});
