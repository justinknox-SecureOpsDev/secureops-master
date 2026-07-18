import { Router, type IRouter } from "express";
import { z } from "zod/v4";
import { and, eq, gte, lte, desc, isNull, sql } from "drizzle-orm";
import crypto from "crypto";
import {
  db,
  patrolCheckpointsTable,
  patrolScansTable,
  sitesTable,
  usersTable,
  timeEntriesTable,
  clientsTable,
} from "@workspace/db";
import { requireAuth, requireAdmin } from "../middlewares/auth";
import { requireFeature } from "../lib/features";

const router: IRouter = Router();
router.use(["/admin/sites", "/admin/checkpoints", "/admin/patrol", "/patrol", "/me/patrol"], requireFeature("patrol"));

// Generate a human-readable 10-char Crockford-base32 code, e.g. "X7Q3K2HR9F".
// 0/O/1/I/L excluded for the same reasons as the invite-password generator.
const ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
function generateCode(): string {
  let out = "";
  const buf = crypto.randomBytes(10);
  for (let i = 0; i < 10; i++) out += ALPHABET[buf[i] % ALPHABET.length];
  return out;
}

const createCheckpointSchema = z.object({
  label: z.string().trim().min(1).max(120),
});

const patchCheckpointSchema = z.object({
  label: z.string().trim().min(1).max(120).optional(),
  isActive: z.boolean().optional(),
});

const scanSchema = z.object({
  code: z.string().trim().min(1).max(64),
  lat: z.number().finite().optional(),
  lng: z.number().finite().optional(),
});

// ---------- Admin: checkpoint CRUD ----------

router.get("/admin/sites/:siteId/checkpoints", requireAuth, requireAdmin, async (req, res): Promise<void> => {
  const siteId = String(req.params.siteId);
  const [site] = await db.select({ id: sitesTable.id }).from(sitesTable).where(eq(sitesTable.id, siteId));
  if (!site) { res.status(404).json({ error: "Not Found", message: "Site not found" }); return; }
  const rows = await db
    .select()
    .from(patrolCheckpointsTable)
    .where(eq(patrolCheckpointsTable.siteId, siteId))
    .orderBy(desc(patrolCheckpointsTable.createdAt));
  res.json({ checkpoints: rows });
});

router.post("/admin/sites/:siteId/checkpoints", requireAuth, requireAdmin, async (req, res): Promise<void> => {
  const siteId = String(req.params.siteId);
  const parsed = createCheckpointSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Bad Request", issues: parsed.error.issues });
    return;
  }
  const [site] = await db.select({ id: sitesTable.id }).from(sitesTable).where(eq(sitesTable.id, siteId));
  if (!site) { res.status(404).json({ error: "Not Found", message: "Site not found" }); return; }

  // Retry on the astronomically-unlikely code collision.
  let inserted: typeof patrolCheckpointsTable.$inferSelect | undefined;
  for (let i = 0; i < 5; i++) {
    const code = generateCode();
    try {
      const [row] = await db.insert(patrolCheckpointsTable).values({
        siteId,
        label: parsed.data.label,
        code,
        createdBy: req.user!.userId,
      }).returning();
      inserted = row;
      break;
    } catch (e: any) {
      if (e?.code === "23505") continue; // unique violation on code — retry
      throw e;
    }
  }
  if (!inserted) {
    res.status(500).json({ error: "Internal", message: "Could not allocate checkpoint code" });
    return;
  }
  res.status(201).json(inserted);
});

router.patch("/admin/checkpoints/:id", requireAuth, requireAdmin, async (req, res): Promise<void> => {
  const id = String(req.params.id);
  const parsed = patchCheckpointSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Bad Request", issues: parsed.error.issues });
    return;
  }
  if (Object.keys(parsed.data).length === 0) {
    res.status(400).json({ error: "Bad Request", message: "No fields to update" });
    return;
  }
  const [updated] = await db.update(patrolCheckpointsTable)
    .set(parsed.data)
    .where(eq(patrolCheckpointsTable.id, id))
    .returning();
  if (!updated) { res.status(404).json({ error: "Not Found", message: "Checkpoint not found" }); return; }
  res.json(updated);
});

router.delete("/admin/checkpoints/:id", requireAuth, requireAdmin, async (req, res): Promise<void> => {
  const id = String(req.params.id);
  const [deleted] = await db.delete(patrolCheckpointsTable)
    .where(eq(patrolCheckpointsTable.id, id))
    .returning({ id: patrolCheckpointsTable.id });
  if (!deleted) { res.status(404).json({ error: "Not Found", message: "Checkpoint not found" }); return; }
  res.sendStatus(204);
});

// ---------- Admin: scan log ----------

