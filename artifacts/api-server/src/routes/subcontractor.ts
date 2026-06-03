import { Router, type IRouter } from "express";
import { randomBytes } from "crypto";
import { eq, and, gte, lte, isNull, sql } from "drizzle-orm";
import {
  db,
  subcontractorQrTokensTable,
  subcontractorTimeEntriesTable,
  sitesTable,
  auditLogsTable,
} from "@workspace/db";
import { requireAdmin } from "../middlewares/auth";
import { tokenLookupLimiter } from "../middlewares/rateLimit";
import { logger } from "../lib/logger";
import { upsertWeeklyInvoiceForSubcontractorEntry } from "../lib/invoiceSync";

async function writeAuditLog(opts: {
  actorUserId: string | null;
  actorEmail: string | null;
  actorRole: string | null;
  action: string;
  metadata: Record<string, unknown>;
}): Promise<void> {
  try {
    await db.insert(auditLogsTable).values({
      actorUserId: opts.actorUserId,
      actorEmail: opts.actorEmail,
      actorRole: opts.actorRole,
      action: opts.action,
      method: "POST",
      path: `/subcontractor/${opts.action}`,
      statusCode: 200,
      metadata: opts.metadata,
    });
  } catch (err) {
    logger.warn({ err }, "[subcontractor] failed to write audit log");
  }
}

const router: IRouter = Router();

function genToken(): string {
  return randomBytes(32).toString("base64url");
}

function calcHours(clockIn: Date, clockOut: Date): number {
  return Math.round(((clockOut.getTime() - clockIn.getTime()) / 3600000) * 100) / 100;
}

function buildClockUrl(req: import("express").Request, token: string): string {
  const baseUrl = process.env.APP_BASE_URL
    ?? (process.env.REPLIT_DOMAINS ? `https://${process.env.REPLIT_DOMAINS.split(",")[0]!.trim()}` : null)
    ?? `${req.protocol}://${req.get("host")}`;
  return `${baseUrl}/admin-portal/subcontractor/clock/${encodeURIComponent(token)}`;
}

// ---------------------------------------------------------------------------
// Admin: get the existing subcontractor QR token for a site (if any)
// GET /admin/sites/:siteId/subcontractor-qr
// ---------------------------------------------------------------------------
router.get("/admin/sites/:siteId/subcontractor-qr", requireAdmin, async (req, res): Promise<void> => {
  const { siteId } = req.params as { siteId: string };

  const [site] = await db.select({ name: sitesTable.name }).from(sitesTable).where(eq(sitesTable.id, siteId));
  if (!site) {
    res.status(404).json({ error: "Not Found", message: "Site not found" });
    return;
  }

  const [row] = await db
    .select()
    .from(subcontractorQrTokensTable)
    .where(and(
      eq(subcontractorQrTokensTable.siteId, siteId),
      isNull(subcontractorQrTokensTable.revokedAt),
    ));

  if (!row) {
    res.json({ exists: false, siteName: site.name });
    return;
  }

  res.json({
    exists: true,
    id: row.id,
    token: row.token,
    clockUrl: buildClockUrl(req, row.token),
    siteName: site.name,
    createdAt: row.createdAt.toISOString(),
  });
});

