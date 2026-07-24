/**
 * Static analysis test: EmployeeClockScreen doesn't re-fetch on every sub-tab switch.
 *
 * Both sub-screens inside My Work (Shifts + Clock) are permanently mounted via a
 * CSS `display` toggle rather than a conditional render. This means switching from
 * "Clock In/Out" to "My Shifts" and back NEVER triggers a new React component
 * mount on the Clock screen. Because React Query's `refetchOnMount` fires only
 * when a component mounts, and no new mount occurs on sub-tab switch, no
 * redundant network requests are issued just from navigating between the two panes.
 *
 * A conditional-render approach (e.g. `{activeTab === "clock" && <EmployeeClockScreen>}`)
 * would unmount Clock when the officer switches to Shifts, then remount it on
 * return — triggering a full React Query refetch cycle and showing a brief loading
 * spinner every time, even when the data is fresh.
 *
 * Two properties are verified:
 *
 * 1. **Display-toggle, not conditional-render** — `my-work.tsx` wraps Clock in a
 *    View with `display: activeTab === "clock" ? ... : ...`. A conditional
 *    render that could return `null` would remount the screen and trigger refetches.
 *
 * 2. **No explicit refetchOnMount override** — `clock.tsx` must not explicitly
 *    set `refetchOnMount: true` on its queries. The display-toggle already prevents
 *    spurious mount events; an explicit `refetchOnMount: true` would override RQ's
 *    mount-detection logic and still re-fetch on *every render cycle*, defeating
 *    the protection entirely.
 *
 * This file mirrors `shiftsNoRefetchOnTabSwitch.test.ts` for symmetric coverage.
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

const MY_WORK = "app/(employee)/my-work.tsx";
const CLOCK = "app/(employee)/clock.tsx";

describe("EmployeeClockScreen — no redundant fetches on sub-tab switch", () => {
  it("Clock pane uses display-toggle so the screen is never unmounted on tab switch", () => {
    const src = read(MY_WORK);

    // EmployeeClockScreen must appear exactly once — a single permanently-mounted
    // instance whose visibility is controlled by `display`, not by conditional render.
    const instances = (src.match(/<EmployeeClockScreen/g) ?? []).length;
    expect(
      instances,
      "EmployeeClockScreen must appear exactly once in my-work.tsx. " +
        "More than one instance would mean it is being duplicated across " +
        "conditional branches; zero means it is missing entirely.",
    ).toBe(1);

    // The wrapping View must use `display: activeTab === "clock" ? ... : ...` to
    // show/hide the pane without unmounting. React Query's refetchOnMount only fires
    // when a component mounts; keeping it mounted means no re-fetch on tab switch.
    const hasDisplayToggle =
      /display\s*:\s*activeTab\s*===\s*"clock"\s*\?/.test(src) ||
      /display\s*:\s*activeTab\s*!==\s*"clock"\s*\?/.test(src);
    expect(
      hasDisplayToggle,
      "my-work.tsx must control Clock visibility with a `display` style prop " +
        '(e.g. `display: activeTab === "clock" ? "flex" : "none"`). ' +
        "This keeps the component tree mounted at all times so React Query " +
        "never sees a new mount event when the officer switches back to Clock.",
    ).toBe(true);

    // Guard against conditional renders that produce null / nothing for Clock.
    // Any of these patterns would unmount the screen and re-trigger all its queries.
    const hasConditionalClockMount =
      /activeTab\s*===\s*"clock"\s*&&\s*<EmployeeClockScreen/.test(src) ||
      /activeTab\s*!==\s*"clock"\s*&&\s*<EmployeeClockScreen/.test(src) ||
      /activeTab\s*===\s*"clock"\s*\?\s*<EmployeeClockScreen/.test(src) ||
      /activeTab\s*!==\s*"clock"\s*\?\s*null\s*:\s*<EmployeeClockScreen/.test(src) ||
      /activeTab\s*!==\s*"clock"\s*\?\s*<EmployeeClockScreen/.test(src);
    expect(
      hasConditionalClockMount,
      "my-work.tsx must NOT conditionally render EmployeeClockScreen. " +
        'A conditional mount (e.g. `{activeTab === "clock" && <EmployeeClockScreen>}`) ' +
        "unmounts the screen on every sub-tab switch, causing React Query to " +
        "fire a full refetch cycle — including a loading spinner — each time " +
        "the officer returns to the Clock In/Out pane.",
    ).toBe(false);
  });

  it("clock.tsx queries do not explicitly opt into refetchOnMount:true", () => {
    const src = read(CLOCK);

    // `refetchOnMount: true` in a query config overrides React Query's smart
    // mount-detection and forces a refetch on every render cycle regardless of
    // staleTime. The display-toggle protection in my-work.tsx already prevents
    // spurious mount events, but an explicit `refetchOnMount: true` would defeat
    // that by re-fetching even on renders that are not caused by a real mount.
    const hasExplicitRefetchOnMountTrue =
      /refetchOnMount\s*:\s*true/.test(src);
    expect(
      hasExplicitRefetchOnMountTrue,
      "clock.tsx must not set `refetchOnMount: true` on any query. " +
        "The display-toggle in my-work.tsx already prevents mount events on " +
        "tab switch. An explicit `refetchOnMount: true` would bypass that and " +
        "re-fetch on every render.",
    ).toBe(false);
  });

  it("the three data queries in clock.tsx each pass an explicit queryKey", () => {
    const src = read(CLOCK);

    // Passing an explicit stable queryKey ensures React Query can find and
    // reuse the cached response on subsequent renders without an additional
    // network round-trip. Without an explicit key, some Orval-generated hooks
    // derive a key dynamically on every call, which can break deduplication.
    //
    // WHY THE STRICTER REGEX FOR activeTimeEntry:
    // A bare `/getGetActiveTimeEntryQueryKey\(\)/.test(src)` would pass even if
    // the key only appears in queryClient.invalidateQueries or setQueryData calls —
    // which clock.tsx has several of — and is never wired into the hook invocation
    // itself. The tighter pattern matches the Orval hook shape
    //   `query: { queryKey: getGetActiveTimeEntryQueryKey() }`
    // so the assertion only passes when the key is inside the hook's own `query`
    // option, confirming that the Clock pane and the Shifts pane share the same
    // cache entry for the active time entry (no duplicate network requests, no
    // button-state flicker as two independent fetches race each other).
    // This mirrors the same tightening applied in shiftsNoRefetchOnTabSwitch.test.ts.
    const hasActiveEntryKey =
      /query\s*:\s*\{[^}]*queryKey\s*:\s*getGetActiveTimeEntryQueryKey\s*\(\s*\)/.test(src);
    // Same tightening as the other two keys: match the Orval hook shape
    // `query: { queryKey: getGetTimeEntriesQueryKey({...}) }` so the assertion
    // only passes when the key is wired into the hook invocation itself, not
    // merely present in an invalidateQueries/setQueryData call elsewhere.
    const hasTimeEntriesKey =
      /query\s*:\s*\{[^}]*queryKey\s*:\s*getGetTimeEntriesQueryKey\s*\(/.test(src);
    // Tighter than a bare getGetMyClockInShiftsQueryKey() presence check: the key
    // also appears in queryClient.invalidateQueries calls (which use `queryKey:`
    // directly, without the `query:` wrapper). Matching the Orval hook shape
    // `query: { queryKey: getGetMyClockInShiftsQueryKey() }` ensures the key is
    // actually wired into the hook invocation, not just a cache-invalidation call.
    const hasClockInShiftsKey =
      /query\s*:\s*\{\s*queryKey\s*:\s*getGetMyClockInShiftsQueryKey\s*\(\s*\)/.test(src);

    expect(
      hasActiveEntryKey,
      "clock.tsx must pass getGetActiveTimeEntryQueryKey() directly inside " +
        "useGetActiveTimeEntry's `query: { queryKey: ... }` option so the Clock " +
        "pane shares the same React Query cache entry as the Shifts pane. A bare " +
        "presence check would pass even if the key only appeared in an " +
        "invalidateQueries or setQueryData call, leaving the hook invocation " +
        "uncovered and causing the two panes to issue separate network requests.",
    ).toBe(true);

    expect(
      hasTimeEntriesKey,
      "clock.tsx must pass an explicit queryKey (getGetTimeEntriesQueryKey(...)) " +
        "to useGetTimeEntries so the cached recent-entries list is reused across renders.",
    ).toBe(true);

    expect(
      hasClockInShiftsKey,
      "clock.tsx must pass getGetMyClockInShiftsQueryKey() as `query: { queryKey: ... }` " +
        "directly inside the useGetMyClockInShifts hook call. A bare presence check " +
        "is insufficient because the key also appears in queryClient.invalidateQueries " +
        "calls — a future refactor that drops the hook-level key while keeping the " +
        "invalidation call would silently pass the weaker regex while leaving the " +
        "shift-picker query uncovered.",
    ).toBe(true);
  });
});
