/**
 * Static analysis test: the Messages sub-tab refetches its room list when the
 * officer switches back to it inside the Chat screen.
 *
 * Mirror image of __tests__/radioSubTabRefresh.test.ts: both sub-tab panes in
 * `app/(employee)/chat.tsx` are permanently mounted behind a CSS `display`
 * toggle, so expo-router focus never fires on a sub-tab flip. ChatRoomsList
 * fetches `/chat/rooms` only on mount and pull-to-refresh (no WebSocket or
 * React Query invalidation covers room creation), so without an explicit
 * handshake a room created while the officer sat on the Radio sub-tab stays
 * invisible until the whole Chat tab loses and regains focus.
 *
 * The fix is the same epoch pattern used for the Radio pane:
 *  - chat.tsx keeps a `messagesEpoch` counter and bumps it only on a
 *    transition TO "messages" from a different sub-tab.
 *  - ChatRoomsList accepts an optional `refreshEpoch` prop (default 0) and
 *    silently refetches rooms + unread counts when the epoch changes past its
 *    mount value.
 *
 * Source-pattern checks only — vitest cannot render the react-native tree
 * (see the vitest-rn-import-parse-error memory note).
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
const ROOMS_LIST = "components/chat/ChatRoomsList.tsx";

describe("Messages sub-tab inside Chat — refresh on switch back", () => {
  it("chat.tsx bumps an epoch when switching TO the Messages sub-tab and passes it as refreshEpoch", () => {
    const src = read(CHAT);

    // The epoch must be wired into the ChatRoomsList instance...
    expect(
      /<ChatRoomsList\s+refreshEpoch=\{messagesEpoch\}/.test(src),
      "chat.tsx must pass its messagesEpoch state into " +
        "<ChatRoomsList refreshEpoch={messagesEpoch} /> so the permanently " +
        "mounted room list can react to sub-tab visibility changes.",
    ).toBe(true);

    // ...and bumped only on a transition INTO the messages tab, so re-tapping
    // the already-active Messages tab does not spam refetches.
    const bumpsOnTransition =
      /t\s*===\s*"messages"\s*&&\s*prev\s*!==\s*"messages"/.test(src) &&
      /setMessagesEpoch\(\s*\(e\)\s*=>\s*e\s*\+\s*1\s*\)/.test(src);
    expect(
      bumpsOnTransition,
      "chat.tsx must increment messagesEpoch only when the active sub-tab " +
        'transitions to "messages" from a different tab (guarded by ' +
        '`t === "messages" && prev !== "messages"`), not on every tap or render.',
    ).toBe(true);
  });

  it("ChatRoomsList refetches rooms when refreshEpoch changes, skipping the mount value", () => {
    const src = read(ROOMS_LIST);

    expect(
      /refreshEpoch\s*=\s*0\s*\}\s*:\s*Props/.test(src) &&
        /refreshEpoch\?\s*:\s*number/.test(src),
      "ChatRoomsList must accept an optional numeric refreshEpoch prop " +
        "(defaulting to 0) so standalone usages keep working unchanged.",
    ).toBe(true);

    // The epoch effect must ignore the initial mount value (0) — the mount
    // effect already fetches, so re-fetching at epoch 0 would double-fetch.
    const skipsMountEpoch = /if\s*\(\s*refreshEpoch\s*===\s*0\s*\)\s*return/.test(src);
    expect(
      skipsMountEpoch,
      "ChatRoomsList's epoch effect must early-return when refreshEpoch === 0 " +
        "so the initial mount does not double-fetch alongside the mount effect.",
    ).toBe(true);

    // The epoch effect must reuse the same fetchRooms callback as mount and
    // pull-to-refresh so the paths cannot drift, and keep unread counts fresh.
    const sharedFetch =
      /void\s+fetchRooms\(\)/.test(src) &&
      /void\s+refreshUnread\(\)/.test(src) &&
      /\[\s*refreshEpoch\s*,\s*fetchRooms\s*,\s*refreshUnread\s*\]/.test(src);
    expect(
      sharedFetch,
      "ChatRoomsList must reuse the shared fetchRooms callback (plus " +
        "refreshUnread) in the refreshEpoch effect, with refreshEpoch in the " +
        "effect deps.",
    ).toBe(true);
  });
});
