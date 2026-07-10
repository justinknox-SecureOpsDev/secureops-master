import { Router, type IRouter } from "express";
import { z } from "zod/v4";
import { and, eq, gte, inArray, lte, or, sql } from "drizzle-orm";
import { WORKER_ROLES } from "../lib/eligibility";
import {
  db,
  trainingCertificationsTable,
  usersTable,
  sitesTable,
  licensesTable,
} from "@workspace/db";
import { requireAuth, requireAdmin } from "../middlewares/auth";

const router: IRouter = Router();

// ---------- Schemas ----------

// Slugify the type so site.requiredTrainings can reference a stable key
// regardless of how the officer typed/cased it on entry.
const TYPE_RE = /^[a-z0-9][a-z0-9_:-]{0,63}$/;
function slugifyType(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, "_").replace(/[^a-z0-9_:-]/g, "");
}

const writeSchema = z.object({
  type: z.string().trim().min(1).max(64),
  title: z.string().trim().min(1).max(160),
  issuingAuthority: z.string().trim().max(160).nullish(),
  certificateNumber: z.string().trim().max(120).nullish(),
  issueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
  // null = never expires.
  expiryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
  docKey: z.string().trim().max(512).nullish(),
  notes: z.string().trim().max(2000).nullish(),
});

const patchSchema = writeSchema.partial();

function statusFor(expiryDate: string | null): "valid" | "expiring_soon" | "expired" | "no_expiry" {
  if (!expiryDate) return "no_expiry";
  const exp = new Date(expiryDate);
  const now = new Date();
  if (exp < now) return "expired";
  if (exp.getTime() - now.getTime() <= 30 * 24 * 60 * 60 * 1000) return "expiring_soon";
  return "valid";
}

function shape(row: typeof trainingCertificationsTable.$inferSelect) {
  return { ...row, status: statusFor(row.expiryDate) };
}

// ---------- Officer self-serve ----------

router.get("/me/trainings", requireAuth, async (req, res): Promise<void> => {
  const rows = await db
    .select()
    .from(trainingCertificationsTable)
    .where(eq(trainingCertificationsTable.employeeId, req.user!.userId));
  res.json(rows.map(shape));
});

router.post("/me/trainings", requireAuth, async (req, res): Promise<void> => {
  const parsed = writeSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Bad Request", issues: parsed.error.issues }); return; }
  const data = parsed.data;
  const type = slugifyType(data.type);
  if (!TYPE_RE.test(type)) {
    res.status(400).json({ error: "Bad Request", message: "type must contain letters/numbers/underscore" });
    return;
  }
  const [row] = await db.insert(trainingCertificationsTable).values({
    employeeId: req.user!.userId,
    type,
    title: data.title,
    issuingAuthority: data.issuingAuthority ?? null,
    certificateNumber: data.certificateNumber ?? null,
    issueDate: data.issueDate ?? null,
    expiryDate: data.expiryDate ?? null,
    docKey: data.docKey ?? null,
    notes: data.notes ?? null,
  }).returning();
  res.status(201).json(shape(row));
});

router.put("/me/trainings/:id", requireAuth, async (req, res): Promise<void> => {
  const idParse = z.string().uuid().safeParse(req.params.id);
  if (!idParse.success) { res.status(400).json({ error: "Bad Request", message: "Invalid id" }); return; }
  const parsed = patchSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Bad Request", issues: parsed.error.issues }); return; }

  // Verify ownership BEFORE updating so we don't leak existence of other rows.
  const [existing] = await db
    .select({ employeeId: trainingCertificationsTable.employeeId, currentExpiry: trainingCertificationsTable.expiryDate })
    .from(trainingCertificationsTable)
    .where(eq(trainingCertificationsTable.id, idParse.data))
    .limit(1);
  if (!existing) { res.status(404).json({ error: "Not Found" }); return; }
  if (existing.employeeId !== req.user!.userId) { res.status(403).json({ error: "Forbidden" }); return; }

  const updates: Partial<typeof trainingCertificationsTable.$inferInsert> = {};
  const d = parsed.data;
  if (d.type !== undefined) {
    const t = slugifyType(d.type);
    if (!TYPE_RE.test(t)) { res.status(400).json({ error: "Bad Request", message: "type invalid" }); return; }
    updates.type = t;
  }
  if (d.title !== undefined) updates.title = d.title;
  if (d.issuingAuthority !== undefined) updates.issuingAuthority = d.issuingAuthority ?? null;
  if (d.certificateNumber !== undefined) updates.certificateNumber = d.certificateNumber ?? null;
  if (d.issueDate !== undefined) updates.issueDate = d.issueDate ?? null;
  if (d.expiryDate !== undefined) {
    updates.expiryDate = d.expiryDate ?? null;
    // Reset reminder bookkeeping so a renewed cert re-arms the 30/14/7 cycle.
    if (d.expiryDate !== existing.currentExpiry) {
      updates.lastReminderTier = null;
      updates.lastReminderSentAt = null;
      updates.lastReminderForExpiry = null;
    }
  }
  if (d.docKey !== undefined) updates.docKey = d.docKey ?? null;
  if (d.notes !== undefined) updates.notes = d.notes ?? null;

  const [row] = await db.update(trainingCertificationsTable)
    .set(updates)
    .where(eq(trainingCertificationsTable.id, idParse.data))
    .returning();
  res.json(shape(row));
});

