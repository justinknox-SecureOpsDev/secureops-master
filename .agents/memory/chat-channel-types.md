---
name: Chat channel types & membership model
description: How chat room access is derived from type, the general→announcements alias, and the no-defaults seeding rule
---

# Chat channels: access is type-driven, and the template ships zero defaults

## Rule
Chat room read/post access is computed from `chat_rooms.type` server-side
(`resolveRoomMembers` in `routes/chat.ts`), NOT primarily from stored
memberships:
- `announcements` → everyone (returns `null` ⇒ all authenticated users read **and** post)
- `ops` → admins only
- `license_level` → officers whose max unexpired license meets the threshold (+admins)
- `site` → **roster-based, not licence-based**: officers with an *accepted*
  shift_assignment at that site whose shift ends within a rolling lookback
  window (upcoming/in-progress, or finished in the last N days), plus the
  site's `site_managers` (+admins). Pending claims do not count. Licence level
  grants nothing here — gating on licence put most of the company in every
  site's channel, which is what this replaced.
  Radio `site` channels still use the OLD licence rule and deliberately no
  longer match chat; don't assume the two stayed in sync.
  Membership resolution is per-request memoized (admins/licence rollup/site
  crew are bulk-loaded for the whole room list) — never cache it beyond one
  request or revoked access lingers.
- `city` / `elite` → explicit `chat_room_memberships` rows (+admins); `elite` is hidden from non-members
- **anything else (incl. legacy `general`, `shift`, and `retired`) → admins-only, fail-closed**

## Why this bites
- There are **two** channel-creation surfaces: admin portal (`Chat.tsx` dialog) and
  mobile (`ChatRoomsList.tsx`). Mobile's lightweight creator posts `type:"general"`.
  Because `general` is not a real membership type, a stored `general` room is
  **invisible to officers** (admins-only). So the create route **aliases incoming
  `general` → `announcements`** before storing, giving everyone read+post.
- "Announcements" allows everyone to post (membership = everyone), despite the name.
  UI labels must say "everyone can read and post", not "admins post".
- `joinPolicy` is metadata only; membership is type-driven. The create route
  **always derives `joinPolicy` from the type** (`DEFAULT_JOIN_POLICY`) and ignores
  any caller-supplied value, so it can't misrepresent access.

## No-defaults seeding (white-label master template)
- The template ships **no default channels**: `seedChatRooms.ts` `CANONICAL = []`.
  Per-site channels (`site:<id>`) still auto-seed from the sites table.
- `seedChatRooms` must only **retire** legacy `general`/`shift` rooms
  (`type='retired'`) — it must **NOT** promote one into a "General Announcements"
  default, or a default channel reappears on every boot (contradicts the design).
- Retired rooms are filtered out of `GET /chat/rooms` for everyone (admins included)
  — the retire flag is the "disappear from listings but keep history" mechanism, so
  the listing query must exclude `type='retired'` or admins still see them.

**How to apply:** any change to channel creation, seeding, or the room listing must
preserve: general→announcements aliasing, type-derived joinPolicy, no default-channel
promotion, and retired-room hiding. Keep the admin + mobile creators in sync.