// ---------------------------------------------------------------------------
// Admin: generate (or rotate) the subcontractor QR token for a site
// POST /admin/sites/:siteId/subcontractor-qr
// ---------------------------------------------------------------------------
router.post("/admin/sites/:siteId/subcontractor-qr", requireAdmin, async (req, res): Promise<void> => {
  const { siteId } = req.params as { siteId: string };
  const rotate = Boolean((req.body ?? {}).rotate);

  const [site] = await db.select({ name: sitesTable.name }).from(sitesTable).where(eq(sitesTable.id, siteId));
  if (!site) {
    res.status(404).json({ error: "Not Found", message: "Site not found" });
    return;
  }

  const [existing] = await db
    .select()
    .from(subcontractorQrTokensTable)
    .where(and(
      eq(subcontractorQrTokensTable.siteId, siteId),
      isNull(subcontractorQrTokensTable.revokedAt),
    ));

  let row = existing;
  if (existing && rotate) {
    const [updated] = await db
      .update(subcontractorQrTokensTable)
      .set({ token: genToken(), createdByAdminId: req.user!.userId, createdAt: new Date() })
      .where(eq(subcontractorQrTokensTable.id, existing.id))
      .returning();
    row = updated!;
  } else if (!existing) {
    const [inserted] = await db.insert(subcontractorQrTokensTable).values({
      siteId,
      token: genToken(),
      createdByAdminId: req.user!.userId,
    }).returning();
    row = inserted!;
  }

  res.json({
    id: row!.id,
    token: row!.token,
    clockUrl: buildClockUrl(req, row!.token),
    siteName: site.name,
    createdAt: row!.createdAt.toISOString(),
  });
});

// ---------------------------------------------------------------------------
// Admin: list subcontractor time entries (filter by siteId / dateFrom / dateTo)
// GET /admin/subcontractor-entries
// ---------------------------------------------------------------------------
router.get("/admin/subcontractor-entries", requireAdmin, async (req, res): Promise<void> => {
  const { siteId, dateFrom, dateTo } = req.query as Record<string, string | undefined>;

  const conditions = [];
  if (siteId) conditions.push(eq(subcontractorTimeEntriesTable.siteId, siteId));
  if (dateFrom) conditions.push(gte(subcontractorTimeEntriesTable.clockInAt, new Date(dateFrom)));
  if (dateTo) conditions.push(lte(subcontractorTimeEntriesTable.clockInAt, new Date(dateTo)));

  const rows = await db
    .select({
      id: subcontractorTimeEntriesTable.id,
      siteId: subcontractorTimeEntriesTable.siteId,
      name: subcontractorTimeEntriesTable.name,
      company: subcontractorTimeEntriesTable.company,
      badgeId: subcontractorTimeEntriesTable.badgeId,
      clockInAt: subcontractorTimeEntriesTable.clockInAt,
      clockOutAt: subcontractorTimeEntriesTable.clockOutAt,
      hoursWorked: subcontractorTimeEntriesTable.hoursWorked,
      notes: subcontractorTimeEntriesTable.notes,
      createdAt: subcontractorTimeEntriesTable.createdAt,
      siteName: sitesTable.name,
    })
    .from(subcontractorTimeEntriesTable)
    .leftJoin(sitesTable, eq(subcontractorTimeEntriesTable.siteId, sitesTable.id))
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(subcontractorTimeEntriesTable.clockInAt);

  res.json(rows);
});

