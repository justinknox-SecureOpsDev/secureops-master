import { pgTable, text, uuid, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { usersTable } from "./users";

/**
 * Per-user dismissals of an assistant adoption/efficiency finding.
 *
 * Findings themselves are NOT stored — they are recomputed from live data by
 * the fixed signal catalog on every read (see
 * artifacts/api-server/src/lib/assistant/signals.ts), so a finding disappears
 * on its own the moment its underlying condition is resolved. This table only
 * records "this person said not now", which is the one piece of state that
 * cannot be derived from the operational data.
 *
 * `resurfaceAfter` is a soft snooze: once that instant passes the finding is
 * eligible to appear again (a still-unresolved money leak should not stay
 * hidden forever because it was waved away once). A NULL means "never
 * resurface" — reserved for a deliberate permanent dismissal.
 */
export const assistantSuggestionDismissalsTable = pgTable("assistant_suggestion_dismissals", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  /** Stable finding id from the signal catalog, e.g. "site_bill_rate_missing". */
  findingId: text("finding_id").notNull(),
  dismissedAt: timestamp("dismissed_at", { withTimezone: true }).notNull().defaultNow(),
  /** NULL = dismissed permanently; otherwise the finding may reappear after this instant. */
  resurfaceAfter: timestamp("resurface_after", { withTimezone: true }),
}, (t) => ({
  // One row per (user, finding) — dismissing again updates the snooze window
  // rather than piling up history.
  userFindingIdx: uniqueIndex("assistant_dismissal_user_finding_idx").on(t.userId, t.findingId),
}));

export const insertAssistantSuggestionDismissalSchema = createInsertSchema(
  assistantSuggestionDismissalsTable,
).omit({ id: true, dismissedAt: true });
export type InsertAssistantSuggestionDismissal = z.infer<typeof insertAssistantSuggestionDismissalSchema>;
export type AssistantSuggestionDismissal = typeof assistantSuggestionDismissalsTable.$inferSelect;
