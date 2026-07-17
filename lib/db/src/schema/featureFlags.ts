import { pgTable, text, boolean, jsonb, timestamp } from "drizzle-orm/pg-core";

/**
 * Feature flag overrides, managed via the control-plane API.
 *
 * Each row is a named flag that the operator has explicitly set.
 * Flags absent from this table are "not configured" — callers apply their
 * own defaults. The control plane may clear a flag (delete the row) to
 * revert to the application default.
 */
export const featureFlagsTable = pgTable("feature_flags", {
  key:         text("key").primaryKey(),
  enabled:     boolean("enabled").notNull(),
  payload:     jsonb("payload").$type<Record<string, unknown>>(),
  description: text("description"),
  updatedAt:   timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export type FeatureFlag = typeof featureFlagsTable.$inferSelect;