// ---------------------------------------------------------------------------
// Admin: force clock-out a stuck subcontractor entry
// PATCH /admin/subcontractor-entries/:id/clock-out
// ---------------------------------------------------------------------------
router.patch("/admin/subcontractor-entries/:id/clock-out", requireAdmin, async (req, res): Promise<void> => {
  const { id } = req.params as { id: string };
  const { clockOutAt, notes } = req.body ?? {};

  const [existing] = await db.select().from(subcontractorTimeEntriesTable).where(eq(subcontractorTimeEntriesTable.id, id));
  if (!existing) { res.status(404).json({ error: "Not Found" }); return; }
  if (existing.clockOutAt) {
    res.status(409).json({ error: "Conflict", message: "Entry already has a clock-out time." });
    return;
  }

  let targetClockOut: Date;
  if (clockOutAt) {
    const parsed = new Date(clockOutAt as string);
    if (isNaN(parsed.getTime())) {
      res.status(400).json({ error: "Bad Request", message: "clockOutAt must be a valid ISO timestamp." });
      return;
    }
    targetClockOut = parsed;
  } else {
    targetClockOut = new Date();
  }

  if (targetClockOut.getTime() <= existing.clockInAt.getTime()) {
    res.status(400).json({ error: "Bad Request", message: "Clock-out must be after clock-in." });
    return;
  }

  const hours = calcHours(existing.clockInAt, targetClockOut);

  const [updated] = await db.update(subcontractorTimeEntriesTable).set({
    clockOutAt: targetClockOut,
    hoursWorked: String(hours),
    notes: notes ?? existing.notes,
  }).where(eq(subcontractorTimeEntriesTable.id, id)).returning();

  void writeAuditLog({
    actorUserId: req.user!.userId,
    actorEmail: req.user!.email,
    actorRole: req.user!.role,
    action: "subcontractor_clock_out",
    metadata: {
      entryId: existing.id,
      name: existing.name,
      company: existing.company,
      siteId: existing.siteId,
      adminForceClockOut: true,
    },
  });

  // Roll the now-closed entry into this site's weekly draft invoice
  // (best-effort, mirrors the officer time-entry approval hook).
  void upsertWeeklyInvoiceForSubcontractorEntry(updated!);

  const [site] = await db.select({ name: sitesTable.name }).from(sitesTable).where(eq(sitesTable.id, existing.siteId));

  res.json({ ...updated, siteName: site?.name ?? null });
});