router.delete("/me/trainings/:id", requireAuth, async (req, res): Promise<void> => {
  const idParse = z.string().uuid().safeParse(req.params.id);
  if (!idParse.success) { res.status(400).json({ error: "Bad Request", message: "Invalid id" }); return; }
  // Scope the delete by ownership so a guessed UUID can't nuke another
  // officer's record. Anonymous 404 on miss.
  const result = await db.delete(trainingCertificationsTable)
    .where(and(
      eq(trainingCertificationsTable.id, idParse.data),
      eq(trainingCertificationsTable.employeeId, req.user!.userId),
    ))
    .returning({ id: trainingCertificationsTable.id });
  if (result.length === 0) { res.status(404).json({ error: "Not Found" }); return; }
  res.sendStatus(204);
});

// ---------- Admin: list/CRUD across all officers ----------

router.get("/admin/trainings", requireAdmin, async (req, res): Promise<void> => {
  const q = z.object({
    employeeId: z.string().uuid().optional(),
    type: z.string().trim().max(64).optional(),
    expiringWithinDays: z.coerce.number().int().min(0).max(365).optional(),
    status: z.enum(["valid", "expiring_soon", "expired", "no_expiry"]).optional(),
  }).safeParse(req.query);
  if (!q.success) { res.status(400).json({ error: "Bad Request", issues: q.error.issues }); return; }

  const conds = [];
  if (q.data.employeeId) conds.push(eq(trainingCertificationsTable.employeeId, q.data.employeeId));
  if (q.data.type) conds.push(eq(trainingCertificationsTable.type, slugifyType(q.data.type)));
  if (q.data.expiringWithinDays != null) {
    conds.push(gte(trainingCertificationsTable.expiryDate, sql`current_date`));
    conds.push(lte(trainingCertificationsTable.expiryDate, sql`current_date + (${q.data.expiringWithinDays}::int * interval '1 day')`));
  }

  const rows = await db
    .select({
      id: trainingCertificationsTable.id,
      employeeId: trainingCertificationsTable.employeeId,
      type: trainingCertificationsTable.type,
      title: trainingCertificationsTable.title,
      issuingAuthority: trainingCertificationsTable.issuingAuthority,
      certificateNumber: trainingCertificationsTable.certificateNumber,
      issueDate: trainingCertificationsTable.issueDate,
      expiryDate: trainingCertificationsTable.expiryDate,
      docKey: trainingCertificationsTable.docKey,
      notes: trainingCertificationsTable.notes,
      createdAt: trainingCertificationsTable.createdAt,
      employeeName: sql<string>`coalesce(${usersTable.firstName} || ' ' || ${usersTable.lastName}, ${usersTable.email})`,
      employeeEmail: usersTable.email,
    })
    .from(trainingCertificationsTable)
    .leftJoin(usersTable, eq(usersTable.id, trainingCertificationsTable.employeeId))
    .where(conds.length > 0 ? and(...conds) : undefined);

  let shaped = rows.map((r) => ({ ...r, status: statusFor(r.expiryDate) }));
  if (q.data.status) shaped = shaped.filter((r) => r.status === q.data.status);
  res.json(shaped);
});

