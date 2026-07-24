import { pgTable, text, uuid, timestamp, integer, boolean, uniqueIndex, index } from "drizzle-orm/pg-core";

/**
 * Chat rooms.
 *
 * Room types and how membership is computed (see
 * artifacts/api-server/src/routes/chat.ts → resolveRoomMembers):
 *
 *   - `announcements`  — every authenticated user; admins post, everyone reads.
 *   - `license_level`  — every officer with maxLicenseLevel >= licenseLevel
 *                        (auto, based on unexpired licenses). Admins always
 *                        included.
 *   - `ops`            — admins only. Operations channel.
 *   - `site`           — officers with maxLicenseLevel >= the site's
 *                        requiredLicenseLevel (auto). Admins always included.
 *   - `city`           — explicit membership via chat_room_memberships
 *                        (request-to-join, admin approves).
 *   - `elite`          — explicit membership via chat_room_memberships
 *                        (invite-only). Admins always included.
 *   - `direct`         — exactly the two participants encoded in directKey.
 *   - `general`        — legacy alias for `announcements`. Kept so old rows
 *                        don't 404 mid-migration; new seeds use `announcements`.
 */
export const chatRoomsTable = pgTable("chat_rooms", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  type: text("type").notNull().default("announcements"),
  // For license_level rooms: the minimum maxLicenseLevel an officer must
  // hold to be auto-added. e.g. 2 = unarmed+, 3 = armed+, 4 = PPO.
  licenseLevel: integer("license_level"),
  // For site rooms: which physical site this channel belongs to.
  siteId: uuid("site_id"),
  // For city rooms: the residence city users can request to join from.
  city: text("city"),
  // Used by the UI to decide what button to render for non-members:
  //   auto    — auto-eligibility (license_level, ops, site, announcements)
  //   request — show "Request to join" button (city)
  //   invite  — show "Invite only" badge, hidden unless invited (elite)
  joinPolicy: text("join_policy").notNull().default("auto"),
  // Legacy column from the old per-shift chat rooms. Kept for migration
  // safety; new code does not populate it. resolveRoomMembers ignores it.
  shiftId: uuid("shift_id"),
  // Direct-message key: sorted "userIdA:userIdB" for type=direct.
  directKey: text("direct_key"),
  // Slug used by canonical-room seeding so we can idempotently upsert by
  // semantic identity rather than fragile name matching. Only set on
  // canonical rooms; null on direct rooms and admin-created channels.
  slug: text("slug"),
  // Admins can pin rooms to always float to the top of every member's list.
  pinned: boolean("pinned").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  directKeyUnique: uniqueIndex("chat_rooms_direct_key_unique").on(t.directKey),
  slugUnique: uniqueIndex("chat_rooms_slug_unique").on(t.slug),
  typeIdx: index("chat_rooms_type_idx").on(t.type),
}));

export type ChatRoom = typeof chatRoomsTable.$inferSelect;
