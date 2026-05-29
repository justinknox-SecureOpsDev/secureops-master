import { pgTable, uuid, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { chatRoomsTable } from "./chatRooms";
import { usersTable } from "./users";

/**
 * Per-user "last read" watermark for chat rooms. One row per (room, user);
 * `lastReadAt` is bumped to now() whenever the user opens that conversation.
 * Unread counts are derived as messages in the room newer than this
 * watermark that were not sent by the user themselves. Absence of a row
 * means the user has never opened the room (everything is unread).
 */
export const chatRoomReadsTable = pgTable("chat_room_reads", {
  id: uuid("id").primaryKey().defaultRandom(),
  roomId: uuid("room_id").notNull().references(() => chatRoomsTable.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  lastReadAt: timestamp("last_read_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  roomUserUnique: uniqueIndex("chat_room_reads_room_user_unique").on(t.roomId, t.userId),
}));

export type ChatRoomRead = typeof chatRoomReadsTable.$inferSelect;