router.post("/admin/trainings", requireAdmin, async (req, res): Promise<void> => {
  const parsed = writeSchema.extend({ employeeId: z.string().uuid() }).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Bad Request", issues: parsed.error.issues }); return; }
  const type = slugifyType(parsed.data.type);
  if (!TYPE_RE.test(type)) { res.status(400).json({ error: "Bad Request", message: "type invalid" }); return; }
  // Verify the target user exists so a bad employeeId surfaces as 400, not
  // a downstream FK error.
  const [u] = await db.select({ id: usersTable.id }).from(usersTable).where(eq(usersTable.id, parsed.data.employeeId)).limit(1);
  if (!u) { res.status(400).json({ error: "Bad Request", message: "employeeId not found" }); return; }
  const [row] = await db.insert(trainingCertificationsTable).values({
    employeeId: parsed.data.employeeId,
    type,
    title: parsed.data.title,
    issuingAuthority: parsed.data.issuingAuthority ?? null,
    certificateNumber: parsed.data.certificateNumber ?? null,
    issueDate: parsed.data.issueDate ?? null,
    expiryDate: parsed.data.expiryDate ?? null,
    docKey: parsed.data.docKey ?? null,
    notes: parsed.data.notes ?? null,
  }).returning();
  res.status(201).json(shape(row));
});

router.delete("/admin/trainings/:id", requireAdmin, async (req, res): Promise<void> => {
  const idParse = z.string().uuid().safeParse(req.params.id);
  if (!idParse.success) { res.status(400).json({ error: "Bad Request", message: "Invalid id" }); return; }
  const r = await db.delete(trainingCertificationsTable)
    .where(eq(trainingCertificationsTable.id, idParse.data))
    .returning({ id: trainingCertificationsTable.id });
  if (r.length === 0) { res.status(404).json({ error: "Not Found" }); return; }
  res.sendStatus(204);
});

// ---------- Compliance ----------

/**
 * Compute compliance for one officer against one (optional) site.
 *
 * - licenseLevelOk: max(level) over UNEXPIRED licenses meets the site's
 *   most-demanding upcoming shift requirement. If `requiredLevel` is null
 *   we report the max instead of a pass/fail.
 * - missingTrainings: site.requiredTrainings minus the officer's
 *   unexpired (or no-expiry) training types.
 * - expiringSoon: unexpired certs whose expiry is within 30 days.
 */
async function computeOfficerCompliance(employeeId: string, requiredTrainings: string[]) {
  const today = sql`current_date`;
  const licRows = await db
    .select({ level: licensesTable.level, expiryDate: licensesTable.expiryDate })
    .from(licensesTable)
    .where(and(eq(licensesTable.employeeId, employeeId), gte(licensesTable.expiryDate, today)));
  let maxLevel: number | null = null;
  for (const l of licRows) if (l.level != null && (maxLevel == null || l.level > maxLevel)) maxLevel = l.level;

  const certs = await db
    .select({
      id: trainingCertificationsTable.id,
      type: trainingCertificationsTable.type,
      title: trainingCertificationsTable.title,
      expiryDate: trainingCertificationsTable.expiryDate,
    })
    .from(trainingCertificationsTable)
    .where(and(
      eq(trainingCertificationsTable.employeeId, employeeId),
      // Either no expiry (perpetual) OR not yet expired.
      or(
        sql`${trainingCertificationsTable.expiryDate} IS NULL`,
        gte(trainingCertificationsTable.expiryDate, today),
      ),
    ));
  const heldTypes = new Set(certs.map((c) => c.type));
  const missing = requiredTrainings.filter((t) => !heldTypes.has(t));

  const horizon = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const expiringSoon = certs
    .filter((c) => c.expiryDate && c.expiryDate <= horizon)
    .map((c) => ({ id: c.id, type: c.type, title: c.title, expiryDate: c.expiryDate }));

  return { maxLicenseLevel: maxLevel, heldTrainings: [...heldTypes], missingTrainings: missing, expiringSoon };
}

router.get("/me/compliance", requireAuth, async (req, res): Promise<void> => {
  const siteParse = z.object({ siteId: z.string().uuid().optional() }).safeParse(req.query);
  if (!siteParse.success) { res.status(400).json({ error: "Bad Request", issues: siteParse.error.issues }); return; }
  let requiredTrainings: string[] = [];
  let siteName: string | null = null;
  if (siteParse.data.siteId) {
    const [s] = await db
      .select({ name: sitesTable.name, req: sitesTable.requiredTrainings })
      .from(sitesTable)
      .where(eq(sitesTable.id, siteParse.data.siteId))
      .limit(1);
    if (!s) { res.status(404).json({ error: "Not Found" }); return; }
    siteName = s.name;
    requiredTrainings = Array.isArray(s.req) ? s.req : [];
  }
  const c = await computeOfficerCompliance(req.user!.userId, requiredTrainings);
  res.json({ siteId: siteParse.data.siteId ?? null, siteName, requiredTrainings, ...c });
});