// ---------------------------------------------------------------------------
// Admin: edit / correct a subcontractor time entry
// PATCH /admin/subcontractor-entries/:id
//   Editable fields: name, company, badgeId, clockInAt, clockOutAt, notes.
//   Recomputes hoursWorked; rejects clock-out before clock-in.
// ---------------------------------------------------------------------------
router.patch("/admin/subcontractor-entries/:id", requireAdmin, async (req, res): Promise<void> => {
  const { id } = req.params as { id: string };
  const body = (req.body ?? {}) as Record<string, unknown>;

  const [existing] = await db.select().from(subcontractorTimeEntriesTable).where(eq(subcontractorTimeEntriesTable.id, id));
  if (!existing) { res.status(404).json({ error: "Not Found" }); return; }

  const updates: {
    name?: string;
    company?: string;
    badgeId?: string | null;
    clockInAt?: Date;
    clockOutAt?: Date | null;
    notes?: string | null;
  } = {};

  if (body.name !== undefined) {
    if (typeof body.name !== "string" || !body.name.trim()) {
      res.status(400).json({ error: "Bad Request", message: "name must be a non-empty string." });
      return;
    }
    updates.name = body.name.trim();
  }

  if (body.company !== undefined) {
    if (typeof body.company !== "string" || !body.company.trim()) {
      res.status(400).json({ error: "Bad Request", message: "company must be a non-empty string." });
      return;
    }
    updates.company = body.company.trim();
  }

  if (body.badgeId !== undefined) {
    if (body.badgeId === null) {
      updates.badgeId = null;
    } else if (typeof body.badgeId === "string") {
      updates.badgeId = body.badgeId.trim() ? body.badgeId.trim() : null;
    } else {
      res.status(400).json({ error: "Bad Request", message: "badgeId must be a string or null." });
      return;
    }
  }

  if (body.notes !== undefined) {
    if (body.notes === null) {
      updates.notes = null;
    } else if (typeof body.notes === "string") {
      updates.notes = body.notes.trim() ? body.notes.trim() : null;
    } else {
      res.status(400).json({ error: "Bad Request", message: "notes must be a string or null." });
      return;
    }
  }

  if (body.clockInAt !== undefined) {
    const parsed = new Date(body.clockInAt as string);
    if (isNaN(parsed.getTime())) {
      res.status(400).json({ error: "Bad Request", message: "clockInAt must be a valid ISO timestamp." });
      return;
    }
    updates.clockInAt = parsed;
  }

  if (body.clockOutAt !== undefined) {
    if (body.clockOutAt === null) {
      updates.clockOutAt = null;
    } else {
      const parsed = new Date(body.clockOutAt as string);
      if (isNaN(parsed.getTime())) {
        res.status(400).json({ error: "Bad Request", message: "clockOutAt must be a valid ISO timestamp." });
        return;
      }
      updates.clockOutAt = parsed;
    }
  }

  // Resolve the effective clock-in / clock-out after applying edits.
  const effectiveClockIn = updates.clockInAt ?? existing.clockInAt;
  const effectiveClockOut = body.clockOutAt !== undefined ? updates.clockOutAt! : existing.clockOutAt;

  if (effectiveClockOut && effectiveClockOut.getTime() <= effectiveClockIn.getTime()) {
    res.status(400).json({ error: "Bad Request", message: "Clock-out must be after clock-in." });
    return;
  }

  // Recompute hours whenever either timestamp could have changed.
  const timestampsTouched = updates.clockInAt !== undefined || body.clockOutAt !== undefined;
  const setValues: Record<string, unknown> = { ...updates };
  if (timestampsTouched) {
    setValues.hoursWorked = effectiveClockOut ? String(calcHours(effectiveClockIn, effectiveClockOut)) : null;
  }

  if (Object.keys(setValues).length === 0) {
    const [site] = await db.select({ name: sitesTable.name }).from(sitesTable).where(eq(sitesTable.id, existing.siteId));
    res.json({ ...existing, siteName: site?.name ?? null });
    return;
  }

  const [updated] = await db
    .update(subcontractorTimeEntriesTable)
    .set(setValues)
    .where(eq(subcontractorTimeEntriesTable.id, id))
    .returning();

  const changedFields = Object.keys(setValues);
  void writeAuditLog({
    actorUserId: req.user!.userId,
    actorEmail: req.user!.email,
    actorRole: req.user!.role,
    action: "subcontractor_entry_edit",
    metadata: {
      entryId: existing.id,
      siteId: existing.siteId,
      changedFields,
      before: {
        name: existing.name,
        company: existing.company,
        badgeId: existing.badgeId,
        clockInAt: existing.clockInAt.toISOString(),
        clockOutAt: existing.clockOutAt ? existing.clockOutAt.toISOString() : null,
        hoursWorked: existing.hoursWorked,
        notes: existing.notes,
      },
      after: {
        name: updated!.name,
        company: updated!.company,
        badgeId: updated!.badgeId,
        clockInAt: updated!.clockInAt.toISOString(),
        clockOutAt: updated!.clockOutAt ? updated!.clockOutAt.toISOString() : null,
        hoursWorked: updated!.hoursWorked,
        notes: updated!.notes,
      },
    },
  });

  const [site] = await db.select({ name: sitesTable.name }).from(sitesTable).where(eq(sitesTable.id, existing.siteId));

  res.json({ ...updated, siteName: site?.name ?? null });
});

// ---------------------------------------------------------------------------
// Public: get site info for a QR token
// GET /subcontractor/clock/:token
// ---------------------------------------------------------------------------
router.get("/subcontractor/clock/:token", tokenLookupLimiter, async (req, res): Promise<void> => {
  const { token } = req.params as { token: string };

  const [qrRow] = await db.select().from(subcontractorQrTokensTable).where(eq(subcontractorQrTokensTable.token, token));
  if (!qrRow || qrRow.revokedAt) {
    res.status(410).json({ error: "Gone", message: "This QR code is invalid or has been deactivated." });
    return;
  }

  const [site] = await db.select({ id: sitesTable.id, name: sitesTable.name }).from(sitesTable).where(eq(sitesTable.id, qrRow.siteId));
  if (!site) {
    res.status(410).json({ error: "Gone", message: "The site associated with this QR code no longer exists." });
    return;
  }

  res.json({
    siteId: site.id,
    siteName: site.name,
  });
});

