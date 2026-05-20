import { pgTable, text, uuid, timestamp, numeric, integer, unique } from "drizzle-orm/pg-core";
import { sitesTable } from "./sites";

/**
 * Per-site bill rates keyed by license level.
 * One row per (site, licenseLevel) — upsert on conflict.
 * licenseLevel mirrors the shift/license hierarchy: 2=L2 Unarmed, 3=L3 Armed, 4=L4/PPO.
 */
export const siteBillRatesTable = pgTable("site_bill_rates", {
  id: uuid("id").primaryKey().defaultRandom(),
  siteId: uuid("site_id").notNull().references(() => sitesTable.id, { onDelete: "cascade" }),
  licenseLevel: integer("license_level").notNull(),
  rate: numeric("rate", { precision: 10, scale: 2 }).notNull(),
  label: text("label"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (t) => ({
  siteLevelUniq: unique("site_bill_rates_site_level_uniq").on(t.siteId, t.licenseLevel),
}));

export type SiteBillRate = typeof siteBillRatesTable.$inferSelect;
