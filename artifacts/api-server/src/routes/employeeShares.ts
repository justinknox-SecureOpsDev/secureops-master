import { Router, type IRouter, type Request, type Response } from "express";
import { eq, and, sql, desc, isNull } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import {
  db, employeeShareLinksTable, usersTable, employeesTable,
  DEFAULT_EMPLOYEE_SHARE_SECTIONS,
  type EmployeeShareVisibleSections,
} from "@workspace/db";
import { requireAdmin } from "../middlewares/auth";
import { tokenLookupLimiter, publicShareExpensiveLimiter } from "../middlewares/rateLimit";
import { ObjectStorageService, ObjectNotFoundError } from "../lib/objectStorage";
import { buildEmployeeProfilePdf } from "../lib/profilePdf";
import {
  watermarkPdfBuffer,
  watermarkImageBuffer,
  isPdfContentType,
  isWatermarkableImageContentType,
  type WatermarkInfo,
} from "../lib/watermark";

const router: IRouter = Router();
const storage = new ObjectStorageService();

function mintToken(): string {
  // 32 random bytes → 43-char url-safe base64. Plenty of entropy and
  // safe to embed in URLs. Matches incidentShares.ts.
  return randomBytes(32).toString("base64url");
}

// Mirror of trustedPublicOrigin() in incidentShares.ts — deliberately
// NOT falling back to Host header (phishing-via-spoofed-Host vector).
function trustedPublicOrigin(): string | null {
  const env = process.env.APP_BASE_URL?.trim();
  if (env) return env.replace(/\/+$/, "");
  const domains = process.env.REPLIT_DOMAINS?.split(",").map((s) => s.trim()).filter(Boolean) ?? [];
  if (domains.length > 0) return `https://${domains[0]}`;
  return null;
}

function buildShareUrl(token: string): string | null {
  const origin = trustedPublicOrigin();
  return origin ? `${origin}/admin-portal/share/employee/${token}` : null;
}

/**
 * Build an absolute URL pointing at the watermark-proxy download
 * endpoint for one document on this share. Returns null when no
 * trusted origin is configured — callers should fall back to omitting
 * the link (we do NOT leak a raw signed object-storage URL here,
 * because that would bypass the watermark).
 */
function buildWatermarkUrl(token: string, slot: string): string | null {
  const origin = trustedPublicOrigin();
  return origin
    ? `${origin}/api/public/employee-shares/${encodeURIComponent(token)}/document/${encodeURIComponent(slot)}`
    : null;
}

/** First 8 chars of the share token — short enough to skim, long enough to disambiguate in audits. */
function shortIdOf(token: string): string {
  return token.slice(0, 8);
}

const SECTION_KEYS: ReadonlyArray<keyof EmployeeShareVisibleSections> = [
  "license", "experience", "skills", "uniform", "trainingCerts", "documents",
];

/**
 * Coerce arbitrary client input into a strict section map. Unknown
 * keys are dropped; missing keys default to `true` (matches the legacy
 * "everything visible" behaviour). Returns null when the caller did
 * not provide a value at all so we can fall back to the column default.
 */
function coerceSections(input: unknown): EmployeeShareVisibleSections | null {
  if (input === undefined || input === null) return null;
  if (typeof input !== "object") return null;
  const src = input as Record<string, unknown>;
  const out: EmployeeShareVisibleSections = { ...DEFAULT_EMPLOYEE_SHARE_SECTIONS };
  for (const k of SECTION_KEYS) {
    if (k in src) out[k] = src[k] === true;
  }
  return out;
}

/** Treat null / partial rows as "every section enabled" — matches legacy behaviour. */
function resolveSections(stored: unknown): EmployeeShareVisibleSections {
  const coerced = coerceSections(stored);
  return coerced ?? { ...DEFAULT_EMPLOYEE_SHARE_SECTIONS };
}

