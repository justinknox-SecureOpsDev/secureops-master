import { Router, type IRouter } from "express";
import { eq, and, desc, sql } from "drizzle-orm";
import {
  db,
  licenseRenewalRequestsTable,
  licensesTable,
  usersTable,
  employeesTable,
} from "@workspace/db";
import { requireAuth, requireAdmin } from "../middlewares/auth";

const router: IRouter = Router();

async function pushSafely(userIds: string[], title: string, body: string, data?: Record<string, unknown>) {
  try {
    const { sendPushToUsers } = await import("../lib/push");
    await sendPushToUsers(userIds, { title, body, data });
  } catch {
    // best-effort; push outage must never break the API path
  }
}

function isIsoDate(v: unknown): v is string {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  // Real calendar date: parsing and re-formatting must round-trip.
  const [y, m, d] = v.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

// ---------- Officer: submit a renewal ----------
router.post("/me/license-renewals", requireAuth, async (req, res): Promise<void> => {
  const me = req.user!.userId;
  const {
    licenseId, licenseType, licenseLevel, licenseNumber,
    issuingAuthority, issueDate, expiryDate, docKey, notes,
  } = req.body ?? {};

  if (!licenseType || !licenseNumber || !expiryDate || !docKey) {
    res.status(400).json({
      error: "Bad Request",
      message: "licenseType, licenseNumber, expiryDate, docKey are required",
    });
    return;
  }
  if (!isIsoDate(expiryDate) || (issueDate != null && issueDate !== "" && !isIsoDate(issueDate))) {
    res.status(400).json({ error: "Bad Request", message: "Dates must be a valid calendar date in YYYY-MM-DD format" });
    return;
  }
  if (issueDate && expiryDate <= issueDate) {
    res.status(400).json({ error: "Bad Request", message: "Expiry date must be after issue date" });
    return;
  }
  // Renewal must extend coverage: new expiry should not be in the past.
  const today = new Date().toISOString().slice(0, 10);
  if (expiryDate < today) {
    res.status(400).json({ error: "Bad Request", message: "New expiry date cannot be in the past" });
    return;
  }
  // Photo of the new license must live under the caller's own upload prefix.
  if (typeof docKey !== "string" || !docKey.startsWith(`/objects/uploads/u/${me}/`)) {
    res.status(400).json({ error: "Bad Request", message: "docKey must be your own uploaded object" });
    return;
  }
  const lvl = licenseLevel != null && [2, 3, 4].includes(Number(licenseLevel)) ? Number(licenseLevel) : null;

  // If renewing an existing license, it must belong to the caller.
  if (licenseId) {
    const [existing] = await db
      .select({ employeeId: licensesTable.employeeId })
      .from(licensesTable)
      .where(eq(licensesTable.id, String(licenseId)));
    if (!existing || existing.employeeId !== me) {
      res.status(404).json({ error: "Not Found", message: "License not found" });
      return;
    }
  }

  // Duplicate-submission guard. The non-transactional pre-check is a
  // UX nicety (returns a clean 409) but the authoritative guard is the
  // partial unique index `license_renewal_one_pending_per_license_idx`
  // — concurrent submits surface as a Postgres unique_violation that we
  // translate to 409 below.
  if (licenseId) {
    const dup = await db
      .select({ id: licenseRenewalRequestsTable.id })
      .from(licenseRenewalRequestsTable)
      .where(and(
        eq(licenseRenewalRequestsTable.employeeId, me),
        eq(licenseRenewalRequestsTable.status, "pending"),
        eq(licenseRenewalRequestsTable.licenseId, String(licenseId)),
      ));
    if (dup.length > 0) {
      res.status(409).json({ error: "Conflict", message: "You already have a pending renewal for this license" });
      return;
    }
  }

  let created;
  try {
    [created] = await db.insert(licenseRenewalRequestsTable).values({
      employeeId: me,
      licenseId: licenseId ? String(licenseId) : null,
      licenseType: String(licenseType),
      licenseLevel: lvl,
      licenseNumber: String(licenseNumber),
      issuingAuthority: issuingAuthority ? String(issuingAuthority) : null,
      issueDate: issueDate ? String(issueDate) : null,
      expiryDate: String(expiryDate),
      docKey: String(docKey),
      notes: notes ? String(notes) : null,
    }).returning();
  } catch (err: unknown) {
    const code = (err as { code?: string })?.code;
    if (code === "23505") {
      res.status(409).json({ error: "Conflict", message: "You already have a pending renewal for this license" });
      return;
    }
    throw err;
  }

  // Fan out to admins so they review promptly.
  const admins = await db.select({ id: usersTable.id }).from(usersTable).where(eq(usersTable.role, "admin"));
  void pushSafely(
    admins.map((a) => a.id),
    "License renewal submitted",
    "An officer has submitted a license renewal for review.",
    { kind: "license_renewal", id: created.id },
  );

  res.status(201).json(created);
});

// ---------- Officer: my renewal history ----------
router.get("/me/license-renewals", requireAuth, async (req, res): Promise<void> => {
  const rows = await db
    .select()
    .from(licenseRenewalRequestsTable)
    .where(eq(licenseRenewalRequestsTable.employeeId, req.user!.userId))
    .orderBy(desc(licenseRenewalRequestsTable.createdAt));
  res.json(rows);
});

// ---------- Admin: list renewals ----------
router.get("/admin/license-renewals", requireAdmin, async (req, res): Promise<void> => {
  const status = typeof req.query.status === "string" ? req.query.status : undefined;
  const conditions = status ? [eq(licenseRenewalRequestsTable.status, status)] : [];
  const rows = await db
    .select({
      id: licenseRenewalRequestsTable.id,
      employeeId: licenseRenewalRequestsTable.employeeId,
      licenseId: licenseRenewalRequestsTable.licenseId,
      licenseType: licenseRenewalRequestsTable.licenseType,
      licenseLevel: licenseRenewalRequestsTable.licenseLevel,
      licenseNumber: licenseRenewalRequestsTable.licenseNumber,
      issuingAuthority: licenseRenewalRequestsTable.issuingAuthority,
      issueDate: licenseRenewalRequestsTable.issueDate,
      expiryDate: licenseRenewalRequestsTable.expiryDate,
      docKey: licenseRenewalRequestsTable.docKey,
      notes: licenseRenewalRequestsTable.notes,
      status: licenseRenewalRequestsTable.status,
      decisionNote: licenseRenewalRequestsTable.decisionNote,
      decidedAt: licenseRenewalRequestsTable.decidedAt,
      createdAt: licenseRenewalRequestsTable.createdAt,
      employeeFirstName: usersTable.firstName,
      employeeLastName: usersTable.lastName,
      employeeEmail: usersTable.email,
    })
    .from(licenseRenewalRequestsTable)
    .leftJoin(usersTable, eq(licenseRenewalRequestsTable.employeeId, usersTable.id))
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(
      // Pending first, then newest first.
      sql`CASE WHEN ${licenseRenewalRequestsTable.status} = 'pending' THEN 0 ELSE 1 END`,
      desc(licenseRenewalRequestsTable.createdAt),
    );
  res.json(rows);
});

// ---------- Admin: approve ----------
router.post("/admin/license-renewals/:id/approve", requireAdmin, async (req, res): Promise<void> => {
  const adminId = req.user!.userId;
  const id = String(req.params.id);
  const { decisionNote } = (req.body ?? {}) as { decisionNote?: string };

  const result = await db.transaction(async (tx) => {
    const [renewal] = await tx
      .select()
      .from(licenseRenewalRequestsTable)
      .where(eq(licenseRenewalRequestsTable.id, id))
      .for("update");
    if (!renewal) return { code: 404 as const, body: { error: "Not Found", message: "Renewal not found" } };
    if (renewal.status !== "pending")
      return { code: 409 as const, body: { error: "Conflict", message: `Cannot approve ${renewal.status} renewal` } };

    let licenseId = renewal.licenseId;
    if (licenseId) {
      // Update existing license row.
      const [updated] = await tx
        .update(licensesTable)
        .set({
          type: renewal.licenseType,
          level: renewal.licenseLevel,
          licenseNumber: renewal.licenseNumber,
          issuingAuthority: renewal.issuingAuthority,
          issueDate: renewal.issueDate,
          expiryDate: renewal.expiryDate,
          // Carry the renewed card photo onto the license record.
          docKey: renewal.docKey,
          // Clear reminder bookkeeping so the new expiry gets a fresh
          // 30/14/7 reminder cycle.
          lastReminderTier: null,
          lastReminderSentAt: null,
          lastReminderForExpiry: null,
        })
        .where(eq(licensesTable.id, licenseId))
        .returning({ id: licensesTable.id });
      if (!updated)
        return { code: 410 as const, body: { error: "Gone", message: "Underlying license no longer exists" } };
    } else {
      const [inserted] = await tx
        .insert(licensesTable)
        .values({
          employeeId: renewal.employeeId,
          type: renewal.licenseType,
          level: renewal.licenseLevel,
          licenseNumber: renewal.licenseNumber,
          issuingAuthority: renewal.issuingAuthority,
          issueDate: renewal.issueDate,
          expiryDate: renewal.expiryDate,
          docKey: renewal.docKey,
        })
        .returning({ id: licensesTable.id });
      licenseId = inserted.id;
    }

    const [updatedRenewal] = await tx
      .update(licenseRenewalRequestsTable)
      .set({
        status: "approved",
        decisionNote: decisionNote ? String(decisionNote) : null,
        decidedAt: new Date(),
        adminReviewerId: adminId,
        licenseId,
      })
      .where(eq(licenseRenewalRequestsTable.id, id))
      .returning();

    // Mirror the approved license onto the officer's profile summary so the
    // admin OfficerProfile (and the profile PDF) shows the renewed level,
    // number, expiry and card photo — not stale onboarding-time values.
    await tx
      .update(employeesTable)
      .set({
        siaLicenseLevel: renewal.licenseLevel,
        siaLicenseNumber: renewal.licenseNumber,
        siaLicenseExpiry: renewal.expiryDate,
        licenseDocKey: renewal.docKey,
      })
      .where(eq(employeesTable.userId, renewal.employeeId));

    return { code: 200 as const, body: updatedRenewal, employeeId: renewal.employeeId };
  });

  res.status(result.code).json(result.body);
  if (result.code === 200 && "employeeId" in result) {
    void pushSafely(
      [result.employeeId],
      "License renewal approved",
      "Your license renewal has been approved.",
      { kind: "license_renewal_approved", id },
    );
  }
});

// ---------- Admin: reject ----------
router.post("/admin/license-renewals/:id/reject", requireAdmin, async (req, res): Promise<void> => {
  const adminId = req.user!.userId;
  const id = String(req.params.id);
  const { decisionNote } = (req.body ?? {}) as { decisionNote?: string };
  if (!decisionNote || !String(decisionNote).trim()) {
    res.status(400).json({ error: "Bad Request", message: "decisionNote is required when rejecting" });
    return;
  }

  // Single atomic conditional update — only flips pending → rejected.
  // If another admin has approved or rejected concurrently the WHERE
  // clause matches zero rows and we return 409 instead of clobbering
  // the existing terminal state.
  const updatedRows = await db
    .update(licenseRenewalRequestsTable)
    .set({
      status: "rejected",
      decisionNote: String(decisionNote).trim(),
      decidedAt: new Date(),
      adminReviewerId: adminId,
    })
    .where(and(
      eq(licenseRenewalRequestsTable.id, id),
      eq(licenseRenewalRequestsTable.status, "pending"),
    ))
    .returning();

  if (updatedRows.length === 0) {
    const [existing] = await db
      .select({ status: licenseRenewalRequestsTable.status })
      .from(licenseRenewalRequestsTable)
      .where(eq(licenseRenewalRequestsTable.id, id));
    if (!existing) { res.status(404).json({ error: "Not Found", message: "Renewal not found" }); return; }
    res.status(409).json({ error: "Conflict", message: `Cannot reject ${existing.status} renewal` });
    return;
  }

  const updated = updatedRows[0];
  res.json(updated);
  void pushSafely(
    [updated.employeeId],
    "License renewal needs attention",
    "Your license renewal was not approved. Tap to see why.",
    { kind: "license_renewal_rejected", id },
  );
});

export default router;
