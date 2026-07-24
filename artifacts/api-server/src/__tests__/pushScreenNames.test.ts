/**
 * Push notification body strings — screen-name guard
 *
 * Every "X tab" / "X screen" phrase that appears in a push notification body
 * must name a screen that actually exists in the mobile app.  If a tab is
 * renamed, this test fails immediately, catching the stale copy string before
 * it ships to real devices.
 *
 * Canonical screen names come from @workspace/screen-names (lib/screen-names),
 * which is also the source imported by the mobile app's tabNames.ts.  A rename
 * in that shared lib causes a compile error in the mobile app AND a failing
 * assertion here — no manual synchronisation required.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { ALLOWED_PUSH_SCREEN_NAMES } from "@workspace/screen-names";

// ---------------------------------------------------------------------------
// Allowed names: imported directly from @workspace/screen-names so a tab
// rename in lib/screen-names/src/index.ts propagates to this check
// automatically — no manual synchronisation needed.
// ---------------------------------------------------------------------------
const ALLOWED_SCREEN_NAMES = ALLOWED_PUSH_SCREEN_NAMES;

// ---------------------------------------------------------------------------
// Files that produce push notification body text (they call sendPushToUsers
// or pushSafely).  Scan only these so we don't accidentally flag error-
// response strings in unrelated route files.
// ---------------------------------------------------------------------------
const PUSH_SOURCE_FILES = [
  "src/lib/geofence.ts",
  "src/lib/scheduledJobs.ts",
  "src/routes/applications.ts",
  "src/routes/chat.ts",
  "src/routes/incidents.ts",
  "src/routes/licenseRenewals.ts",
  "src/routes/liveOps.ts",
  "src/routes/schedulerWebhook.ts",
  "src/routes/shifts.ts",
  "src/routes/shiftSwaps.ts",
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Strip single-line comments so that developer notes like
 *   // show on the Comms tab (TODO: rename)
 * do not trigger false positives.
 */
function stripLineComments(src: string): string {
  return src.replace(/\/\/.*/g, "");
}

/**
 * Find every "X tab" / "X screen" phrase where X is one or two title-case
 * words.  Returns each match as { phrase, name } where `name` is the word(s)
 * before the suffix keyword.
 *
 * Examples:
 *   "See it in the Chat tab."   → { phrase: "Chat tab",    name: "Chat"    }
 *   "Open the My Work tab."     → { phrase: "My Work tab", name: "My Work" }
 *   "Comms tab"                 → { phrase: "Comms tab",   name: "Comms"   }
 *
 * Only matches title-case names so common lowercase phrases like
 * "any screen" or "this tab" are ignored.
 */
function extractScreenPhrases(src: string): Array<{ phrase: string; name: string }> {
  const RE = /\b([A-Z][A-Za-z]*(?:\s+[A-Z][A-Za-z]*)?)\s+(?:tab|screen)\b/g;
  const results: Array<{ phrase: string; name: string }> = [];
  let m: RegExpExecArray | null;
  while ((m = RE.exec(src)) !== null) {
    results.push({ phrase: m[0], name: m[1] });
  }
  return results;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("push notification body strings — screen-name guard", () => {
  it("every 'X tab' / 'X screen' phrase in push source files names a canonical screen", () => {
    const violations: string[] = [];

    for (const relPath of PUSH_SOURCE_FILES) {
      const absPath = resolve(process.cwd(), relPath);
      const cleaned = stripLineComments(readFileSync(absPath, "utf-8"));

      for (const { phrase, name } of extractScreenPhrases(cleaned)) {
        if (!ALLOWED_SCREEN_NAMES.has(name)) {
          violations.push(`${relPath}: "${phrase}" — "${name}" is not in ALLOWED_SCREEN_NAMES`);
        }
      }
    }

    expect(
      violations,
      [
        "",
        "One or more push-notification source files reference a screen name",
        "that is not in the canonical ALLOWED_SCREEN_NAMES list.",
        "Either add the new name to @workspace/screen-names (lib/screen-names/src/index.ts)",
        "if it is a real, current screen name, or fix the push body string to",
        "use the correct name.",
        "",
        "Canonical list: lib/screen-names/src/index.ts",
        "",
      ].join("\n"),
    ).toEqual([]);
  });

  it("detects a stale screen name and passes a valid one through", () => {
    const staleBody = `You have a new message. See it in the Comms tab.`;
    const validBody = `You have a new message. See it in the Chat tab.`;

    const staleHits = extractScreenPhrases(staleBody);
    const validHits = extractScreenPhrases(validBody);

    expect(staleHits).toHaveLength(1);
    expect(staleHits[0].name).toBe("Comms");
    expect(ALLOWED_SCREEN_NAMES.has("Comms")).toBe(false);

    expect(validHits).toHaveLength(1);
    expect(validHits[0].name).toBe("Chat");
    expect(ALLOWED_SCREEN_NAMES.has("Chat")).toBe(true);
  });

  it("does not flag lowercase phrases or comment-only references", () => {
    const lowercase = `Move closer to a site or try again on any screen.`;
    const commented = `// See Shifts tab for details`;

    expect(extractScreenPhrases(lowercase)).toHaveLength(0);
    expect(extractScreenPhrases(stripLineComments(commented))).toHaveLength(0);
  });
});