// ---------------------------------------------------------------------------
// Public: toggle clock-in / clock-out for a subcontractor via the site QR token
// POST /subcontractor/clock/:token  { name, company, badgeId? }
//   - If an open entry exists for (site, name, company) -> clock out.
//   - Otherwise -> clock in (new entry).
// ---------------------------------------------------------------------------
router.post("/subcontractor/clock/:token", tokenLookupLimiter, async (req, res): Promise<void> => {
  const { token } = req.params as { token: string };
  const { name, company, badgeId } = req.body ?? {};

  if (!name || typeof name !== "string" || !name.trim()) {
    res.status(400).json({ error: "Bad Request", message: "name is required" });
    return;
  }
  if (!company || typeof company !== "string" || !company.trim()) {
    res.status(400).json({ error: "Bad Request", message: "company is required" });
    return;
  }
  const cleanName = name.trim();
  const cleanCompany = company.trim();

  const [qrRow] = await db.select().from(subcontractorQrTokensTable).where(eq(subcontractorQrTokensTable.token, token));
  if (!qrRow || qrRow.revokedAt) {
    res.status(410).json({ error: "Gone", message: "This QR code is invalid or has been deactivated." });
    return;
  }

  const [site] = await db.select({ name: sitesTable.name }).from(sitesTable).where(eq(sitesTable.id, qrRow.siteId));
  if (!site) {
    res.status(410).json({ error: "Gone", message: "The site associated with this QR code no longer exists." });
    return;
  }

  // Find an open entry for this person at this site (case-insensitive match).
  const [open] = await db
    .select()
    .from(subcontractorTimeEntriesTable)
    .where(and(
      eq(subcontractorTimeEntriesTable.siteId, qrRow.siteId),
      isNull(subcontractorTimeEntriesTable.clockOutAt),
      sql`lower(${subcontractorTimeEntriesTable.name}) = lower(${cleanName})`,
      sql`lower(${subcontractorTimeEntriesTable.company}) = lower(${cleanCompany})`,
    ))
    .orderBy(subcontractorTimeEntriesTable.clockInAt);

  if (open) {
    // Clock out.
    const clockOutAt = new Date();
    const hoursWorked = calcHours(open.clockInAt, clockOutAt);
    const [updated] = await db.update(subcontractorTimeEntriesTable).set({
      clockOutAt,
      hoursWorked: String(hoursWorked),
    }).where(eq(subcontractorTimeEntriesTable.id, open.id)).returning();

    void writeAuditLog({
      actorUserId: null, actorEmail: null, actorRole: null,
      action: "subcontractor_clock_out",
      metadata: { entryId: open.id, name: open.name, company: open.company, siteId: open.siteId },
    });

    // Roll the now-closed entry into this site's weekly draft invoice
    // (best-effort, mirrors the officer time-entry approval hook).
    void upsertWeeklyInvoiceForSubcontractorEntry(updated!);

    res.json({
      action: "clocked_out",
      entryId: updated!.id,
      name: updated!.name,
      company: updated!.company,
      siteName: site.name,
      clockInAt: updated!.clockInAt.toISOString(),
      clockOutAt: clockOutAt.toISOString(),
      hoursWorked: String(hoursWorked),
    });
    return;
  }

  // Clock in (new entry).
  const clockInAt = new Date();
  const [entry] = await db.insert(subcontractorTimeEntriesTable).values({
    siteId: qrRow.siteId,
    qrTokenId: qrRow.id,
    name: cleanName,
    company: cleanCompany,
    badgeId: typeof badgeId === "string" && badgeId.trim() ? badgeId.trim() : null,
    clockInAt,
  }).returning();

  void writeAuditLog({
    actorUserId: null, actorEmail: null, actorRole: null,
    action: "subcontractor_clock_in",
    metadata: { entryId: entry!.id, name: entry!.name, company: entry!.company, siteId: entry!.siteId },
  });

  res.status(201).json({
    action: "clocked_in",
    entryId: entry!.id,
    name: entry!.name,
    company: entry!.company,
    siteName: site.name,
    clockInAt: clockInAt.toISOString(),
  });
});

export default router;
