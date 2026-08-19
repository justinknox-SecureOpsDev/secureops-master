/**
 * Custom-role permission matrix admin surface.
 *
 * Access: `requireAdmin` (any admin, not just owners — this is a
 * configuration surface for role capabilities, orthogonal to the
 * owner-only financial-dashboard flag). Toggling takes effect immediately
 * via the in-memory cache in lib/permissions.ts — no redeploy.
 *
 * Guardrail: the `admin` role can NEVER be removed from any key's
 * allowed-roles list, so a mis-click can never lock every admin out of the
 * system that manages this very page.
 */

import { Router, type IRouter } from "express";
import { eq, sql } from "drizzle-orm";
import { z } from "zod/v4";
import { db, permissionOverridesTable } from "@workspace/db";
import { requireAdmin } from "../middlewares/auth";
import {
  ASSIGNABLE_ROLES,
  PERMISSION_KEYS,
  getPermissionKeyDef,
  getPermissionDetails,
  loadPermissionOverridesFromDb,
  setPermissionOverrideInMemory,
  clearPermissionOverrideInMemory,
  type PermissionKey,
} from "../lib/permissions";

const router: IRouter = Router();

router.get("/admin/permissions", requireAdmin, (_req, res): void => {
  res.json({ permissions: getPermissionDetails(), assignableRoles: ASSIGNABLE_ROLES });
});

const updateBody = z.object({
  // null resets the key back to its default-allowed-roles.
  allowedRoles: z.array(z.enum(ASSIGNABLE_ROLES)).nullable(),
});

router.patch("/admin/permissions/:key", requireAdmin, async (req, res): Promise<void> => {
  const key = req.params.key as PermissionKey;
  const def = getPermissionKeyDef(key);
  if (!def || !(PERMISSION_KEYS as readonly string[]).includes(key)) {
    res.status(404).json({ error: "Not Found", message: "Unknown permission key" });
    return;
  }
  const parsed = updateBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Bad Request", issues: parsed.error.issues });
    return;
  }

  const beforeDetails = getPermissionDetails().find((d) => d.key === key);
  const editor = req.user?.email ?? "unknown";

  if (parsed.data.allowedRoles === null) {
    await db.delete(permissionOverridesTable).where(eq(permissionOverridesTable.key, key));
    clearPermissionOverrideInMemory(key);
  } else {
    // The admin role must always retain access — otherwise a toggle could
    // lock every admin out of the very page that controls this matrix.
    const allowedRoles = Array.from(new Set([...parsed.data.allowedRoles, "admin"]));
    await db
      .insert(permissionOverridesTable)
      .values({ key, allowedRoles, updatedBy: editor })
      .onConflictDoUpdate({
        target: permissionOverridesTable.key,
        set: { allowedRoles, updatedBy: editor, updatedAt: sql`now()` },
      });
    setPermissionOverrideInMemory(key, allowedRoles);
  }

  // Reload from DB to stay consistent if another instance also wrote.
  await loadPermissionOverridesFromDb();
  const afterDetails = getPermissionDetails().find((d) => d.key === key);

  res.locals["auditMetadata"] = {
    settingsChange: "permissions",
    changes: [
      {
        field: key,
        label: def.label,
        kind: "text",
        old: (beforeDetails?.allowedRoles ?? []).join(", "),
        new: (afterDetails?.allowedRoles ?? []).join(", "),
      },
    ],
  };

  res.json({ permission: afterDetails });
});

export default router;
