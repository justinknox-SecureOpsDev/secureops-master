/**
 * Custom-role permission matrix — runtime-editable "which roles may use
 * this module/action" toggles.
 *
 * This is a SEPARATE axis from:
 *   - Feature flags (lib/features.ts) — gate whole product surfaces per
 *     deployment/tier, not per-role.
 *   - The company-owner flag (see middlewares/auth.ts / lib/companyOwner.ts)
 *     — a non-role boolean that gates ONLY the aggregate financial
 *     dashboards, entirely independent of this matrix.
 *
 * Shape mirrors the feature-flag system on purpose:
 *   1. Canonical key registry — @workspace/permission-keys (single source
 *      of truth, each key ships a defaultAllowedRoles that reproduces
 *      today's hardcoded role-gate behavior exactly).
 *   2. DB override table — `permission_overrides`, one row per key.
 *   3. In-memory cache, loaded at boot and refreshed synchronously after
 *      every write, so the per-request middleware hot path stays
 *      allocation-free and toggles take effect immediately (no redeploy).
 *   4. `requirePermission(key)` — request-time enforcement middleware.
 *
 * `requirePermission` is meant to be composed alongside — never as a
 * replacement for — any per-site/ownership scope check a route already
 * performs inside its handler (e.g. canManageSite for a site manager).
 */

import type { RequestHandler } from "express";
import { db, permissionOverridesTable } from "@workspace/db";
import {
  PERMISSION_KEY_DEFS,
  PERMISSION_KEYS,
  getPermissionKeyDef,
  type PermissionKey,
} from "@workspace/permission-keys";
export { PERMISSION_KEY_DEFS, PERMISSION_KEYS, ASSIGNABLE_ROLES, getPermissionKeyDef } from "@workspace/permission-keys";
export type { PermissionKey, PermissionKeyDef, AssignableRole } from "@workspace/permission-keys";

// In-memory override cache: key -> effective allowed roles. Absent from the
// map means "use defaultAllowedRoles". Always includes "admin" once loaded
// (enforced on write in routes/permissions.ts) so a bad toggle can never
// lock every admin out.
const overrides: Map<PermissionKey, string[]> = new Map();

export function getEffectiveAllowedRoles(key: PermissionKey): readonly string[] {
  const override = overrides.get(key);
  if (override) return override;
  return getPermissionKeyDef(key)?.defaultAllowedRoles ?? [];
}

export function isRoleAllowed(key: PermissionKey, role: string | undefined): boolean {
  if (!role) return false;
  // The admin role is always implicitly allowed, independent of the stored
  // matrix — belt-and-suspenders alongside the write-time guard, so even a
  // row written before that guard existed can never lock admins out.
  if (role === "admin") return true;
  return getEffectiveAllowedRoles(key).includes(role);
}

export function getPermissionDetails(): Array<{
  key: PermissionKey;
  area: string;
  areaLabel: string;
  label: string;
  description: string;
  defaultAllowedRoles: readonly string[];
  allowedRoles: readonly string[];
  isOverridden: boolean;
}> {
  return PERMISSION_KEY_DEFS.map((d) => {
    const override = overrides.get(d.key);
    return {
      key: d.key,
      area: d.area,
      areaLabel: d.areaLabel,
      label: d.label,
      description: d.description,
      defaultAllowedRoles: d.defaultAllowedRoles,
      allowedRoles: override ?? d.defaultAllowedRoles,
      isOverridden: !!override,
    };
  });
}

export async function loadPermissionOverridesFromDb(): Promise<void> {
  try {
    const rows = await db.select().from(permissionOverridesTable);
    overrides.clear();
    for (const row of rows) {
      if ((PERMISSION_KEYS as readonly string[]).includes(row.key)) {
        overrides.set(row.key as PermissionKey, row.allowedRoles);
      }
    }
  } catch {
    // Table might not exist on first boot before `db push` — leave overrides empty.
  }
}

export function setPermissionOverrideInMemory(key: PermissionKey, allowedRoles: string[]): void {
  overrides.set(key, allowedRoles);
}

export function clearPermissionOverrideInMemory(key: PermissionKey): void {
  overrides.delete(key);
}

/**
 * Express middleware: 403 if the caller's live role is not in the effective
 * allowed-roles list for `key`. Re-checks the in-memory cache on every
 * request so admin toggles take effect immediately. Must run AFTER an auth
 * middleware that populates `req.user` (requireAuth or one of its role
 * wrappers) — it does not authenticate on its own.
 */
export function requirePermission(key: PermissionKey): RequestHandler {
  return (req, res, next) => {
    if (!req.user) {
      res.status(401).json({ error: "Unauthorized", message: "No token provided" });
      return;
    }
    if (!isRoleAllowed(key, req.user.role)) {
      res.status(403).json({
        error: "Forbidden",
        message: `Your role does not have the '${key}' permission.`,
        permission: key,
      });
      return;
    }
    next();
  };
}