// ---------- Admin: mint a share link ----------
router.post("/admin/employees/:id/share", requireAdmin, async (req, res): Promise<void> => {
  const adminId = req.user!.userId;
  const employeeUserId = String(req.params.id);
  const { expiresInDays, recipientLabel, visibleSections } = (req.body ?? {}) as {
    expiresInDays?: number; recipientLabel?: string; visibleSections?: unknown;
  };
  const sections = coerceSections(visibleSections);

  // Admin grid rows for "employees" are keyed by `employees.id` (the
  // employees-table PK), but the share / PDF surfaces are keyed by
  // `users.id`. Accept either form and resolve to the canonical
  // `users.id` so the UI doesn't have to know the difference.
  const [direct] = await db
    .select({ id: usersTable.id })
    .from(usersTable)
    .where(and(eq(usersTable.id, employeeUserId), eq(usersTable.role, "employee")));
  let resolvedUserId: string | null = direct?.id ?? null;
  if (!resolvedUserId) {
    const [viaEmployee] = await db
      .select({ id: usersTable.id })
      .from(employeesTable)
      .leftJoin(usersTable, eq(usersTable.id, employeesTable.userId))
      .where(and(eq(employeesTable.id, employeeUserId), eq(usersTable.role, "employee")));
    resolvedUserId = viaEmployee?.id ?? null;
  }
  if (!resolvedUserId) { res.status(404).json({ error: "Not Found", message: "Officer not found" }); return; }

  const days = Number.isFinite(expiresInDays) && expiresInDays! > 0 && expiresInDays! <= 365
    ? Math.floor(expiresInDays!)
    : 30;
  const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000);

  // Fail closed if we cannot mint a trusted URL — see incidentShares.
  if (!buildShareUrl("preflight")) {
    res.status(503).json({
      error: "Service Unavailable",
      message: "APP_BASE_URL or REPLIT_DOMAINS must be configured before share links can be minted.",
    });
    return;
  }

  const [created] = await db.insert(employeeShareLinksTable).values({
    employeeUserId: resolvedUserId,
    token: mintToken(),
    createdBy: adminId,
    recipientLabel: recipientLabel?.trim() || null,
    expiresAt,
    visibleSections: sections,
  }).returning();

  res.status(201).json({
    ...created,
    visibleSections: resolveSections(created.visibleSections),
    url: buildShareUrl(created.token)!,
  });
});

// ---------- Admin: list share links (optionally per officer) ----------
router.get("/admin/employee-shares", requireAdmin, async (req, res): Promise<void> => {
  const employeeUserId = typeof req.query.employeeUserId === "string" ? req.query.employeeUserId : undefined;
  const conditions = employeeUserId ? [eq(employeeShareLinksTable.employeeUserId, employeeUserId)] : [];

  // Self-join users twice: once for the officer, once for the admin
  // who minted the link.
  const officerUsers = usersTable;
  const rows = await db
    .select({
      id: employeeShareLinksTable.id,
      employeeUserId: employeeShareLinksTable.employeeUserId,
      token: employeeShareLinksTable.token,
      recipientLabel: employeeShareLinksTable.recipientLabel,
      expiresAt: employeeShareLinksTable.expiresAt,
      revokedAt: employeeShareLinksTable.revokedAt,
      viewCount: employeeShareLinksTable.viewCount,
      lastViewedAt: employeeShareLinksTable.lastViewedAt,
      visibleSections: employeeShareLinksTable.visibleSections,
      createdAt: employeeShareLinksTable.createdAt,
      officerFirstName: officerUsers.firstName,
      officerLastName: officerUsers.lastName,
      createdByName: sql<string | null>`(select first_name || ' ' || last_name from users where id = ${employeeShareLinksTable.createdBy})`,
    })
    .from(employeeShareLinksTable)
    .leftJoin(officerUsers, eq(employeeShareLinksTable.employeeUserId, officerUsers.id))
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(employeeShareLinksTable.createdAt));

  const origin = trustedPublicOrigin();
  res.json(rows.map((r) => ({
    ...r,
    visibleSections: resolveSections(r.visibleSections),
    url: origin ? `${origin}/admin-portal/share/employee/${r.token}` : null,
  })));
});

