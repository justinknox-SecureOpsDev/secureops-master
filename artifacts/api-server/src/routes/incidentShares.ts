import { Router, type IRouter, type Request, type Response } from "express";
import { eq, and, sql, desc, isNull } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import {
  db, incidentShareLinksTable, incidentsTable, usersTable, shiftsTable, sitesTable,
} from "@workspace/db";
import { requireAdmin } from "../middlewares/auth";
import { tokenLookupLimiter, publicShareExpensiveLimiter } from "../middlewares/rateLimit";
import { ObjectStorageService, ObjectNotFoundError } from "../lib/objectStorage";
import { buildIncidentReportPdf } from "../lib/incidentPdf";

const router: IRouter = Router();
const storage = new ObjectStorageService();

function mintToken(): string {
  // 32 random bytes → 43-char url-safe base64. Plenty of entropy and
  // safe to embed in URLs.
  return randomBytes(32).toString("base64url");
}

// Resolve a trusted public origin. We deliberately do NOT fall back to
// the request's Host header — an attacker who can spoof Host could
// poison generated share URLs (phishing vector). If neither
// APP_BASE_URL nor REPLIT_DOMAINS is set we return null so the caller
// fails closed.
function trustedPublicOrigin(): string | null {
  const env = process.env.APP_BASE_URL?.trim();
  if (env) return env.replace(/\/+$/, "");
  const domains = process.env.REPLIT_DOMAINS?.split(",").map((s) => s.trim()).filter(Boolean) ?? [];
  if (domains.length > 0) return `https://${domains[0]}`;
  return null;
}

function buildShareUrl(token: string): string | null {
  const origin = trustedPublicOrigin();
  return origin ? `${origin}/admin-portal/share/incident/${token}` : null;
}

// ---------- Admin: mint a share link ----------
router.post("/admin/incidents/:id/share", requireAdmin, async (req, res): Promise<void> => {
  const adminId = req.user!.userId;
  const incidentId = String(req.params.id);
  const { expiresInDays, recipientLabel } = (req.body ?? {}) as {
    expiresInDays?: number; recipientLabel?: string;
  };

  const [exists] = await db
    .select({ id: incidentsTable.id })
    .from(incidentsTable)
    .where(eq(incidentsTable.id, incidentId));
  if (!exists) { res.status(404).json({ error: "Not Found", message: "Incident not found" }); return; }

  const days = Number.isFinite(expiresInDays) && expiresInDays! > 0 && expiresInDays! <= 365
    ? Math.floor(expiresInDays!)
    : 30;
  const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000);

  const url0 = buildShareUrl("preflight");
  if (!url0) {
    res.status(503).json({
      error: "Service Unavailable",
      message: "APP_BASE_URL or REPLIT_DOMAINS must be configured before share links can be minted.",
    });
    return;
  }

  const [created] = await db.insert(incidentShareLinksTable).values({
    incidentId,
    token: mintToken(),
    createdBy: adminId,
    recipientLabel: recipientLabel?.trim() || null,
    expiresAt,
  }).returning();

  res.status(201).json({ ...created, url: buildShareUrl(created.token)! });
});

