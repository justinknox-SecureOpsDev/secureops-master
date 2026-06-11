import { pgTable, text, uuid, timestamp, integer, boolean, jsonb, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

/**
 * Admin-defined custom questions appended to the public officer application.
 * The legally-required built-in fields (I-9, SSN, license, references,
 * availability) stay hardcoded because the approval pipeline maps them to
 * structured columns; these rows are additive and answered into
 * `applications.custom_answers`.
 *
 * fieldType: short_text | long_text | number | date | select | multiselect | yes_no
 *   - select / multiselect read their choices from `options` (string[])
 */
export const applicationQuestionsTable = pgTable(
  "application_questions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    label: text("label").notNull(),
    helpText: text("help_text"),
    fieldType: text("field_type").notNull(),
    required: boolean("required").notNull().default(false),
    options: jsonb("options").$type<string[]>(),
    sortOrder: integer("sort_order").notNull().default(0),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => ({
    sortIdx: index("application_questions_sort_idx").on(t.sortOrder, t.id),
  }),
);

export const insertApplicationQuestionSchema = createInsertSchema(applicationQuestionsTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertApplicationQuestion = z.infer<typeof insertApplicationQuestionSchema>;
export type ApplicationQuestion = typeof applicationQuestionsTable.$inferSelect;