// ---------- Admin: edit visible sections on an existing share ----------
router.patch("/admin/employee-shares/:id", requireAdmin, async (req, res): Promise<void> => {
  const id = String(req.params.id);
  const { visibleSections } = (req.body ?? {}) as { visibleSections?: unknown };
  const sections = coerceSections(visibleSections);
  if (!sections) {
    res.status(400).json({ error: "Bad Request", message: "visibleSections is required" });
    return;
  }

  // Only update rows that are still active (not revoked, not expired).
  // Editing a dead link is a no-op from the recipient's perspective and
  // would be confusing in the UI.
  const now = new Date();
  const updated = await db
    .update(employeeShareLinksTable)
    .set({ visibleSections: sections })
    .where(and(
      eq(employeeShareLinksTable.id, id),
      isNull(employeeShareLinksTable.revokedAt),
      sql`${employeeShareLinksTable.expiresAt} > ${now}`,
    ))
    .returning();
  if (updated.length === 0) {
    const [existing] = await db
      .select({ id: employeeShareLinksTable.id })
      .from(employeeShareLinksTable)
      .where(eq(employeeShareLinksTable.id, id));
    if (!existing) { res.status(404).json({ error: "Not Found" }); return; }
    res.status(409).json({ error: "Conflict", message: "Link is revoked or expired" });
    return;
  }
  res.json({
    ...updated[0],
    visibleSections: resolveSections(updated[0].visibleSections),
  });
});

