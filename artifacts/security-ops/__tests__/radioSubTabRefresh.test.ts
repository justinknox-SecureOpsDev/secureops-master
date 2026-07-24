/**
 * Static analysis test: the embedded Radio sub-tab refetches its channel
 * roster when the officer switches to it inside the Chat screen.
 *
 * RadioScreen is embedded in `app/(employee)/chat.tsx` as a second sub-tab and
 * kept permanently mounted behind a CSS `display` toggle (same pattern as the
 * My Work screen — no remount, no spinner on switch). Because it never
 * remounts, and expo-router's `useFocusEffect` fires only when the PARENT Chat
 * tab gains focus, flipping between the "Messages" and "Radio" sub-tabs would
 * otherwise never refetch — a site channel an admin just created would stay
 * invisible until the officer left and re-entered the whole Chat tab.
 *
 * The fix is an explicit refresh handshake:
 *  - chat.tsx keeps a `radioEpoch` counter and bumps it each time the active
 *    sub-tab transitions TO "radio" (not on every render, not on messages).
 *  - RadioScreen accepts a `refreshEpoch` prop and refetches `/radio/channels`
 *    whenever the epoch changes past its initial mount value (0), skipping the
 *    duplicate request on first mount (useFocusEffect covers that one).
 *
 * These assertions are source-pattern checks so they hold without rendering
 * the react-native component tree (which vitest cannot parse — see the
 * vitest-rn-import-parse-error memory note).
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

const CHAT = "app/(employee)/chat.tsx";
const RADIO = "components/radio/RadioScreen.tsx";

describe("Radio sub-tab inside Chat — refresh on switch", () => {
  it("chat.tsx keeps RadioScreen mounted via display-toggle (no remount flicker)", () => {
    const src = read(CHAT);

    const instances = (src.match(/<RadioScreen/g) ?? []).length;
    expect(
      instances,
      "RadioScreen must appear exactly once in chat.tsx — a single " +
        "permanently-mounted instance hidden/shown via `display`.",
    ).toBe(1);

    const hasDisplayToggle = /display\s*:\s*activeTab\s*===\s*"radio"\s*\?/.test(src);
    expect(
      hasDisplayToggle,
      "chat.tsx must control the Radio pane with a `display` style toggle " +
        "so RadioScreen (and its WebSocket / LiveKit state) is never unmounted " +
        "on sub-tab switch.",
    ).toBe(true);
  });

  it("chat.tsx bumps an epoch when switching TO the Radio sub-tab and passes it as refreshEpoch", () => {
    const src = read(CHAT);

    // The epoch must be wired into the RadioScreen instance...
    expect(
      /<RadioScreen\s+refreshEpoch=\{radioEpoch\}/.test(src),
      "chat.tsx must pass its radioEpoch state into <RadioScreen refreshEpoch={radioEpoch} /> " +
        "so the embedded screen can react to sub-tab visibility changes.",
    ).toBe(true);

    // ...and bumped only on a transition INTO the radio tab, so re-tapping the
    // already-active Radio tab or switching to Messages does not spam refetches.
    const bumpsOnTransition =
      /t\s*===\s*"radio"\s*&&\s*prev\s*!==\s*"radio"/.test(src) &&
      /setRadioEpoch\(\s*\(e\)\s*=>\s*e\s*\+\s*1\s*\)/.test(src);
    expect(
      bumpsOnTransition,
      "chat.tsx must increment radioEpoch only when the active sub-tab " +
        "transitions to \"radio\" from a different tab (guarded by " +
        "`t === \"radio\" && prev !== \"radio\"`), not on every tap or render.",
    ).toBe(true);
  });

  it("RadioScreen refetches channels when refreshEpoch changes, skipping the mount value", () => {
    const src = read(RADIO);

    expect(
      /refreshEpoch\s*=\s*0\s*\}\s*:\s*\{\s*refreshEpoch\?\s*:\s*number\s*\}/.test(src),
      "RadioScreen must accept an optional numeric refreshEpoch prop " +
        "(defaulting to 0) so standalone usages — e.g. the dedicated admin " +
        "Radio tab — keep working unchanged.",
    ).toBe(true);

    // The epoch effect must ignore the initial mount value (0) — useFocusEffect
    // already fetches on first focus, so re-fetching at epoch 0 would issue a
    // duplicate request on every mount.
    const skipsMountEpoch = /if\s*\(\s*refreshEpoch\s*===\s*0\s*\)\s*return/.test(src);
    expect(
      skipsMountEpoch,
      "RadioScreen's epoch effect must early-return when refreshEpoch === 0 " +
        "so the initial mount does not double-fetch alongside useFocusEffect.",
    ).toBe(true);

    // Both the focus effect and the epoch effect must funnel through the same
    // shared fetch callback so behavior (silent refetch, first-load spinner,
    // stale-error clearing, cancellation) never diverges between the two paths.
    const sharedFetch =
      /useFocusEffect\(\s*fetchChannels\s*\)/.test(src) &&
      /return\s+fetchChannels\(\)/.test(src) &&
      /\[\s*refreshEpoch\s*,\s*fetchChannels\s*\]/.test(src);
    expect(
      sharedFetch,
      "RadioScreen must reuse one fetchChannels callback for both " +
        "useFocusEffect and the refreshEpoch effect (with refreshEpoch in the " +
        "effect deps and the cancellation cleanup returned), so the two refresh " +
        "paths cannot drift apart.",
    ).toBe(true);
  });
});
