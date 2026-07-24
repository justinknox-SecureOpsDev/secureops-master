/**
 * Static analysis test: EmployeeShiftsScreen doesn't re-fetch on every sub-tab switch.
 *
 * Both sub-screens inside My Work (Shifts + Clock) are permanently mounted via a
 * CSS `display` toggle rather than a conditional render. This means switching from
 * "My Shifts" to "Clock In/Out" and back NEVER triggers a new React component
 * mount on the Shifts screen. Because React Query's `refetchOnMount` fires only
 * when a component mounts, and no new mount occurs on sub-tab switch, no
 * redundant network requests are issued just from navigating between the two panes.
 *
 * A conditional-render approach (e.g. `{activeTab === "shifts" && <EmployeeShiftsScreen>}`)
 * would unmount Shifts when the officer switches to Clock, then remount it on
 * return — triggering a full React Query refetch cycle and showing a brief loading
 * spinner every time, even when the data is fresh.
 *
 * Two properties are verified:
 *
 * 1. **Display-toggle, not conditional-render** — `my-work.tsx` wraps Shifts in a
 *    View with `display: activeTab === "shifts" ? "flex" : "none"`. A conditional
 *    render that could return `null` would remount the screen and trigger refetches.
 *
 * 2. **No explicit refetchOnMount override** — `shifts.tsx` must not explicitly
 *    set `refetchOnMount: true` on its queries. The display-toggle already prevents
 *    spurious mount events; an explicit `refetchOnMount: true` would override RQ's
 *    mount-detection logic and still re-fetch on *every render cycle*, defeating
 *    the protection entirely.
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
const SHIFTS = "app/(employee)/shifts.tsx";

describe("EmployeeShiftsScreen — no redundant fetches on sub-tab switch", () => {
  it("Shifts pane uses display-toggle so the screen is never unmounted on tab switch", () => {
    const src = read(MY_WORK);

    // EmployeeShiftsScreen must appear exactly once — a single permanently-mounted
    // instance whose visibility is controlled by `display`, not by conditional render.
    const instances = (src.match(/<EmployeeShiftsScreen/g) ?? []).length;
    expect(
      instances,
      "EmployeeShiftsScreen must appear exactly once in my-work.tsx. " +
        "More than one instance would mean it is being duplicated across " +
        "conditional branches; zero means it is missing entirely.",
    ).toBe(1);

    // The wrapping View must use `display: activeTab === "shifts" ? ... : ...` to
    // show/hide the pane without unmounting. React Query's refetchOnMount only fires
    // when a component mounts; keeping it mounted means no re-fetch on tab switch.
    const hasDisplayToggle =
      /display\s*:\s*activeTab\s*===\s*"shifts"\s*\?/.test(src) ||
      /display\s*:\s*activeTab\s*!==\s*"shifts"\s*\?/.test(src);
    expect(
      hasDisplayToggle,
      "my-work.tsx must control Shifts visibility with a `display` style prop " +
        "(e.g. `display: activeTab === \"shifts\" ? \"flex\" : \"none\"`). " +
        "This keeps the component tree mounted at all times so React Query " +
        "never sees a new mount event when the officer switches back to Shifts.",
    ).toBe(true);

    // Guard against conditional renders that produce null / nothing for Shifts.
    // Any of these patterns would unmount the screen and re-trigger all its queries.
    const hasConditionalShiftsMount =
      /activeTab\s*===\s*"shifts"\s*&&\s*<EmployeeShiftsScreen/.test(src) ||
      /activeTab\s*!==\s*"shifts"\s*&&\s*<EmployeeShiftsScreen/.test(src) ||
      /activeTab\s*===\s*"shifts"\s*\?\s*<EmployeeShiftsScreen/.test(src) ||
      /activeTab\s*!==\s*"shifts"\s*\?\s*null\s*:\s*<EmployeeShiftsScreen/.test(src) ||
      /activeTab\s*!==\s*"shifts"\s*\?\s*<EmployeeShiftsScreen/.test(src);
    expect(
      hasConditionalShiftsMount,
      "my-work.tsx must NOT conditionally render EmployeeShiftsScreen. " +
        "A conditional mount (e.g. `{activeTab === \"shifts\" && <EmployeeShiftsScreen>}`) " +
        "unmounts the screen on every sub-tab switch, causing React Query to " +
        "fire a full refetch cycle — including a loading spinner — each time " +
        "the officer returns to the My Shifts pane.",
    ).toBe(false);
  });

  it("shifts.tsx queries do not explicitly opt into refetchOnMount:true", () => {
    const src = read(SHIFTS);

    // `refetchOnMount: true` in a query config overrides React Query's smart
    // mount-detection and forces a refetch on every render cycle regardless of
    // staleTime. The display-toggle protection in my-work.tsx already prevents
    // spurious mount events, but an explicit `refetchOnMount: true` would defeat
    // that by re-fetching even on renders that are not caused by a real mount.
    const hasExplicitRefetchOnMountTrue =
      /refetchOnMount\s*:\s*true/.test(src);
    expect(
      hasExplicitRefetchOnMountTrue,
      "shifts.tsx must not set `refetchOnMount: true` on any query. " +
        "The display-toggle in my-work.tsx already prevents mount events on " +
        "tab switch. An explicit `refetchOnMount: true` would bypass that and " +
        "re-fetch on every render.",
    ).toBe(false);
  });

  it("the three primary data queries in shifts.tsx each pass an explicit queryKey", () => {
    const src = read(SHIFTS);

    // Passing an explicit stable queryKey ensures React Query can find and
    // reuse the cached response on subsequent renders without an additional
    // network round-trip. Without an explicit key, some Orval-generated hooks
    // derive a key dynamically on every call, which can break deduplication.
    //
    // WHY THE STRICTER REGEX:
    // A bare `/getGetShiftsQueryKey\(/.test(src)` would pass even if the key
    // is only used in `queryClient.invalidateQueries({ queryKey: getGetShiftsQueryKey() })`
    // calls — which shifts.tsx has several of — and never wired into the hook
    // invocation at all. The stricter pattern matches the Orval hook shape
    //   `query: { queryKey: getGet*QueryKey(...) }`
    // so the assertion only passes when the key is inside the hook's own
    // `query` option, confirming deduplication is actually active, not just
    // that the key function is imported somewhere in the file.
    // This mirrors the same tightening applied to the clock-pane test.
    const hasMeKey = /query\s*:\s*\{[^}]*queryKey\s*:\s*getGetMeQueryKey\(\)/.test(src);
    const hasEmployeeKey = /query\s*:\s*\{[^}]*queryKey\s*:\s*getGetEmployeeQueryKey\(/.test(src);
    const hasShiftsKey = /query\s*:\s*\{[^}]*queryKey\s*:\s*getGetShiftsQueryKey\(/.test(src);

    expect(
      hasMeKey,
      "shifts.tsx must pass an explicit queryKey (getGetMeQueryKey()) directly " +
        "inside the hook's `query: { queryKey: ... }` option so React Query can " +
        "match and serve the cached response without re-fetching. A bare presence " +
        "check would pass even if the key only appeared in an invalidateQueries call.",
    ).toBe(true);

    expect(
      hasEmployeeKey,
      "shifts.tsx must pass an explicit queryKey (getGetEmployeeQueryKey(...)) " +
        "directly inside useGetEmployee's `query: { queryKey: ... }` option so the " +
        "cached employee record is reused across renders. A bare presence check " +
        "would pass even if the key only appeared in an invalidateQueries call.",
    ).toBe(true);

    expect(
      hasShiftsKey,
      "shifts.tsx must pass an explicit queryKey (getGetShiftsQueryKey(...)) " +
        "directly inside useGetShifts's `query: { queryKey: ... }` option so the " +
        "cache can be keyed by the status filter and reused. A bare presence check " +
        "would pass even if the key only appeared in an invalidateQueries call — " +
        "which shifts.tsx has several of — and was never wired into the hook itself.",
    ).toBe(true);

    // useGetActiveTimeEntry drives the clock-in button state: when an officer
    // already has an open time entry, the button shows "Already Clocked In"
    // instead of the claim/clock-in action. This value must come from the React
    // Query cache, not a fresh network request, so the button stays stable while
    // the officer browses shifts. Without a stable queryKey wired into the hook
    // invocation (not just into invalidateQueries calls), RQ cannot deduplicate
    // the request against the identical fetch issued by the Clock pane — the two
    // panes would each trigger their own network round-trip, and the button could
    // flicker between "Clocked In" and an empty state as the responses race.
    const hasActiveTimeEntryKey =
      /query\s*:\s*\{[^}]*queryKey\s*:\s*getGetActiveTimeEntryQueryKey\(\)/.test(src);

    expect(
      hasActiveTimeEntryKey,
      "shifts.tsx must pass an explicit queryKey (getGetActiveTimeEntryQueryKey()) " +
        "directly inside useGetActiveTimeEntry's `query: { queryKey: ... }` option " +
        "so the clock-in button state is served from the shared cache rather than " +
        "triggering a fresh network request. A bare presence check would pass even " +
        "if the key only appeared in an invalidateQueries call and was never wired " +
        "into the hook invocation itself.",
    ).toBe(true);
  });
});
