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
 *                       enough to be eligible for shifts at the site.
 *                       NOTE: this is licence-based and deliberately no
 *                       longer matches chat `site` rooms, which moved to
 *                       roster-based membership (accepted assignment at the
 *                       site within a recent window + site managers).
 *
 * Channels can be muted globally with `archivedAt` instead of being
 * deleted, so historical transmission rows still resolve a name.
 *
 * `alwaysOn` marks the ONE channel (in practice Dispatch) that a clocked-in
 * officer's phone keeps connected in the background — the walkie-talkie left
 * on their belt. Every other channel only carries audio while the officer is
 * looking at it in the foreground. Off duty, nothing is held open at all.
 * Exclusivity is enforced transactionally by the admin write routes, which
 * clear the flag on every other channel when it is set, so the mobile client
 * can safely treat "first channel with alwaysOn" as the designated one.
 *
 * `alwaysOnSetAt` records that a human has made a decision about this channel's
 * flag (on OR off). Boot-time adoption of a channel named "Dispatch" only runs
 * while no channel is flagged AND none has ever been set, so an admin who
 * deliberately turns the designation off is not overruled on the next deploy.
 */
export const radioChannelsTable = pgTable("radio_channels", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  scope: text("scope").notNull().default("all_officers"),
  siteId: uuid("site_id").references(() => sitesTable.id, { onDelete: "cascade" }),
  adminOnly: boolean("admin_only").notNull().default(false),
  alwaysOn: boolean("always_on").notNull().default(false),
  alwaysOnSetAt: timestamp("always_on_set_at", { withTimezone: true }),
  slug: text("slug"),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  scopeIdx: index("radio_channels_scope_idx").on(t.scope),
  slugUnique: uniqueIndex("radio_channels_slug_unique").on(t.slug),
}));

export type RadioChannel = typeof radioChannelsTable.$inferSelect;
