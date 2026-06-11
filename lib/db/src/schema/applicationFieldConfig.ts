import { pgTable, text, uuid, timestamp, integer, boolean, uniqueIndex } from "drizzle-orm/pg-core";

/**
 * Admin overrides for the *built-in* (hardcoded) public application fields.
 *
 * The set of built-in fields and their defaults (label, help text, section,
 * default required/sort, locked-ness) live in code — see
 * `artifacts/api-server/src/lib/applicationFields.ts`. This table only stores
 * the per-field *overrides* an admin applies through the form builder:
 *   - rename label / help text,
 *   - flip required ↔ optional,
 *   - hide / show,
 *   - reorder within a section.
 *
 * A missing row means "use the registry defaults". Null override columns mean
 * "no override for this attribute". The five locked core fields
 * (firstName, lastName, email, phone, address) only honour a label override;
 * required/hidden are forced server-side regardless of what's stored here.
 */
export const applicationFieldConfigTable = pgTable(
  "application_field_config",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    fieldKey: text("field_key").notNull(),
    labelOverride: text("label_override"),
    helpTextOverride: text("help_text_override"),
    requiredOverride: boolean("required_override"),
    hidden: boolean("hidden").notNull().default(false),
    sortOrder: integer("sort_order"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => ({
    fieldKeyIdx: uniqueIndex("application_field_config_field_key_idx").on(t.fieldKey),
  }),
);

export type ApplicationFieldConfig = typeof applicationFieldConfigTable.$inferSelect;
