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
import { ObjectStorageService } from "../lib/objectStorage";
import { buildEmployeeProfilePdf } from "../lib/profilePdf";

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

  // Short-lived signed URLs (5 min) re-issued every time the recipient
  // reloads the page. Section toggles already gate which entries are
  // even constructed below, so a failure to sign one doc never leaks
  // anything — we just emit `url: null` and the UI falls back to
  // showing the filename without a download button.
  const SIGN_TTL_SEC = 300;
  const signKey = async (key: string | null | undefined): Promise<string | null> => {
    if (!key) return null;
    try { return await storage.getSignedDownloadURL(key, SIGN_TTL_SEC); }
    catch (err) { req.log.warn({ err, key }, "Could not sign share document"); return null; }
  };
  const buildDoc = async (label: string, key: string | null | undefined) => ({
    label,
    filename: filenameOf(key),
    url: await signKey(key),
  });

  const docs = sections.documents
    ? (await Promise.all([
        buildDoc("CV / résumé", row.cvKey),
        buildDoc("TX security license", row.licenseDocKey),
        buildDoc("Passport / photo ID", row.passportDocKey),
        buildDoc("Right-to-work doc", row.rightToWorkDocKey),
        buildDoc("W-2 / pay stub", row.payStubDocKey),
      ])).filter((d) => !!d.filename)
    : [];
  const certs = sections.trainingCerts
    ? await Promise.all(
        (Array.isArray(row.trainingCertificateKeys) ? row.trainingCertificateKeys as string[] : [])
          .map((k, i) => buildDoc(`Training certificate ${i + 1}`, k))
      ).then((arr) => arr.filter((d) => !!d.filename))
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
    const payload = await buildEmployeeProfilePdf(r.share.employeeUserId, {
      redactForPublicShare: true,
      publicSections: resolveSections(r.share.visibleSections),
      // Embed short-lived signed download URLs so the recipient can
      // open the underlying documents straight from the PDF without
      // needing to re-load the share page. TTL matches the JSON
      // surface — recipients reload for fresh links.
      includeDocumentLinks: true,
      documentLinkTtlSec: 300,
    });
    if (!payload) { res.status(404).json({ error: "Officer not found" }); return; }

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${payload.filename}"`);
    res.setHeader("Cache-Control", "private, no-store");
    payload.stream.pipe(res);
    void Readable;
  },
);

export default router;
