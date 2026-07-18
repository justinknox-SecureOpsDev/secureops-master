import { pgTable, text, uuid, timestamp, numeric, integer } from "drizzle-orm/pg-core";
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
 * One row per (siteId, licenseLevel) — upsert on conflict.
 * licenseLevel mirrors the shift/license hierarchy: 2=L2 Unarmed, 3=L3 Armed, 4=L4/PPO.
 *
 * NOTE: The UNIQUE(site_id, license_level) constraint (named site_rates_site_level_uniq)
 * is managed outside Drizzle via the boot backfill in seedDemoUsers.ts
 * (deduplicateSiteRatesAndEnsureUniqueConstraint). It is intentionally absent here
 * so Replit's migration validator does not try to apply it when the production DB
 * has legacy duplicate rows. Once production boots and the backfill deduplicates the
 * data and creates the pg_constraint, re-add the unique() call here and the schema
 * can be restored to the canonical form via a second deploy (drizzle-kit push will
 * see the constraint already exists and emit no SQL).
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
});

export type SiteRate = typeof siteRatesTable.$inferSelect;