// ---------- Admin: list share links (optionally per incident) ----------
router.get("/admin/incident-shares", requireAdmin, async (req, res): Promise<void> => {
  const incidentId = typeof req.query.incidentId === "string" ? req.query.incidentId : undefined;
  const conditions = incidentId ? [eq(incidentShareLinksTable.incidentId, incidentId)] : [];

  const rows = await db
    .select({
      id: incidentShareLinksTable.id,
      incidentId: incidentShareLinksTable.incidentId,
      token: incidentShareLinksTable.token,
      recipientLabel: incidentShareLinksTable.recipientLabel,
      expiresAt: incidentShareLinksTable.expiresAt,
      revokedAt: incidentShareLinksTable.revokedAt,
      viewCount: incidentShareLinksTable.viewCount,
      lastViewedAt: incidentShareLinksTable.lastViewedAt,
      createdAt: incidentShareLinksTable.createdAt,
      incidentTitle: incidentsTable.title,
      incidentSeverity: incidentsTable.severity,
      incidentOccurredAt: incidentsTable.occurredAt,
      createdByName: sql<string | null>`${usersTable.firstName} || ' ' || ${usersTable.lastName}`,
    })
    .from(incidentShareLinksTable)
    .leftJoin(incidentsTable, eq(incidentShareLinksTable.incidentId, incidentsTable.id))
    .leftJoin(usersTable, eq(incidentShareLinksTable.createdBy, usersTable.id))
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(incidentShareLinksTable.createdAt));

  const origin = trustedPublicOrigin();
  res.json(rows.map((r) => ({
    ...r,
    url: origin ? `${origin}/admin-portal/share/incident/${r.token}` : null,
  })));
});

// ---------- Admin: revoke ----------
router.post("/admin/incident-shares/:id/revoke", requireAdmin, async (req, res): Promise<void> => {
  const id = String(req.params.id);
  const updated = await db
    .update(incidentShareLinksTable)
    .set({ revokedAt: new Date() })
    .where(and(eq(incidentShareLinksTable.id, id), isNull(incidentShareLinksTable.revokedAt)))
    .returning();
  if (updated.length === 0) {
    const [existing] = await db
      .select({ id: incidentShareLinksTable.id })
      .from(incidentShareLinksTable)
      .where(eq(incidentShareLinksTable.id, id));
    if (!existing) { res.status(404).json({ error: "Not Found" }); return; }
    res.status(409).json({ error: "Conflict", message: "Link already revoked" });
    return;
  }
  res.json(updated[0]);
});

// ---------- Helpers for the public surface ----------

async function loadActiveShare(token: string) {
  const [row] = await db
    .select()
    .from(incidentShareLinksTable)
    .where(eq(incidentShareLinksTable.token, token));
  if (!row) return { status: 404 as const, error: "Invalid share link" };
  if (row.revokedAt) return { status: 410 as const, error: "This share link has been revoked" };
  if (row.expiresAt.getTime() < Date.now())
    return { status: 410 as const, error: "This share link has expired" };
  return { status: 200 as const, share: row };
}

/**
 * Atomically re-check the share row is still active AND bump view
 * bookkeeping in one UPDATE … RETURNING. If the row has been revoked
 * or has expired between initial load and now, this returns nothing
 * and the caller must abort BEFORE writing the response body.
 */
async function reverifyAndBumpView(id: string): Promise<boolean> {
  const now = new Date();
  const rows = await db
    .update(incidentShareLinksTable)
    .set({
      viewCount: sql`${incidentShareLinksTable.viewCount} + 1`,
      lastViewedAt: now,
    })
    .where(and(
      eq(incidentShareLinksTable.id, id),
      isNull(incidentShareLinksTable.revokedAt),
      sql`${incidentShareLinksTable.expiresAt} > ${now}`,
    ))
    .returning({ id: incidentShareLinksTable.id });
  return rows.length > 0;
}

