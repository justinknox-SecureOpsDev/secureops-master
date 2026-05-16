import { pgTable, uuid, text, boolean, timestamp, index, numeric } from "drizzle-orm/pg-core";
import { sitesTable } from "./sites";
import { usersTable } from "./users";
import { timeEntriesTable } from "./timeEntries";

/**
 * Patrol checkpoints — physical scan points (QR sticker / NFC tag) placed
 * around a site. `code` is the random token printed on the marker; officers
 * submit it via POST /patrol/scan to log a scan.
 */
export const patrolCheckpointsTable = pgTable("patrol_checkpoints", {
  id: uuid("id").primaryKey().defaultRandom(),
  siteId: uuid("site_id").notNull().references(() => sitesTable.id, { onDelete: "cascade" }),
  label: text("label").notNull(),
  code: text("code").notNull().unique(),
  isActive: boolean("is_active").notNull().default(true),
  createdBy: uuid("created_by").references(() => usersTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  siteIdx: index("patrol_checkpoints_site_idx").on(t.siteId),
}));

/**
 * Each successful scan. siteId is snapshotted so deleting the checkpoint
 * doesn't orphan the scan history. timeEntryId links to the officer's active
 * clock-in at scan time (may be null if scanned off-shift).
 */
export const patrolScansTable = pgTable("patrol_scans", {
  id: uuid("id").primaryKey().defaultRandom(),
  checkpointId: uuid("checkpoint_id").references(() => patrolCheckpointsTable.id, { onDelete: "set null" }),
  siteId: uuid("site_id").references(() => sitesTable.id, { onDelete: "set null" }),
  userId: uuid("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  timeEntryId: uuid("time_entry_id").references(() => timeEntriesTable.id, { onDelete: "set null" }),
  scannedAt: timestamp("scanned_at", { withTimezone: true }).notNull().defaultNow(),
  lat: numeric("lat", { precision: 10, scale: 6 }),
  lng: numeric("lng", { precision: 10, scale: 6 }),
}, (t) => ({
  siteTimeIdx: index("patrol_scans_site_scannedat_idx").on(t.siteId, t.scannedAt),
  userTimeIdx: index("patrol_scans_user_scannedat_idx").on(t.userId, t.scannedAt),
}));

export type PatrolCheckpoint = typeof patrolCheckpointsTable.$inferSelect;
export type PatrolScan = typeof patrolScansTable.$inferSelect;
