/**
 * Company-owner grant/revoke admin surface.
 *
 * Access: `requireCompanyOwner` gates EVERY route here — only an existing
 * owner can view or change who else holds the flag. A regular admin who is
 * not an owner gets a 403 on both the list and the toggle, and never sees
 * the corresponding admin-portal page.
 *
 * Invariants enforced here (not just documented):
 *   - Only an existing owner may grant/revoke another user's flag
 *     (non-delegable except by an owner).
 *   - The last remaining active owner can never be revoked — a deployment
 *     can never end up with zero owners.
 *   - This can NEVER create or touch platform super-admin — this route
 *     writes exactly one column (`users.is_company_owner`) and never reads
 *     or writes `role`, SUPER_ADMIN_EMAILS, or anything platform-related.
 *   - Every change is written to the audit log with actor, target, and the
 *     before/after value.
 */

import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { z } from "zod/v4";
import { db, usersTable } from "@workspace/db";
import { requireCompanyOwner } from "../middlewares/auth";
import { countCompanyOwnersForUpdate } from "../lib/companyOwner";

const router: IRouter = Router();

router.get("/admin/company-owners", requireCompanyOwner, async (_req, res): Promise<void> => {
  const rows = await db
    .select({
      id: usersTable.id,
      email: usersTable.email,
      firstName: usersTable.firstName,
      lastName: usersTable.lastName,
      role: usersTable.role,
      status: usersTable.status,
      isCompanyOwner: usersTable.isCompanyOwner,
    })
    .from(usersTable)
    .orderBy(usersTable.firstName, usersTable.lastName);
  res.json({ users: rows, ownerCount: rows.filter((r) => r.isCompanyOwner && r.status === "active").length });
});

const setOwnerBody = z.object({ isCompanyOwner: z.boolean() });

router.patch("/admin/company-owners/:userId", requireCompanyOwner, async (req, res): Promise<void> => {
  const parsed = setOwnerBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Bad Request", issues: parsed.error.issues });
    return;
  }
  const userId = Array.isArray(req.params.userId) ? req.params.userId[0] : req.params.userId;
  const { isCompanyOwner } = parsed.data;

  // Everything that decides whether a revoke is safe, and the write itself,
  // happens inside ONE transaction with a row lock on every active owner
  // (see countCompanyOwnersForUpdate). That closes the race where two
  // concurrent revokes each observe "2 owners, safe to revoke" and leave
  // zero: the second transaction blocks on the shared lock and re-checks
  // the post-commit count before it's allowed to proceed.
  const outcome = await db.transaction(async (tx) => {
    const [target] = await tx
      .select({ id: usersTable.id, email: usersTable.email, isCompanyOwner: usersTable.isCompanyOwner, status: usersTable.status })
      .from(usersTable)
      .where(eq(usersTable.id, userId))
      .limit(1);
    if (!target) {
      return { kind: "not_found" as const };
    }

    // Revoking: never let the last remaining active owner be revoked, so a
    // deployment can never end up with zero company owners. Lock the owner
    // set BEFORE deciding, so a concurrent revoke can't slip in underneath.
    if (!isCompanyOwner && target.isCompanyOwner) {
      const ownerCount = await countCompanyOwnersForUpdate(tx);
      if (ownerCount <= 1) {
        return { kind: "last_owner" as const };
      }
    }

    if (target.isCompanyOwner === isCompanyOwner) {
      // No-op — still return the current state so the UI can reconcile.
      return { kind: "unchanged" as const, target };
    }

    const [updated] = await tx
      .update(usersTable)
      .set({ isCompanyOwner })
      .where(eq(usersTable.id, userId))
      .returning({
        id: usersTable.id,
        email: usersTable.email,
        firstName: usersTable.firstName,
        lastName: usersTable.lastName,
        role: usersTable.role,
        isCompanyOwner: usersTable.isCompanyOwner,
      });

    return { kind: "updated" as const, target, updated };
  });

  if (outcome.kind === "not_found") {
    res.status(404).json({ error: "Not Found", message: "User not found" });
    return;
  }
  if (outcome.kind === "last_owner") {
    res.status(400).json({
      error: "Bad Request",
      message: "Cannot revoke the last remaining company owner.",
    });
    return;
  }
  if (outcome.kind === "unchanged") {
    res.json({ user: outcome.target, unchanged: true });
    return;
  }

  res.locals["auditMetadata"] = {
    settingsChange: "company_owner",
    changes: [
      {
        field: "isCompanyOwner",
        label: "Company owner",
        kind: "bool",
        old: outcome.target.isCompanyOwner,
        new: isCompanyOwner,
      },
    ],
    targetUserId: userId,
    targetEmail: outcome.target.email,
  };

  res.json({ user: outcome.updated });
});

export default router;
