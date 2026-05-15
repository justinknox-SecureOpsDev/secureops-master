import { pgTable, text, uuid, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

export const chatRoomsTable = pgTable("chat_rooms", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  type: text("type").notNull().default("general"), // general | direct | shift
  shiftId: uuid("shift_id"),
  directKey: text("direct_key"), // sorted "userIdA:userIdB" for type=direct
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  directKeyUnique: uniqueIndex("chat_rooms_direct_key_unique").on(t.directKey),
}));

export type ChatRoom = typeof chatRoomsTable.$inferSelect;
