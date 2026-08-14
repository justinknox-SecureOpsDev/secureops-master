import { pgTable, text, uuid, timestamp, numeric, integer, unique } from "drizzle-orm/pg-core";
import { sitesTable } from "./sites";

/**
 * Per-site pay + bill rates. Each row is a NAMED POSITION at a license level.
 *
 * A site's rate card is a free-form list of named positions — "Tier 1",
 * "Floor Manager", "Overnight Supervisor" — each pinned to a license level
 * with its own pay + bill rate, e.g.:
 *   L2 (unarmed) "Day Post":     pay $X / bill $Y
 *   L2 (unarmed) "Floor Manager": pay $X / bill $Y
 *   L3 (armed)   "Overnight":     pay $X / bill $Y
 *
 * There is no cap on how many positions a level may carry, and `name` is the
 * primary label everywhere a rate is shown or picked.
 *
 * Shift creation pulls these rates into the shift form, so the shift's
 * canonical payRate / billRate reflect the site + position combo. Admins can
 * still override on the shift itself when a one-off rate is needed.
 *
 * `rateTier` is an INTERNAL slot number, assigned automatically (max+1 per
 * level) purely to keep the historical unique("site_rates_site_level_tier_uniq")
 * constraint satisfiable and to give unnamed legacy rows a stable default
 * label ("Rate 1"). It is never chosen by an admin. `name` is nullable so rows
 * created before naming existed keep working.
 * licenseLevel mirrors the shift/license hierarchy: 2=L2 Unarmed, 3=L3 Armed, 4=L4/PPO.
 */
export const siteRatesTable = pgTable("site_rates", {
  id: uuid("id").primaryKey().defaultRandom(),
  siteId: uuid("site_id").notNull().references(() => sitesTable.id, { onDelete: "cascade" }),
  licenseLevel: integer("license_level").notNull(),
  /** Admin-chosen position name. Null on legacy rows → display falls back to "Rate <rateTier>". */
  name: text("name"),
  rateTier: integer("rate_tier").notNull().default(1),
  payRate: numeric("pay_rate", { precision: 10, scale: 2 }).notNull(),
  billRate: numeric("bill_rate", { precision: 10, scale: 2 }).notNull(),
  label: text("label"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (t) => [unique("site_rates_site_level_tier_uniq").on(t.siteId, t.licenseLevel, t.rateTier)]);

export type SiteRate = typeof siteRatesTable.$inferSelect;