// ---------- Admin: revoke ----------
router.post("/admin/employee-shares/:id/revoke", requireAdmin, async (req, res): Promise<void> => {
  const id = String(req.params.id);
  const updated = await db
    .update(employeeShareLinksTable)
    .set({ revokedAt: new Date() })
    .where(and(eq(employeeShareLinksTable.id, id), isNull(employeeShareLinksTable.revokedAt)))
    .returning();
  if (updated.length === 0) {
    const [existing] = await db
      .select({ id: employeeShareLinksTable.id })
      .from(employeeShareLinksTable)
      .where(eq(employeeShareLinksTable.id, id));
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
    .from(employeeShareLinksTable)
    .where(eq(employeeShareLinksTable.token, token));
  if (!row) return { status: 404 as const, error: "Invalid share link" };
  if (row.revokedAt) return { status: 410 as const, error: "This share link has been revoked" };
  if (row.expiresAt.getTime() < Date.now())
    return { status: 410 as const, error: "This share link has expired" };
  return { status: 200 as const, share: row };
}

/**
 * Atomically re-check the share row is still active AND bump view
 * bookkeeping in one UPDATE … RETURNING. If the row has been revoked
 * or has expired between initial load and now, this returns false and
 * the caller must abort BEFORE writing the response body.
 */
async function reverifyAndBumpView(id: string): Promise<boolean> {
  const now = new Date();
  const rows = await db
    .update(employeeShareLinksTable)
    .set({
      viewCount: sql`${employeeShareLinksTable.viewCount} + 1`,
      lastViewedAt: now,
    })
    .where(and(
      eq(employeeShareLinksTable.id, id),
      isNull(employeeShareLinksTable.revokedAt),
      sql`${employeeShareLinksTable.expiresAt} > ${now}`,
    ))
    .returning({ id: employeeShareLinksTable.id });
  return rows.length > 0;
}

// ---------- Public: fetch sanitized officer summary by token ----------
router.get("/public/employee-shares/:token", tokenLookupLimiter, async (req, res): Promise<void> => {
  const token = String(req.params.token);
  const r = await loadActiveShare(token);
  if (r.status !== 200) { res.status(r.status).json({ error: r.error }); return; }

  const [row] = await db
    .select({
      id: usersTable.id,
      firstName: usersTable.firstName,
      lastName: usersTable.lastName,
      photoKey: employeesTable.photoKey,
      siaLicenseNumber: employeesTable.siaLicenseNumber,
      siaLicenseLevel: employeesTable.siaLicenseLevel,
      siaLicenseExpiry: employeesTable.siaLicenseExpiry,
      yearsExperience: employeesTable.yearsExperience,
      previousExperience: employeesTable.previousExperience,
      rightToWorkStatus: employeesTable.rightToWorkStatus,
      skills: employeesTable.skills,
      uniformShirt: employeesTable.uniformShirt,
      uniformTrousers: employeesTable.uniformTrousers,
      uniformJacket: employeesTable.uniformJacket,
      uniformBoots: employeesTable.uniformBoots,
      cvKey: employeesTable.cvKey,
      licenseDocKey: employeesTable.licenseDocKey,
      passportDocKey: employeesTable.passportDocKey,
      rightToWorkDocKey: employeesTable.rightToWorkDocKey,
      payStubDocKey: employeesTable.payStubDocKey,
      trainingCertificateKeys: employeesTable.trainingCertificateKeys,
    })
    .from(usersTable)
    .leftJoin(employeesTable, eq(employeesTable.userId, usersTable.id))
    .where(and(eq(usersTable.id, r.share.employeeUserId), eq(usersTable.role, "employee")));
  if (!row) { res.status(404).json({ error: "Officer not found" }); return; }

  const sections = resolveSections(r.share.visibleSections);

  // Re-check active+unexpired AND bump view count atomically. If the
  // admin revoked / the link expired between loadActiveShare and now,
  // refuse to emit the body.
  const stillActive = await reverifyAndBumpView(r.share.id);
  if (!stillActive) {
    res.status(410).json({ error: "This share link is no longer active" });
    return;
  }

  let photoUrl: string | null = null;
  if (row.photoKey) {
    try { photoUrl = await storage.getSignedDownloadURL(row.photoKey, 300); }
    catch (err) { req.log.warn({ err, key: row.photoKey }, "Could not sign photo"); }
  }

  // Sanitized payload — explicitly no email, no phone, no address, no
  // DOB, no SSN (even masked), no banking, no emergency contact, no
  // hourly rate, no references, no acknowledgements. Per-section
  // toggles further pare back the visible surface.
  const filenameOf = (key: string | null | undefined): string | null =>
    key ? (key.split("/").pop() ?? null) : null;

  // Document download URLs route through the watermark proxy below so
  // every byte the recipient receives carries a recipient-label +
  // short-token-id + access-timestamp footer. We never hand out the
  // raw signed object-storage URL on the public surface — that would
  // bypass the watermark and defeat the point of this feature.
  const buildDoc = (label: string, key: string | null | undefined, slot: string) => ({
    label,
    filename: filenameOf(key),
    url: key ? buildWatermarkUrl(token, slot) : null,
  });

  const docs = sections.documents
    ? [
        buildDoc("CV / résumé", row.cvKey, "cv"),
        buildDoc("TX security license", row.licenseDocKey, "license"),
        buildDoc("Passport / photo ID", row.passportDocKey, "passport"),
        buildDoc("Right-to-work doc", row.rightToWorkDocKey, "right-to-work"),
        buildDoc("W-2 / pay stub", row.payStubDocKey, "pay-stub"),
      ].filter((d) => !!d.filename)
    : [];
  const certs = sections.trainingCerts
    ? (Array.isArray(row.trainingCertificateKeys) ? row.trainingCertificateKeys as string[] : [])
        .map((k, i) => buildDoc(`Training certificate ${i + 1}`, k, `training-${i}`))
        .filter((d) => !!d.filename)
    : [];

  res.json({
    firstName: row.firstName,
    lastName: row.lastName,
    photoUrl,
    licenseNumber: sections.license ? row.siaLicenseNumber : null,
    licenseLevel: sections.license ? row.siaLicenseLevel : null,
    licenseExpiry: sections.license ? row.siaLicenseExpiry : null,
    yearsExperience: sections.experience ? row.yearsExperience : null,
    previousExperience: sections.experience ? row.previousExperience : null,
    rightToWorkStatus: row.rightToWorkStatus,
    skills: sections.skills && Array.isArray(row.skills) ? row.skills : [],
    uniform: sections.uniform ? {
      shirt: row.uniformShirt,
      trousers: row.uniformTrousers,
      jacket: row.uniformJacket,
      boots: row.uniformBoots,
    } : { shirt: null, trousers: null, jacket: null, boots: null },
    documents: docs,
    trainingCertificates: certs,
    visibleSections: sections,
    share: {
      expiresAt: r.share.expiresAt,
      viewCount: r.share.viewCount + 1,
    },
  });
});

// ---------- Public: stream the redacted profile PDF by token ----------
// Uses the stricter expensive-share limiter on top of tokenLookupLimiter
// because PDF rendering does DB joins + photo fetch + image embedding.
router.get(
  "/public/employee-shares/:token/pdf",
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

    // Critical: pass `redactForPublicShare` so the PDF drops banking,
    // SSN, contact, DOB, emergency contact, hourly rate, references,
    // and acknowledgements. The per-link `visibleSections` map further
    // pares back which optional sections render.
    // Resolve the employee row so we can map document keys to share
    // slot ids — the embedded links inside the PDF must route through
    // the watermark proxy, not raw signed URLs.
    const [empRow] = await db
      .select({
        cvKey: employeesTable.cvKey,
        licenseDocKey: employeesTable.licenseDocKey,
        passportDocKey: employeesTable.passportDocKey,
        rightToWorkDocKey: employeesTable.rightToWorkDocKey,
        payStubDocKey: employeesTable.payStubDocKey,
        trainingCertificateKeys: employeesTable.trainingCertificateKeys,
      })
      .from(employeesTable)
      .where(eq(employeesTable.userId, r.share.employeeUserId));
    const keyToSlot = new Map<string, string>();
    if (empRow) {
      if (empRow.cvKey) keyToSlot.set(empRow.cvKey, "cv");
      if (empRow.licenseDocKey) keyToSlot.set(empRow.licenseDocKey, "license");
      if (empRow.passportDocKey) keyToSlot.set(empRow.passportDocKey, "passport");
      if (empRow.rightToWorkDocKey) keyToSlot.set(empRow.rightToWorkDocKey, "right-to-work");
      if (empRow.payStubDocKey) keyToSlot.set(empRow.payStubDocKey, "pay-stub");
      const certs = Array.isArray(empRow.trainingCertificateKeys)
        ? empRow.trainingCertificateKeys as string[]
        : [];
      certs.forEach((k, i) => { if (k) keyToSlot.set(k, `training-${i}`); });
    }

    const payload = await buildEmployeeProfilePdf(r.share.employeeUserId, {
      redactForPublicShare: true,
      publicSections: resolveSections(r.share.visibleSections),
      // Embed download links that route through the watermark proxy
      // (NOT raw signed object-storage URLs) so any file the recipient
      // pulls from the embedded link still gets watermarked. Returning
      // null from the builder drops that link silently — keeps the PDF
      // valid even if a key fell out of the keyToSlot map.
      includeDocumentLinks: true,
      documentUrlBuilder: (key: string) => {
        const slot = keyToSlot.get(key);
        if (!slot) return null;
        return buildWatermarkUrl(token, slot);
      },
    });
    if (!payload) { res.status(404).json({ error: "Officer not found" }); return; }

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${payload.filename}"`);
    res.setHeader("Cache-Control", "private, no-store");
    payload.stream.pipe(res);
    void Readable;
  },
);

// ---------- Public: watermarked download proxy ----------
// Resolves a share + slot id to one of the employee's stored object
// keys, fetches the file from object storage, overlays a footer /
// banner watermark with the share recipient label + short token id +
// access timestamp, and streams the watermarked copy. The source
// object in storage is never modified.
//
// Only the public-share path uses this — admin/self downloads still
// hit the un-watermarked signed-URL endpoints in routes/storage.ts so
// internal consumers see the original file.
router.get(
  "/public/employee-shares/:token/document/:slot",
  publicShareExpensiveLimiter,
  tokenLookupLimiter,
  async (req: Request, res: Response): Promise<void> => {
    const token = String(req.params.token);
    const slot = String(req.params.slot);
    const r = await loadActiveShare(token);
    if (r.status !== 200) { res.status(r.status).json({ error: r.error }); return; }

    const sections = resolveSections(r.share.visibleSections);

    // Resolve slot → object key against the employee's row, enforcing
    // the same per-section visibility toggles the JSON surface honours.
    // Without this check, a recipient could request `pay-stub` against
    // a link whose admin had toggled the "documents" section off.
    const [empRow] = await db
      .select({
        cvKey: employeesTable.cvKey,
        licenseDocKey: employeesTable.licenseDocKey,
        passportDocKey: employeesTable.passportDocKey,
        rightToWorkDocKey: employeesTable.rightToWorkDocKey,
        payStubDocKey: employeesTable.payStubDocKey,
        trainingCertificateKeys: employeesTable.trainingCertificateKeys,
      })
      .from(employeesTable)
      .where(eq(employeesTable.userId, r.share.employeeUserId));
    if (!empRow) { res.status(404).json({ error: "Document not found" }); return; }

    let objectKey: string | null = null;
    if (sections.documents) {
      if (slot === "cv") objectKey = empRow.cvKey;
      else if (slot === "license") objectKey = empRow.licenseDocKey;
      else if (slot === "passport") objectKey = empRow.passportDocKey;
      else if (slot === "right-to-work") objectKey = empRow.rightToWorkDocKey;
      else if (slot === "pay-stub") objectKey = empRow.payStubDocKey;
    }
    if (!objectKey && sections.trainingCerts) {
      const m = /^training-(\d+)$/.exec(slot);
      if (m) {
        const idx = Number(m[1]);
        const certs = Array.isArray(empRow.trainingCertificateKeys)
          ? empRow.trainingCertificateKeys as string[]
          : [];
        if (Number.isInteger(idx) && idx >= 0 && idx < certs.length) {
          objectKey = certs[idx] ?? null;
        }
      }
    }
    if (!objectKey) { res.status(404).json({ error: "Document not found" }); return; }

    // Atomic re-check + bookkeeping BEFORE we fetch / emit bytes. A
    // simultaneous revoke must abort the download.
    const stillActive = await reverifyAndBumpView(r.share.id);
    if (!stillActive) {
      res.status(410).json({ error: "This share link is no longer active" });
      return;
    }

    let source: { buffer: Buffer; contentType: string; filename: string };
    try {
      source = await storage.downloadObjectBuffer(objectKey);
    } catch (err) {
      if (err instanceof ObjectNotFoundError) {
        res.status(404).json({ error: "Document not found" });
        return;
      }
      req.log.error({ err, key: objectKey }, "Could not fetch share document");
      res.status(502).json({ error: "Document unavailable" });
      return;
    }

    const info: WatermarkInfo = {
      recipientLabel: r.share.recipientLabel?.trim() || "external recipient",
      tokenShortId: shortIdOf(token),
      accessedAt: new Date(),
    };

    let outBuf = source.buffer;
    let outType = source.contentType;
    try {
      if (isPdfContentType(source.contentType)) {
        outBuf = await watermarkPdfBuffer(source.buffer, info);
        outType = "application/pdf";
      } else if (isWatermarkableImageContentType(source.contentType)) {
        const wm = await watermarkImageBuffer(source.buffer, info);
        outBuf = wm.buffer;
        outType = wm.contentType;
      }
      // Otherwise: pass through untouched. We deliberately do NOT block
      // unknown content types — recipients still need the file.
    } catch (err) {
      req.log.warn(
        { err, key: objectKey, contentType: source.contentType },
        "Watermark overlay failed — streaming raw bytes",
      );
      // Fall through with the original buffer so the recipient still
      // gets the file even if watermarking blew up on a malformed
      // PDF / image.
    }

    res.setHeader("Content-Type", outType);
    res.setHeader("Content-Length", String(outBuf.length));
    // Cache-Control: 'private, no-store' — these URLs are tied to a
    // single access event and the watermark is timestamped, so a
    // shared cache holding the response would defeat the audit trail.
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${source.filename.replace(/[\r\n"\\]/g, "_")}"`,
    );
    res.status(200).end(outBuf);
  },
);

export default router;
