import { pgTable, text, uuid, timestamp, boolean, index, uniqueIndex } from "drizzle-orm/pg-core";
import { sitesTable } from "./sites";

/**
 * Push-to-talk "walkie-talkie" radio channels.
 *
 * Membership is computed at the server from `scope`:
 *   - `global`        — every active user (officers + admins).
 *   - `all_officers`  — every active officer; admins always included.
 *   - `admins`        — admin role only. Hidden from officers entirely.
 *   - `site`          — admins + officers whose maxLicenseLevel is high
 *                       enough to be eligible for shifts at the site
 *                       (mirrors how the chat `site` rooms are gated).
 *
 * Channels can be muted globally with `archivedAt` instead of being
 * deleted, so historical transmission rows still resolve a name.
 */
export const radioChannelsTable = pgTable("radio_channels", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  scope: text("scope").notNull().default("all_officers"),
  siteId: uuid("site_id").references(() => sitesTable.id, { onDelete: "cascade" }),
  adminOnly: boolean("admin_only").notNull().default(false),
  slug: text("slug"),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  scopeIdx: index("radio_channels_scope_idx").on(t.scope),
  slugUnique: uniqueIndex("radio_channels_slug_unique").on(t.slug),
}));

export type RadioChannel = typeof radioChannelsTable.$inferSelect;