router.get("/admin/patrol/scans", requireAuth, requireAdmin, async (req, res): Promise<void> => {
  const siteId = typeof req.query.siteId === "string" ? req.query.siteId : undefined;
  const userId = typeof req.query.userId === "string" ? req.query.userId : undefined;
  const fromStr = typeof req.query.from === "string" ? req.query.from : undefined;
  const toStr = typeof req.query.to === "string" ? req.query.to : undefined;
  const limit = Math.min(Math.max(Number(req.query.limit) || 200, 1), 1000);

  const conditions = [] as any[];
  if (siteId) conditions.push(eq(patrolScansTable.siteId, siteId));
  if (userId) conditions.push(eq(patrolScansTable.userId, userId));
  if (fromStr) {
    const d = new Date(fromStr);
    if (!isNaN(d.getTime())) conditions.push(gte(patrolScansTable.scannedAt, d));
  }
  if (toStr) {
    const d = new Date(toStr);
    if (!isNaN(d.getTime())) conditions.push(lte(patrolScansTable.scannedAt, d));
  }

  const rows = await db
    .select({
      id: patrolScansTable.id,
      scannedAt: patrolScansTable.scannedAt,
      lat: patrolScansTable.lat,
      lng: patrolScansTable.lng,
      checkpointId: patrolScansTable.checkpointId,
      checkpointLabel: patrolCheckpointsTable.label,
      siteId: patrolScansTable.siteId,
      siteName: sitesTable.name,
      userId: patrolScansTable.userId,
      firstName: usersTable.firstName,
      lastName: usersTable.lastName,
    })
    .from(patrolScansTable)
    .leftJoin(patrolCheckpointsTable, eq(patrolScansTable.checkpointId, patrolCheckpointsTable.id))
    .leftJoin(sitesTable, eq(patrolScansTable.siteId, sitesTable.id))
    .leftJoin(usersTable, eq(patrolScansTable.userId, usersTable.id))
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(patrolScansTable.scannedAt))
    .limit(limit);

  res.json({ scans: rows });
});

// ---------- Officer: scan ----------

router.post("/patrol/scan", requireAuth, async (req, res): Promise<void> => {
  // Patrol compliance logs must only contain officer activity — block other roles
  // (incl. admins) so they can't pollute the audit trail.
  if (req.user?.role !== "employee") {
    res.status(403).json({ error: "Forbidden", message: "Only employees can log patrol scans" });
    return;
  }
  const parsed = scanSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Bad Request", issues: parsed.error.issues });
    return;
  }
  const userId = req.user!.userId;
  // Normalize: accept the code in any case, strip whitespace.
  const code = parsed.data.code.replace(/\s+/g, "").toUpperCase();

  const [checkpoint] = await db
    .select({
      id: patrolCheckpointsTable.id,
      siteId: patrolCheckpointsTable.siteId,
      label: patrolCheckpointsTable.label,
      isActive: patrolCheckpointsTable.isActive,
      siteName: sitesTable.name,
    })
    .from(patrolCheckpointsTable)
    .leftJoin(sitesTable, eq(patrolCheckpointsTable.siteId, sitesTable.id))
    .where(eq(patrolCheckpointsTable.code, code))
    .limit(1);

  if (!checkpoint) {
    res.status(404).json({ error: "Not Found", message: "Unknown checkpoint code" });
    return;
  }
  if (!checkpoint.isActive) {
    res.status(410).json({ error: "Gone", message: "This checkpoint is no longer active" });
    return;
  }

  // Find the officer's currently-active time entry (if any) — newest open one.
  const [active] = await db
    .select({ id: timeEntriesTable.id, siteId: timeEntriesTable.siteId })
    .from(timeEntriesTable)
    .where(and(eq(timeEntriesTable.employeeId, userId), isNull(timeEntriesTable.clockOutTime)))
    .orderBy(desc(timeEntriesTable.clockInTime))
    .limit(1);

  const wrongSite = !!(active && active.siteId && active.siteId !== checkpoint.siteId);

  const [scan] = await db.insert(patrolScansTable).values({
    checkpointId: checkpoint.id,
    siteId: checkpoint.siteId,
    userId,
    timeEntryId: active?.id ?? null,
    lat: parsed.data.lat != null ? String(parsed.data.lat) : null,
    lng: parsed.data.lng != null ? String(parsed.data.lng) : null,
  }).returning();

  res.status(201).json({
    scan,
    checkpoint: { id: checkpoint.id, label: checkpoint.label, siteId: checkpoint.siteId, siteName: checkpoint.siteName },
    onShift: !!active,
    wrongSite,
  });
});

// ---------- Officer: own recent scans ----------

router.get("/me/patrol/recent", requireAuth, async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  const rows = await db
    .select({
      id: patrolScansTable.id,
      scannedAt: patrolScansTable.scannedAt,
      checkpointLabel: patrolCheckpointsTable.label,
      siteName: sitesTable.name,
    })
    .from(patrolScansTable)
    .leftJoin(patrolCheckpointsTable, eq(patrolScansTable.checkpointId, patrolCheckpointsTable.id))
    .leftJoin(sitesTable, eq(patrolScansTable.siteId, sitesTable.id))
    .where(eq(patrolScansTable.userId, userId))
    .orderBy(desc(patrolScansTable.scannedAt))
    .limit(50);
  res.json({ scans: rows });
});

// Suppress unused-import lint for clientsTable / sql (kept for future extensions).
void clientsTable; void sql;

export default router;
