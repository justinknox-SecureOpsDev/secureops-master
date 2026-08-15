/**
 * Static analysis test: the Clock screen's "Confirm your last shift" card must
 * only ever surface the SIGNED-IN user's own time entry.
 *
 * WHY THIS EXISTS
 * `GET /api/time-entries` is role-scoped, not self-scoped. For an `admin` it
 * returns EVERY employee's entries when no `employeeId` query param is given
 * (and for a `site_manager`, every entry at their managed sites). The admin
 * approval queue depends on that behaviour.
 *
 * clock.tsx is a PERSONAL screen. It previously called the endpoint with `{}`
 * and then picked the first row whose `confirmationStatus` was
 * `awaiting_confirmation`. For an admin who had worked a shift, that first row
 * was another officer's entry — so the card displayed someone else's clock-in
 * and clock-out times, and tapping "Review & confirm" failed with a 403
 * ("You can only confirm your own time entries"), because the confirm endpoint
 * is correctly owner-gated.
 *
 * Two properties are verified:
 *
 * 1. **Server-side scoping** — the useGetTimeEntries hook passes an
 *    `employeeId` filter so the phone never downloads other people's entries.
 * 2. **Client-side ownership re-assertion** — the awaiting-entry selection
 *    filters on the entry's `employeeId`, so the card degrades safely even if
 *    the request param is ever dropped or the cache is seeded from a wider
 *    query.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

function read(relFromRoot: string): string {
  return readFileSync(path.join(ROOT, relFromRoot), "utf8");
}

describe("clock.tsx confirmation card is scoped to the signed-in user", () => {
  const src = read("app/(employee)/clock.tsx");

  it("passes an employeeId filter to useGetTimeEntries", () => {
    // Match the hook invocation itself: `useGetTimeEntries(` followed by a
    // params object containing employeeId, before the options argument.
    const scoped = /useGetTimeEntries\s*\(\s*\{[^}]*employeeId\s*:/.test(src);
    expect(
      scoped,
      "clock.tsx must call useGetTimeEntries with an { employeeId } filter. " +
        "Without it, GET /api/time-entries returns every employee's entries to " +
        "an admin (and every managed site's entries to a site manager), so the " +
        "personal 'Confirm your last shift' card can show another officer's shift.",
    ).toBe(true);
  });

  it("does not call useGetTimeEntries with an empty, unscoped params object", () => {
    const unscoped = /useGetTimeEntries\s*\(\s*\{\s*\}/.test(src);
    expect(
      unscoped,
      "clock.tsx must not call useGetTimeEntries({}) — an unscoped call leaks " +
        "other employees' time entries onto this personal screen.",
    ).toBe(false);
  });

  it("re-asserts entry ownership when picking the awaiting entry", () => {
    const ownershipChecked = /confirmationStatus\s*===\s*"awaiting_confirmation"[\s\S]{0,120}employeeId\s*===/.test(
      src,
    );
    expect(
      ownershipChecked,
      "The awaiting-entry selection must also compare the entry's employeeId to " +
        "the signed-in user's id. POST /time-entries/:id/confirm is owner-gated, " +
        "so surfacing an entry the user does not own produces a card that can " +
        "never be confirmed (403).",
    ).toBe(true);
  });

  it("picks the most recent awaiting entry rather than trusting list order", () => {
    const sortsByClockIn = /\.sort\(\s*\([\s\S]{0,80}clockInTime[\s\S]{0,80}\)/.test(src);
    expect(
      sortsByClockIn,
      "The card is titled 'Confirm your last shift', so the selection must sort " +
        "candidates by clockInTime and take the newest, not rely on the order the " +
        "list endpoint happened to return.",
    ).toBe(true);
  });
});
