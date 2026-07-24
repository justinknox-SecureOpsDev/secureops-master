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
 *   2. ALL_ADMIN_NAV_TAB_TITLES matches the `title:` props on visible (non-
 *      href-null) screens in app/(admin)/_layout.tsx — same guarantee for the
 *      admin shell.
 *
 *   3. Every string exported from constants/userCopy.ts that contains "X tab"
 *      or "X sub-tab" has "X" present in the set of known nav-tab or sub-tab
 *      names — so introducing a new copy string with a non-existent tab name
 *      fails the test immediately, before it reaches the app store.
 *
 *   4. Cross-package audit: admin-portal and API-server source files that
 *      reference mobile tab names in user-facing strings are read directly and
 *      every "X tab" phrase is validated against the same KNOWN_TAB_PREFIXES.
 *      These packages cannot import from security-ops, so they define local
 *      mirror constants — this section catches drift between those mirrors and
 *      the canonical tabNames.ts values.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

import {
  ALL_NAV_TAB_TITLES,
  ALL_ADMIN_NAV_TAB_TITLES,
  MY_WORK_SUBTAB_SHIFTS,
  MY_WORK_SUBTAB_CLOCK,
} from "../tabNames";

import {
  COPY_ALREADY_CLOCKED_IN,
  COPY_CLOCKED_IN_SUCCESS,
  COPY_ON_DUTY_BANNER,
  COPY_NO_SHIFTS_HINT,
  COPY_DISPATCH_BROADCAST_HINT,
  COPY_GEOFENCE_SMS_MAP_CHECK,
} from "../userCopy";

// ── 1. Employee layout sync ───────────────────────────────────────────────────

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

// ── 2. Admin layout sync ──────────────────────────────────────────────────────

