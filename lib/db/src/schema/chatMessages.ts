import { pgTable, text, uuid, timestamp, index } from "drizzle-orm/pg-core";
import { chatRoomsTable } from "./chatRooms";
import { usersTable } from "./users";

export const chatMessagesTable = pgTable("chat_messages", {
  id: uuid("id").primaryKey().defaultRandom(),
  roomId: uuid("room_id").notNull().references(() => chatRoomsTable.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  content: text("content").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  roomCreatedIdx: index("chat_messages_room_created_idx").on(t.roomId, t.createdAt),
}));

export type ChatMessage = typeof chatMessagesTable.$inferSelect;
