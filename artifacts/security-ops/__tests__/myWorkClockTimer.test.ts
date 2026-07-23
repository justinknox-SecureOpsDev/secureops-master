/**
 * Static analysis test: My Work tab keeps the clock timer running across sub-tab switches.
 *
 * The My Work screen hosts two sub-tabs — "My Shifts" and "Clock In/Out" — and
 * must keep BOTH sub-screens mounted at all times. If the Clock screen unmounts
 * (e.g. through a conditional render) the setInterval that drives the elapsed
 * timer is cleared, and the elapsed state resets to 0 when the screen remounts,
 * so the officer sees a freshly-started timer instead of the true elapsed time.
 *
 * Two properties are verified:
 *
 * 1. **Display-toggle, not conditional-render** — `my-work.tsx` must use a
 *    `display` style prop to show/hide the Clock pane. A conditional render
 *    (e.g. `{activeTab === "clock" && <EmployeeClockScreen>}` or a ternary that
 *    produces `null`) would unmount the screen on each tab switch, resetting the
 *    timer. The `display` approach keeps the component tree mounted with the
 *    interval still running.
 *
 * 2. **Clock-time-anchored elapsed** — `clock.tsx` must derive elapsed time from
 *    the server-provided `clockInTime` timestamp (`Date.now() - new Date(clockInTime)`),
 *    NOT from a local variable captured at mount time. An anchor to a local
 *    `mountedAt` or `Date.now()` captured outside the interval callback would give
 *    the wrong elapsed value when the component remounts (or even when it first
 *    mounts after the officer has already been clocked in for a while).
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

describe("My Work tab — clock timer stability across sub-tab switches", () => {
  it("both sub-screens are always mounted (display toggle, not conditional render)", () => {
    const src = read(MY_WORK);

    // Must contain EmployeeClockScreen exactly once — a display-toggled wrapper
    // keeps one instance mounted permanently.
    const clockInstances = (src.match(/<EmployeeClockScreen/g) ?? []).length;
    expect(
      clockInstances,
      "EmployeeClockScreen must appear exactly once in my-work.tsx. " +
        "A conditional render that produces the component in one branch and " +
        "nothing/null in the other would be counted as one instance but could " +
        "unmount on tab switch — check the next assertion too.",
    ).toBe(1);

    // The clock pane wrapper must use a `display` style prop tied to the active
    // tab, not a `{condition && <Component>}` or `{condition ? <Component> : null}` guard.
    const hasDisplayToggle =
      /display\s*:\s*activeTab\s*===\s*"clock"\s*\?/.test(src) ||
      /display\s*:\s*activeTab\s*!==\s*"clock"\s*\?/.test(src);
    expect(
      hasDisplayToggle,
      "my-work.tsx must show/hide the Clock pane with a `display` style prop " +
        "(e.g. `display: activeTab === \"clock\" ? \"flex\" : \"none\"`). " +
        "Using `{activeTab === \"clock\" && <EmployeeClockScreen>}` or a ternary " +
        "that returns null would unmount the component on every tab switch, " +
        "clearing the setInterval and resetting the elapsed timer to 0.",
    ).toBe(true);

    // Neither pane should be wrapped in a conditional that could return null.
    // Look for patterns like `{activeTab === "clock" && <EmployeeClockScreen` or
    // `{activeTab !== "clock" ? null : <EmployeeClockScreen`.
    const hasConditionalClockMount =
      /activeTab\s*===\s*"clock"\s*&&\s*<EmployeeClockScreen/.test(src) ||
      /activeTab\s*!==\s*"clock"\s*&&\s*<EmployeeClockScreen/.test(src) ||
      /activeTab\s*===\s*"clock"\s*\?\s*<EmployeeClockScreen/.test(src) ||
      /activeTab\s*!==\s*"clock"\s*\?\s*null\s*:\s*<EmployeeClockScreen/.test(src) ||
      /activeTab\s*!==\s*"clock"\s*\?\s*<EmployeeClockScreen/.test(src);
    expect(
      hasConditionalClockMount,
      "my-work.tsx must NOT conditionally render EmployeeClockScreen. " +
        "A conditional mount unmounts the clock screen when the officer switches " +
        "to the Shifts tab, clears the setInterval, and resets elapsed to 0. " +
        "Use the `display` style toggle instead.",
    ).toBe(false);
  });

  it("EmployeeShiftsScreen is also always mounted (display toggle, not conditional render)", () => {
    const src = read(MY_WORK);

    const shiftsInstances = (src.match(/<EmployeeShiftsScreen/g) ?? []).length;
    expect(
      shiftsInstances,
      "EmployeeShiftsScreen must appear exactly once in my-work.tsx.",
    ).toBe(1);

    const hasDisplayToggle =
      /display\s*:\s*activeTab\s*===\s*"shifts"\s*\?/.test(src) ||
      /display\s*:\s*activeTab\s*!==\s*"shifts"\s*\?/.test(src);
    expect(
      hasDisplayToggle,
      "my-work.tsx must show/hide the Shifts pane with a `display` style prop " +
        "(e.g. `display: activeTab === \"shifts\" ? \"flex\" : \"none\"`). " +
        "Both panes should be mounted and visibility-toggled together.",
    ).toBe(true);
  });

  it("elapsed timer is anchored to server clockInTime, not a local mount-time snapshot", () => {
    const src = read(CLOCK);

    // The useEffect that drives the timer must read `currentEntry.clockInTime`
    // (or `currentEntry?.clockInTime`) to compute the elapsed seconds.
    // This is stable: even if something causes a re-render, `Date.now() - startMs`
    // always returns the true elapsed time from the original clock-in moment.
    const readsClockInTime =
      /currentEntry\??\.clockInTime/.test(src);
    expect(
      readsClockInTime,
      "clock.tsx must derive the elapsed timer from `currentEntry.clockInTime` " +
        "(the server-authoritative clock-in timestamp). Capturing `Date.now()` at " +
        "mount/render time would give a wrong result when the component is first " +
        "shown after the officer has already been clocked in for a while.",
    ).toBe(true);

    // The timer's startMs must be derived inside the effect from clockInTime,
    // not from a useState initialised at component mount.  A `useState(Date.now())`
    // or `useState(new Date())` captured at mount would be reset to the current
    // wall-clock time on every remount, giving 0 elapsed even mid-shift.
    const hasLocalMountTimeCapture =
      /useState\s*\(\s*Date\.now\s*\(\s*\)/.test(src) ||
      /useState\s*\(\s*new\s+Date\s*\(\s*\)/.test(src);
    expect(
      hasLocalMountTimeCapture,
      "clock.tsx must NOT initialise elapsed start time via useState(Date.now()) " +
        "or useState(new Date()). That would capture the current wall-clock time " +
        "at mount/remount, producing 0 elapsed when the component is shown after " +
        "the officer already clocked in. Derive `startMs` from `currentEntry.clockInTime` " +
        "inside a useEffect instead.",
    ).toBe(false);

    // The elapsed value fed to the timer display must be computed dynamically
    // from `Date.now() - startMs` (or equivalent) on every tick, so it reflects
    // the true seconds since clock-in even if the component was hidden and
    // re-shown between ticks.
    const hasDynamicElapsed =
      /Date\.now\s*\(\s*\)\s*-\s*startMs/.test(src) ||
      /Date\.now\(\)\s*-\s*startMs/.test(src);
    expect(
      hasDynamicElapsed,
      "clock.tsx must compute elapsed seconds as `Math.floor((Date.now() - startMs) / 1000)` " +
        "(or equivalent) on every interval tick. Storing the elapsed count and " +
        "incrementing it by 1 each tick would also work, but only if the interval " +
        "is never cleared — which is exactly the case we're guarding against " +
        "(the interval IS cleared if the component unmounts). The `Date.now() - startMs` " +
        "approach is self-correcting regardless of remount.",
    ).toBe(true);
  });

  it("elapsed resets to 0 only when not clocked in, never on mount without an active entry", () => {
    const src = read(CLOCK);

    // The setElapsed(0) call should only appear inside a guard that checks
    // `isClockedIn` or `currentEntry`. A bare `setElapsed(0)` in a cleanup
    // function or a mount-only effect would reset the displayed timer each time
    // the Clock pane is shown.
    //
    // Expected pattern (from the useEffect):
    //   if (!isClockedIn || !currentEntry?.clockInTime) { setElapsed(0); return; }
    //
    // Confirm the reset is guarded by a falsy-isClockedIn / missing-clockInTime check.
    const guardedReset = /!isClockedIn[^}]*setElapsed\(0\)|setElapsed\(0\)[^}]*!isClockedIn/.test(src) ||
      /!currentEntry\??\.clockInTime[^}]*setElapsed\(0\)|setElapsed\(0\)[^}]*!currentEntry/.test(src);
    expect(
      guardedReset,
      "clock.tsx must only call setElapsed(0) when the officer is NOT clocked in " +
        "(i.e. inside an `if (!isClockedIn || ...)` branch). An unconditional reset " +
        "in a cleanup or mount effect would zero out the displayed timer whenever " +
        "the officer switches away and back to the Clock sub-tab.",
    ).toBe(true);
  });
});