describe("ALL_ADMIN_NAV_TAB_TITLES vs app/(admin)/_layout.tsx", () => {
  it("matches every title: prop on a visible Tabs.Screen in the admin layout exactly", () => {
    const layoutPath = join(
      __dirname,
      "../../app/(admin)/_layout.tsx",
    );
    const source = readFileSync(layoutPath, "utf8");

    const importMatch = source.match(
      /import\s*\{([^}]+)\}\s*from\s*["']@\/constants\/tabNames["']/,
    );
    expect(
      importMatch,
      "app/(admin)/_layout.tsx must import from @/constants/tabNames",
    ).not.toBeNull();

    const importedNames = new Set(
      (importMatch![1] ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    );

    // Every TAB_ADMIN_* constant for a visible admin tab must be imported.
    for (const title of ALL_ADMIN_NAV_TAB_TITLES) {
      // Derive constant name: "Live Map" → TAB_ADMIN_LIVE_MAP
      const constName =
        "TAB_ADMIN_" +
        title
          .toUpperCase()
          .replace(/[^A-Z0-9]+/g, "_")
          .replace(/^_|_$/g, "");
      expect(
        importedNames.has(constName),
        `Admin layout does not import ${constName} (for tab "${title}"). ` +
          `Either add the import or remove the tab from ALL_ADMIN_NAV_TAB_TITLES.`,
      ).toBe(true);
    }

    // Each imported TAB_ADMIN_* constant must be used in a title: prop.
    for (const name of importedNames) {
      if (!name.startsWith("TAB_ADMIN_")) continue;
      expect(
        source,
        `${name} is imported but not used as a title: prop — ` +
          `either use it or remove it from the import.`,
      ).toMatch(new RegExp(`title:\\s*${name}\\b`));
    }
  });

  it("has no raw string literal in a title: prop (all titles must use TAB_ADMIN_* constants)", () => {
    const layoutPath = join(
      __dirname,
      "../../app/(admin)/_layout.tsx",
    );
    const source = readFileSync(layoutPath, "utf8");

    const RAW_TITLE_RE = /\btitle:\s*["'][^"']+["']/g;
    const rawMatches = source.match(RAW_TITLE_RE) ?? [];

    expect(
      rawMatches,
      `Found raw string literal(s) in title props: ${rawMatches.join(", ")}. ` +
        `Use the TAB_ADMIN_* constants from @/constants/tabNames instead.`,
    ).toHaveLength(0);
  });
});

// ── 3. userCopy strings ───────────────────────────────────────────────────────

/**
 * All word(s) that are allowed to appear immediately before " tab" or
 * " sub-tab" in user-facing copy.  Case-insensitive comparison.
 * Covers both employee and admin shell tabs so cross-shell references
 * (e.g. admin notification bodies directing users to a specific tab) are
 * caught too.
 */
const KNOWN_TAB_PREFIXES: ReadonlySet<string> = new Set([
  // Employee nav-bar tabs
  ...Array.from(ALL_NAV_TAB_TITLES).map((t) => t.toLowerCase()),
  // Admin nav-bar tabs
  ...Array.from(ALL_ADMIN_NAV_TAB_TITLES).map((t) => t.toLowerCase()),
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

/**
 * Returns true if a phrase extracted by extractTabPhrases is a known tab
 * prefix.  Also tries stripping a leading article/preposition ("the", "a",
 * "an") so that "the Chat tab" → prefix "the chat" → also checks "chat".
 * This handles cases like "in the Chat tab" where the two-word capture
 * includes an article that is not part of the tab name itself.
 */
function isKnownTabPhrase(phrase: string): boolean {
  if (KNOWN_TAB_PREFIXES.has(phrase)) return true;
  const LEADING_ARTICLES = new Set(["the", "a", "an"]);
  const parts = phrase.split(/\s+/);
  if (parts.length > 1 && LEADING_ARTICLES.has(parts[0])) {
    const remainder = parts.slice(1).join(" ");
    if (KNOWN_TAB_PREFIXES.has(remainder)) return true;
  }
  return false;
}

describe("userCopy tab-name references", () => {
  const copyStrings: Array<[string, string]> = [
    ["COPY_ALREADY_CLOCKED_IN", COPY_ALREADY_CLOCKED_IN],
    ["COPY_CLOCKED_IN_SUCCESS", COPY_CLOCKED_IN_SUCCESS("Night Patrol")],
    ["COPY_ON_DUTY_BANNER", COPY_ON_DUTY_BANNER],
    ["COPY_NO_SHIFTS_HINT", COPY_NO_SHIFTS_HINT],
    ["COPY_DISPATCH_BROADCAST_HINT", COPY_DISPATCH_BROADCAST_HINT],
    ["COPY_GEOFENCE_SMS_MAP_CHECK", COPY_GEOFENCE_SMS_MAP_CHECK],
  ];

  for (const [name, value] of copyStrings) {
    it(`${name} only references known tab/sub-tab names`, () => {
      const phrases = extractTabPhrases(value);
      for (const phrase of phrases) {
        expect(
          isKnownTabPhrase(phrase),
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
    expect(copyStrings).toHaveLength(6);
  });
});

// ── 4. Cross-package audit ────────────────────────────────────────────────────
//
// admin-portal and API-server packages cannot import from security-ops, so
// they define LOCAL mirror constants for any mobile tab names they reference
// in user-facing strings. This section reads those source files directly and
// validates every "X tab" phrase against KNOWN_TAB_PREFIXES.
//
// If a tab is renamed, the cross-package mirror constant must be updated to
// match or this section fails — catching the drift before it ships.

// Workspace root is 4 directories above this test file's __dirname:
//   __dirname = artifacts/security-ops/constants/__tests__
//   → constants → security-ops → artifacts → (workspace root)
const WORKSPACE_ROOT = join(__dirname, "../../../../");

describe("cross-package tab-name audit", () => {
  it("admin-portal Dispatch.tsx local MOBILE_* constants match known employee tab names", () => {
    const dispatchPath = join(
      WORKSPACE_ROOT,
      "artifacts/admin-portal/src/pages/Dispatch.tsx",
    );
    const source = readFileSync(dispatchPath, "utf8");

    // Extract every `const MOBILE_* = "..."` declaration. These are the local
    // mirror constants that stand in for the security-ops TAB_* values in the
    // admin-portal (cross-package import not allowed). Their string values must
    // be present in ALL_NAV_TAB_TITLES (they reference employee-shell tabs that
    // officers will see on their mobile devices).
    const MOBILE_CONST_RE = /const\s+MOBILE_\w+\s*=\s*"([^"]+)"/g;
    let m: RegExpExecArray | null;
    const mobileConstants: string[] = [];
    while ((m = MOBILE_CONST_RE.exec(source)) !== null) {
      mobileConstants.push(m[1]);
    }

    expect(
      mobileConstants.length,
      "Dispatch.tsx should declare at least one MOBILE_* constant referencing an employee tab name",
    ).toBeGreaterThan(0);

    for (const value of mobileConstants) {
      expect(
        ALL_NAV_TAB_TITLES.has(value),
        `Dispatch.tsx MOBILE_* constant has value "${value}" which is not in ` +
          `ALL_NAV_TAB_TITLES. Update the local constant to match the current ` +
          `employee tab title or add the tab to ALL_NAV_TAB_TITLES.`,
      ).toBe(true);
    }
  });

  it("admin-portal Dispatch.tsx plain-string body values reference only known tab names", () => {
    const dispatchPath = join(
      WORKSPACE_ROOT,
      "artifacts/admin-portal/src/pages/Dispatch.tsx",
    );
    const source = readFileSync(dispatchPath, "utf8");

    // Strip single-line comments so we don't flag comment examples.
    const withoutLineComments = source.replace(/\/\/[^\n]*/g, "");

    // Check plain quoted body strings (not template literals, which use
    // runtime constants and are validated via the MOBILE_* constant check above).
    const BODY_RE = /\bbody:\s*(?:"([^"\\]*)"|'([^'\\]*)')/g;
    let m: RegExpExecArray | null;
    while ((m = BODY_RE.exec(withoutLineComments)) !== null) {
      const bodyText = m[1] ?? m[2] ?? "";
      const phrases = extractTabPhrases(bodyText);
      for (const phrase of phrases) {
        expect(
          isKnownTabPhrase(phrase),
          `Dispatch.tsx body string contains "${phrase} tab" which is not a known ` +
            `mobile tab name. Known names: ${[...KNOWN_TAB_PREFIXES].join(", ")}. ` +
            `Update the local MOBILE_* constant and its value to match tabNames.ts.`,
        ).toBe(true);
      }
    }
  });

  it("API-server push.ts admin tab constants match ALL_ADMIN_NAV_TAB_TITLES values", () => {
    const pushPath = join(
      WORKSPACE_ROOT,
      "artifacts/api-server/src/lib/push.ts",
    );
    const source = readFileSync(pushPath, "utf8");

    // Extract every `export const ADMIN_TAB_* = "..."` declaration.
    const CONST_RE = /export\s+const\s+ADMIN_TAB_\w+\s*=\s*"([^"]+)"/g;
    let m: RegExpExecArray | null;
    const adminTabValues: string[] = [];
    while ((m = CONST_RE.exec(source)) !== null) {
      adminTabValues.push(m[1]);
    }

    expect(
      adminTabValues.length,
      "push.ts should export at least one ADMIN_TAB_* constant",
    ).toBeGreaterThan(0);

    for (const value of adminTabValues) {
      expect(
        ALL_ADMIN_NAV_TAB_TITLES.has(value),
        `push.ts ADMIN_TAB_* constant has value "${value}" which is not in ` +
          `ALL_ADMIN_NAV_TAB_TITLES. Update the constant to match the admin ` +
          `layout title or add the tab to ALL_ADMIN_NAV_TAB_TITLES.`,
      ).toBe(true);
    }
  });

  it("API-server geofence.ts SMS body references no unknown tab names", () => {
    const geofencePath = join(
      WORKSPACE_ROOT,
      "artifacts/api-server/src/lib/geofence.ts",
    );
    const source = readFileSync(geofencePath, "utf8");

    // Strip single-line comments.
    const withoutLineComments = source.replace(/\/\/[^\n]*/g, "");

    // Look for template-literal strings passed as SMS body arguments.
    const TEMPLATE_RE = /`([^`]*)`/g;
    let m: RegExpExecArray | null;
    while ((m = TEMPLATE_RE.exec(withoutLineComments)) !== null) {
      const phrases = extractTabPhrases(m[1]);
      for (const phrase of phrases) {
        expect(
          KNOWN_TAB_PREFIXES.has(phrase),
          `geofence.ts template string contains "${phrase} tab" which is not a ` +
            `known mobile tab name. Update SMS_GEOFENCE_MAP_PROMPT in push.ts ` +
            `and ADMIN_TAB_LIVE_MAP to match the current admin layout title.`,
        ).toBe(true);
      }
    }
  });

  it("all api-server source files contain no unknown tab-name phrases in push/SMS body strings", () => {
    // Recursively collect all .ts source files in api-server/src, skipping
    // test directories and files that already have dedicated tests above.
    const srcDir = join(WORKSPACE_ROOT, "artifacts/api-server/src");
    const DEDICATED_TESTS = new Set([
      join(srcDir, "lib/push.ts"),
      join(srcDir, "lib/geofence.ts"),
    ]);

    function collectTsFiles(dir: string): string[] {
      const entries = readdirSync(dir, { withFileTypes: true });
      const result: string[] = [];
      for (const entry of entries) {
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
          // Skip test directories entirely — test bodies have
          // intentional inline strings that are not production copy.
          if (entry.name === "__tests__") continue;
          result.push(...collectTsFiles(fullPath));
        } else if (
          entry.isFile() &&
          entry.name.endsWith(".ts") &&
          !entry.name.endsWith(".test.ts") &&
          !DEDICATED_TESTS.has(fullPath)
        ) {
          result.push(fullPath);
        }
      }
      return result;
    }

    const tsFiles = collectTsFiles(srcDir);
    expect(
      tsFiles.length,
      "Expected to find at least one api-server source file to audit",
    ).toBeGreaterThan(0);

    for (const filePath of tsFiles) {
      const source = readFileSync(filePath, "utf8");

      // Strip single-line and block comments so we don't flag comment
      // examples or TODO strings that mention tab names inline.
      const withoutComments = source
        .replace(/\/\/[^\n]*/g, "")
        .replace(/\/\*[\s\S]*?\*\//g, "");

      // ── Push notification body: strings ────────────────────────────────
      // Match `body: "..."`, `body: '...'`, or `body: \`...\`` patterns.
      // This is the canonical push-notification body field; any inline tab
      // name here (e.g. "Check the Approvals tab") must come from a
      // ADMIN_TAB_* or employee TAB_* constant so the tabNames test catches
      // future renames.
      //
      // Template literals may contain ${} interpolations — strip them before
      // phrase-matching so variable names don't pollute the text (e.g.
      // "from ${site.name}." should not accidentally form a tab phrase).
      //
      // Deliberately NOT scanning all quoted strings or all template literals
      // in a file — that would falsely flag `message:` API response strings
      // (e.g. timeEntries.ts: "…in the Shifts tab") and comment examples
      // that use tab names for documentation purposes.
      const BODY_RE =
        /\bbody:\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|`((?:[^`\\]|\\.)*)`)/g;
      let m: RegExpExecArray | null;
      const relPath = filePath.replace(WORKSPACE_ROOT, "");
      while ((m = BODY_RE.exec(withoutComments)) !== null) {
        const rawBody = m[1] ?? m[2] ?? m[3] ?? "";
        // Replace ${...} interpolations with a space so consecutive words
        // around a substitution don't accidentally merge into a tab phrase.
        const plainBody = rawBody.replace(/\$\{[^}]*\}/g, " ");
        const phrases = extractTabPhrases(plainBody);
        for (const phrase of phrases) {
          expect(
            isKnownTabPhrase(phrase),
            `${relPath}: push body "${plainBody.trim()}" contains ` +
              `"${phrase} tab" which is not a known tab or sub-tab name. ` +
              `Known names: ${[...KNOWN_TAB_PREFIXES].join(", ")}. ` +
              `Use an ADMIN_TAB_* or employee TAB_* constant from push.ts / tabNames.ts.`,
          ).toBe(true);
        }
      }
    }
  });
});
