import { pgTable, uuid, text, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core";
import { chatRoomsTable } from "./chatRooms";
import { usersTable } from "./users";

/**
 * Explicit membership rows for chat rooms that require approval or
 * invitation (city / elite). Auto-eligibility rooms (announcements,
 * license_level, ops, site) do NOT use this table — membership for those
 * is computed at request time from license/role/site data.
 *
 * Status lifecycle:
 *   - `pending`  — user requested to join (city). Admin can approve → active
 *                  or deny → row deleted (or status='denied' for audit).
 *   - `active`   — user is a confirmed member, can read/post.
 *   - `invited`  — admin invited user to elite. Accepting flips to active;
 *                  user is already allowed to read while invited.
 */
export const chatRoomMembershipsTable = pgTable("chat_room_memberships", {
  id: uuid("id").primaryKey().defaultRandom(),
  roomId: uuid("room_id").notNull().references(() => chatRoomsTable.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  status: text("status").notNull().default("pending"),
  requestedAt: timestamp("requested_at", { withTimezone: true }).notNull().defaultNow(),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
  decidedBy: uuid("decided_by").references(() => usersTable.id, { onDelete: "set null" }),
}, (t) => ({
  roomUserUnique: uniqueIndex("chat_room_memberships_room_user_unique").on(t.roomId, t.userId),
  roomStatusIdx: index("chat_room_memberships_room_status_idx").on(t.roomId, t.status),
  userStatusIdx: index("chat_room_memberships_user_status_idx").on(t.userId, t.status),
}));

export type ChatRoomMembership = typeof chatRoomMembershipsTable.$inferSelect;
