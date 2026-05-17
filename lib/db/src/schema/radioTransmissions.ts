import { pgTable, text, uuid, timestamp, integer, index } from "drizzle-orm/pg-core";
import { radioChannelsTable } from "./radioChannels";
import { usersTable } from "./users";

/**
 * One row per push-to-talk transmission. Audio payloads themselves are
 * NOT persisted (the channel is ephemeral by design); we only keep
 * speaker + timing metadata for audit and the admin transmission log.
 */
export const radioTransmissionsTable = pgTable("radio_transmissions", {
  id: uuid("id").primaryKey().defaultRandom(),
  channelId: uuid("channel_id").notNull().references(() => radioChannelsTable.id, { onDelete: "cascade" }),
  speakerUserId: uuid("speaker_user_id").notNull().references(() => usersTable.id, { onDelete: "set null" }),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  endedAt: timestamp("ended_at", { withTimezone: true }),
  durationMs: integer("duration_ms"),
  // Why the transmission stopped: "released" (normal release), "timeout"
  // (max-duration safety cut), "disconnect" (speaker socket dropped),
  // "preempted" (admin force-cleared the lock).
  endedReason: text("ended_reason"),
}, (t) => ({
  channelIdx: index("radio_transmissions_channel_started_idx").on(t.channelId, t.startedAt),
  speakerIdx: index("radio_transmissions_speaker_idx").on(t.speakerUserId),
}));

export type RadioTransmission = typeof radioTransmissionsTable.$inferSelect;