router.get("/admin/compliance", requireAdmin, async (req, res): Promise<void> => {
  const parse = z.object({ siteId: z.string().uuid().optional() }).safeParse(req.query);
  if (!parse.success) { res.status(400).json({ error: "Bad Request", issues: parse.error.issues }); return; }

  let requiredTrainings: string[] = [];
  let siteName: string | null = null;
  if (parse.data.siteId) {
    const [s] = await db
      .select({ name: sitesTable.name, req: sitesTable.requiredTrainings })
      .from(sitesTable)
      .where(eq(sitesTable.id, parse.data.siteId))
      .limit(1);
    if (!s) { res.status(404).json({ error: "Not Found" }); return; }
    siteName = s.name;
    requiredTrainings = Array.isArray(s.req) ? s.req : [];
  }

  const officers = await db
    .select({
      id: usersTable.id,
      firstName: usersTable.firstName,
      lastName: usersTable.lastName,
      email: usersTable.email,
    })
    .from(usersTable)
    .where(and(inArray(usersTable.role, [...WORKER_ROLES]), eq(usersTable.status, "active")));

  if (officers.length === 0) {
    res.json({ siteId: parse.data.siteId ?? null, siteName, requiredTrainings, officers: [] });
    return;
  }

  // Batch the cert+license lookups so we don't fan out N round-trips per
  // officer on large rosters.
  const ids = officers.map((o) => o.id);
  const allCerts = await db
    .select({ employeeId: trainingCertificationsTable.employeeId, type: trainingCertificationsTable.type, expiryDate: trainingCertificationsTable.expiryDate, title: trainingCertificationsTable.title, id: trainingCertificationsTable.id })
    .from(trainingCertificationsTable)
    .where(and(
      inArray(trainingCertificationsTable.employeeId, ids),
      or(
        sql`${trainingCertificationsTable.expiryDate} IS NULL`,
        gte(trainingCertificationsTable.expiryDate, sql`current_date`),
      ),
    ));
  const allLics = await db
    .select({ employeeId: licensesTable.employeeId, level: licensesTable.level })
    .from(licensesTable)
    .where(and(
      inArray(licensesTable.employeeId, ids),
      gte(licensesTable.expiryDate, sql`current_date`),
    ));

  const certsByOfficer = new Map<string, typeof allCerts>();
  for (const c of allCerts) {
    const arr = certsByOfficer.get(c.employeeId) ?? [];
    arr.push(c);
    certsByOfficer.set(c.employeeId, arr);
  }
  const maxLevelByOfficer = new Map<string, number>();
  for (const l of allLics) {
    if (l.level == null) continue;
    const cur = maxLevelByOfficer.get(l.employeeId) ?? 0;
    if (l.level > cur) maxLevelByOfficer.set(l.employeeId, l.level);
  }

  const horizon = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const result = officers.map((o) => {
    const certs = certsByOfficer.get(o.id) ?? [];
    const held = new Set(certs.map((c) => c.type));
    const missing = requiredTrainings.filter((t) => !held.has(t));
    const expiringSoon = certs
      .filter((c) => c.expiryDate && c.expiryDate <= horizon)
      .map((c) => ({ id: c.id, type: c.type, title: c.title, expiryDate: c.expiryDate }));
    const maxLicenseLevel = maxLevelByOfficer.get(o.id) ?? null;
    // An officer can't be "compliant" without a valid (unexpired) license
    // on file — otherwise officers with no license info at all were showing
    // green when no site (or a no-training-requirement site) was selected.
    return {
      employeeId: o.id,
      employeeName: [o.firstName, o.lastName].filter(Boolean).join(" ") || o.email,
      employeeEmail: o.email,
      maxLicenseLevel,
      heldTrainings: [...held],
      missingTrainings: missing,
      expiringSoon,
      compliant: maxLicenseLevel != null && missing.length === 0,
    };
  });

  // Stable sort: non-compliant first, then alphabetical.
  result.sort((a, b) => {
    if (a.compliant !== b.compliant) return a.compliant ? 1 : -1;
    return a.employeeName.localeCompare(b.employeeName);
  });

  res.json({ siteId: parse.data.siteId ?? null, siteName, requiredTrainings, officers: result });
});

export default router;
