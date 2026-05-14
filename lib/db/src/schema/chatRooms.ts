import { pgTable, text, uuid, timestamp, boolean } from "drizzle-orm/pg-core";

export const chatRoomsTable = pgTable("chat_rooms", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  type: text("type").notNull().default("general"), // general | direct | shift
  shiftId: uuid("shift_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type ChatRoom = typeof chatRoomsTable.$inferSelect;
