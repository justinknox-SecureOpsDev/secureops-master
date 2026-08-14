import { pgTable, text, uuid, timestamp, numeric, integer, unique } from "drizzle-orm/pg-core";
import { sitesTable } from "./sites";

/**
 * Per-site pay + bill rates, keyed by license level + rate tier.
 *
 * Lets each site/client carry a rate card per position type, with up to three
 * rate tiers (Rate 1 / Rate 2 / Rate 3) inside each license level — e.g.:
 *   L2 (unarmed) Rate 1:  pay $X / bill $Y
 *   L2 (unarmed) Rate 2:  pay $X / bill $Y
 *   L3 (armed)   Rate 1:  pay $X / bill $Y
 *
 * Shift creation pulls these rates into the shift form, so the shift's
 * canonical payRate / billRate reflect the site + license-level + tier combo.
 * Admins can still override on the shift itself when a one-off rate is needed.
 *
 * One row per (siteId, licenseLevel, rateTier) — upsert on conflict enforced
 * by unique("site_rates_site_level_tier_uniq") below. Pre-existing rows
 * (created before tiers existed) default to rateTier 1.
 * licenseLevel mirrors the shift/license hierarchy: 2=L2 Unarmed, 3=L3 Armed, 4=L4/PPO.
 */
export const siteRatesTable = pgTable("site_rates", {
  id: uuid("id").primaryKey().defaultRandom(),
  siteId: uuid("site_id").notNull().references(() => sitesTable.id, { onDelete: "cascade" }),
  licenseLevel: integer("license_level").notNull(),
  rateTier: integer("rate_tier").notNull().default(1),
  payRate: numeric("pay_rate", { precision: 10, scale: 2 }).notNull(),
  billRate: numeric("bill_rate", { precision: 10, scale: 2 }).notNull(),
  label: text("label"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (t) => [unique("site_rates_site_level_tier_uniq").on(t.siteId, t.licenseLevel, t.rateTier)]);

export type SiteRate = typeof siteRatesTable.$inferSelect;
