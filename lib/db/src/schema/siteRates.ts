import { pgTable, text, uuid, timestamp, numeric, integer, unique } from "drizzle-orm/pg-core";
import { sitesTable } from "./sites";

/**
 * Per-site pay + bill rates, keyed by license level.
 *
 * Lets each site/client carry a rate card per position type — e.g. for "Vivo":
 *   L2 (unarmed):    pay $X / bill $Y
 *   L3 (armed):      pay $X / bill $Y
 *   L4/PPO:          pay $X / bill $Y
 *
 * Shift creation pulls these rates into the shift form, so the shift's
 * canonical payRate / billRate reflect the site + license-level combo. Admins
 * can still override on the shift itself when a one-off rate is needed.
 *
 * One row per (siteId, licenseLevel) — upsert on conflict enforced by
 * unique("site_rates_site_level_uniq") below.
 * licenseLevel mirrors the shift/license hierarchy: 2=L2 Unarmed, 3=L3 Armed, 4=L4/PPO.
 */
export const siteRatesTable = pgTable("site_rates", {
  id: uuid("id").primaryKey().defaultRandom(),
  siteId: uuid("site_id").notNull().references(() => sitesTable.id, { onDelete: "cascade" }),
  licenseLevel: integer("license_level").notNull(),
  payRate: numeric("pay_rate", { precision: 10, scale: 2 }).notNull(),
  billRate: numeric("bill_rate", { precision: 10, scale: 2 }).notNull(),
  label: text("label"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (t) => [unique("site_rates_site_level_uniq").on(t.siteId, t.licenseLevel)]);

export type SiteRate = typeof siteRatesTable.$inferSelect;
