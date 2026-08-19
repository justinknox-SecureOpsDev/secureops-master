import { pgTable, text, jsonb, timestamp } from "drizzle-orm/pg-core";

/**
 * Per-role permission-matrix overrides, managed via the admin Permissions
 * page (artifacts/api-server/src/routes/permissions.ts).
 *
 * Mirrors the shape of `feature_flags` / `platform_feature_overrides`: one
 * row per canonical permission key (see @workspace/permission-keys). A row
 * present here means an admin has explicitly set the effective allowed-roles
 * list for that key; a key with no row falls back to its
 * `defaultAllowedRoles` (which reproduces today's hardcoded role behavior).
 *
 * This is a SEPARATE concept from feature flags: features gate whole
 * product surfaces per deployment, permissions gate which roles may use a
 * module/action within a deployment.
 */
export const permissionOverridesTable = pgTable("permission_overrides", {
  key: text("key").primaryKey(),
  // Effective allowed-role list for this key. Always includes "admin" —
  // enforced at the route layer so a mis-click can never lock every admin
  // out of the system.
  allowedRoles: jsonb("allowed_roles").$type<string[]>().notNull(),
  updatedBy: text("updated_by"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export type PermissionOverride = typeof permissionOverridesTable.$inferSelect;