// ---------- Public: fetch sanitized incident by token ----------
router.get("/public/incident-shares/:token", tokenLookupLimiter, async (req, res): Promise<void> => {
  const token = String(req.params.token);
  const r = await loadActiveShare(token);
  if (r.status !== 200) { res.status(r.status).json({ error: r.error }); return; }

  const [row] = await db
    .select({
      id: incidentsTable.id,
      title: incidentsTable.title,
      description: incidentsTable.description,
      severity: incidentsTable.severity,
      status: incidentsTable.status,
      locationDescription: incidentsTable.locationDescription,
      lat: incidentsTable.lat,
      lng: incidentsTable.lng,
      occurredAt: incidentsTable.occurredAt,
      resolvedAt: incidentsTable.resolvedAt,
      attachments: incidentsTable.attachments,
      employeeFirstName: usersTable.firstName,
      employeeLastName: usersTable.lastName,
      shiftTitle: shiftsTable.title,
      siteName: sitesTable.name,
    })
    .from(incidentsTable)
    .leftJoin(usersTable, eq(incidentsTable.employeeId, usersTable.id))
    .leftJoin(shiftsTable, eq(incidentsTable.shiftId, shiftsTable.id))
    .leftJoin(sitesTable, eq(shiftsTable.siteId, sitesTable.id))
    .where(eq(incidentsTable.id, r.share.incidentId));
  if (!row) { res.status(404).json({ error: "Incident not found" }); return; }

  // Re-check active+unexpired AND bump view count atomically. If the
  // admin revoked / the link expired between loadActiveShare and now,
  // refuse to emit the body.
  const stillActive = await reverifyAndBumpView(r.share.id);
  if (!stillActive) {
    res.status(410).json({ error: "This share link is no longer active" });
    return;
  }

  // Sign each attachment for direct GCS download. Short TTL since these
  // are returned over the public link surface.
  const signedAttachments: { key: string; url: string }[] = [];
  for (const key of row.attachments ?? []) {
    if (typeof key !== "string" || !key.startsWith("/objects/")) continue;
    try {
      const url = await storage.getSignedDownloadURL(key, 300);
      signedAttachments.push({ key, url });
    } catch (err) {
      if (!(err instanceof ObjectNotFoundError)) req.log.warn({ err, key }, "Could not sign attachment");
    }
  }

  // Sanitized payload — explicitly no internal admin notes, no employee
  // email/phone/IDs, no employeeId, no shiftId, no createdAt.
  // `responderName` is reduced to "F. Last" so the client knows who
  // attended without leaking the officer's full identity over the
  // unauthenticated surface.
  const responderName = row.employeeFirstName && row.employeeLastName
    ? `${row.employeeFirstName[0]}. ${row.employeeLastName}`
    : (row.employeeLastName || null);

  res.json({
    id: row.id,
    title: row.title,
    description: row.description,
    severity: row.severity,
    status: row.status,
    locationDescription: row.locationDescription,
    lat: row.lat,
    lng: row.lng,
    occurredAt: row.occurredAt,
    resolvedAt: row.resolvedAt,
    responderName,
    siteName: row.siteName,
    shiftTitle: row.shiftTitle,
    attachments: signedAttachments,
    share: {
      expiresAt: r.share.expiresAt,
      viewCount: r.share.viewCount + 1,
    },
  });
});

// ---------- Public: stream the incident PDF by token ----------
// Uses the stricter expensive-share limiter on top of tokenLookupLimiter
// because PDF rendering does DB joins + attachment fetches + image
// embedding.
router.get(
  "/public/incident-shares/:token/pdf",
  publicShareExpensiveLimiter,
  tokenLookupLimiter,
  async (req: Request, res: Response): Promise<void> => {
    const token = String(req.params.token);
    const r = await loadActiveShare(token);
    if (r.status !== 200) { res.status(r.status).json({ error: r.error }); return; }

    // Atomic re-check + bookkeeping BEFORE we start emitting bytes.
    const stillActive = await reverifyAndBumpView(r.share.id);
    if (!stillActive) {
      res.status(410).json({ error: "This share link is no longer active" });
      return;
    }

    // Critical: pass `redactForPublicShare` so the PDF strips
    // adminNotes + officer email/phone and shortens officer name.
    const payload = await buildIncidentReportPdf(r.share.incidentId, { redactForPublicShare: true });
    if (!payload) { res.status(404).json({ error: "Incident not found" }); return; }

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${payload.filename}"`);
    res.setHeader("Cache-Control", "private, no-store");
    payload.stream.pipe(res);
    void Readable; // keep import used if PDF lib changes later
  },
);

export default router;
