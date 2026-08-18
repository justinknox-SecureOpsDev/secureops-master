import { pgTable, text, uuid, timestamp, numeric, integer, jsonb, boolean, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { clientsTable } from "./clients";

export const sitesTable = pgTable("sites", {
  id: uuid("id").primaryKey().defaultRandom(),
  clientId: uuid("client_id").notNull().references(() => clientsTable.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  // Lifecycle: 'active' (default) or 'inactive'. Inactive = retired/contract
  // ended but history (shifts, invoices, payroll, patrol scans) must stay
  // intact — the alternative to a hard delete, which is 409-blocked while
  // dependents exist (lib/siteDeletion.ts). Inactive sites are hidden from
  // operational surfaces (site pickers, geo clock-in resolution, new shift
  // creation, chat-channel seeding) but remain fully visible/editable in the
  // admin Sites grid so they can be reactivated.
  status: text("status").notNull().default("active"),
  address: text("address"),
  locationLat: numeric("location_lat", { precision: 10, scale: 6 }),
  locationLng: numeric("location_lng", { precision: 10, scale: 6 }),
  // Snapshot of the `address` value at the moment we last wrote
  // locationLat/Lng. Lets the bulk backfill detect sites whose address
  // has drifted since geocoding (so coords are likely stale) and lets the
  // per-site update path invalidate coords automatically when the admin
  // edits the address without also supplying new lat/lng.
  lastGeocodedAddress: text("last_geocoded_address"),
  notes: text("notes"),
  defaultPayRate: numeric("default_pay_rate", { precision: 10, scale: 2 }),
  defaultBillRate: numeric("default_bill_rate", { precision: 10, scale: 2 }),
  // If set, on-duty officers are expected to scan at least one patrol
  // checkpoint at this site every N minutes. The missed-checkpoint
  // scheduled job pages admins when an officer goes silent past this window.
  patrolIntervalMinutes: integer("patrol_interval_minutes"),
  // Optional per-site override (miles) for the live geofence radius. When
  // NULL, the server falls back to the global GEOFENCE_RADIUS_MILES env
  // default (≈0.25mi). Set higher for sprawling industrial parks, lower
  // for dense downtown sites. Surfaced from /sites + /sites/:id so the
  // dispatch map can draw the right circle per site, and resolved by
  // evaluateGeofence() so breach push/SMS use the same boundary the
  // dispatcher sees.
  geofenceRadiusMiles: numeric("geofence_radius_miles", { precision: 5, scale: 3 }),
  // Slugs of training_certifications.type that any officer working a
  // shift at this site must hold (unexpired). Empty/null = no extra
  // training requirements beyond the shift's `requiredLicenseLevel`.
  requiredTrainings: jsonb("required_trainings").$type<string[]>(),
  // When false, the auto-clock-out scheduled job skips officers at this site.
  // Useful for sites where officers routinely work past their scheduled end
  // time (e.g. events, extended-duration details) and manual clock-out is
  // preferred. Defaults to true (global behavior unchanged).
  autoClockOutEnabled: boolean("auto_clock_out_enabled").notNull().default(true),
  // When true, an officer with an ACCEPTED shift assignment at this site is
  // automatically clocked in — no manual tap — once their shift has started
  // and the app detects them inside the geofence while in the foreground
  // (app open/opened; there is no background location tracking). Defaults to
  // false: unlike auto-clock-out (which only ever closes a record the officer
  // already opened), this creates a new time entry / payroll record without
  // an explicit action, so sites must opt in.
  autoClockInEnabled: boolean("auto_clock_in_enabled").notNull().default(false),
  // Per-site invoice processing fee. Every site starts disabled; when it is
  // enabled, this rate (%) is applied to invoices generated for this site.
  // The fee fields written on an invoice are a historical snapshot, so later
  // changes here never silently alter settled records.
  processingFeeEnabled: boolean("processing_fee_enabled").notNull().default(false),
  processingFeeRate: numeric("processing_fee_rate", { precision: 5, scale: 4 }).notNull().default("8.25"),
  // Idempotency key for the weekly time-entry approval reminder. Stores the
  // UTC-Monday ISO date (e.g. "2026-07-21") of the last pay week for which a
  // reminder was sent to this site's managers. The job skips any site whose
  // stored key matches the current week's Monday so the reminder fires at most
  // once per site per pay week even if the job ticks multiple times on Friday.
  teApprovalReminderWeek: text("te_approval_reminder_week"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (t) => ({
  // Backs the admin grid's default sort (createdAt desc) + id tiebreaker.
  createdIdx: index("sites_created_idx").on(t.createdAt, t.id),
}));

export const insertSiteSchema = createInsertSchema(sitesTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertSite = z.infer<typeof insertSiteSchema>;
export type Site = typeof sitesTable.$inferSelect;
