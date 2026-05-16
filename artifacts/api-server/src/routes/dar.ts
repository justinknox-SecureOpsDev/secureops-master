import { Router, type IRouter } from "express";
import { z } from "zod/v4";
import { and, eq, gte, lte, desc, isNull, sql } from "drizzle-orm";
import {
  db,
  dailyActivityReportsTable,
  sitesTable,
  shiftsTable,
  timeEntriesTable,
  usersTable,
} from "@workspace/db";
import { requireAuth, requireAdmin } from "../middlewares/auth";
import { darWriteLimiter } from "../middlewares/rateLimit";

const router: IRouter = Router();

const submitSchema = z.object({
  // Caller may pin the report to a specific owned time_entry; site and
  // shift are ALWAYS derived server-side from that time_entry (or the
  // latest one) — never trusted from the body — so officers can't attach
  // a DAR to a site they never worked.
  timeEntryId: z.string().uuid().nullish(),
  reportDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  summary: z.string().trim().min(10).max(8000),
  observations: z.string().trim().max(8000).optional().nullable(),
  visitorsCount: z.number().int().min(0).max(10000).optional(),
  patrolsCount: z.number().int().min(0).max(10000).optional(),
  incidentsNoted: z.string().trim().max(4000).optional().nullable(),
  weather: z.string().trim().max(200).optional().nullable(),
  signature: z.string().trim().min(1).max(120),
});

function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

// ---------- Officer: submit ----------

router.post("/me/dar", requireAuth, darWriteLimiter, async (req, res): Promise<void> => {
  if (req.user?.role !== "employee") {
    res.status(403).json({ error: "Forbidden", message: "Only employees can submit DARs" });
    return;
  }
  const parsed = submitSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Bad Request", issues: parsed.error.issues });
    return;
  }
  const userId = req.user!.userId;
  const body = parsed.data;

  // Server is authoritative for site/shift context. If caller pinned a
  // specific timeEntryId, verify ownership and use ITS site/shift. Else,
  // resolve the officer's most-recent time_entry (active or closed).
  let siteId: string | null = null;
  let shiftId: string | null = null;
  let timeEntryId: string | null = null;
  if (body.timeEntryId) {
    const [owned] = await db
      .select({ id: timeEntriesTable.id, siteId: timeEntriesTable.siteId, shiftId: timeEntriesTable.shiftId })
      .from(timeEntriesTable)
      .where(and(eq(timeEntriesTable.id, body.timeEntryId), eq(timeEntriesTable.employeeId, userId)))
      .limit(1);
    if (!owned) {
      res.status(403).json({ error: "Forbidden", message: "Time entry does not belong to caller" });
      return;
    }
    timeEntryId = owned.id;
    siteId = owned.siteId ?? null;
    shiftId = owned.shiftId ?? null;
  } else {
    const [recent] = await db
      .select({ id: timeEntriesTable.id, siteId: timeEntriesTable.siteId, shiftId: timeEntriesTable.shiftId })
      .from(timeEntriesTable)
      .where(eq(timeEntriesTable.employeeId, userId))
      .orderBy(desc(timeEntriesTable.clockInTime))
      .limit(1);
    if (recent) {
      timeEntryId = recent.id;
      siteId = recent.siteId ?? null;
      shiftId = recent.shiftId ?? null;
    }
  }

  const [row] = await db.insert(dailyActivityReportsTable).values({
    employeeId: userId,
    siteId,
    shiftId,
    timeEntryId,
    reportDate: body.reportDate ?? todayIsoDate(),
    summary: body.summary,
    observations: body.observations ?? null,
    visitorsCount: body.visitorsCount ?? 0,
    patrolsCount: body.patrolsCount ?? 0,
    incidentsNoted: body.incidentsNoted ?? null,
    weather: body.weather ?? null,
    signature: body.signature,
  }).returning();

  res.status(201).json(row);
});

// ---------- Officer: own list / detail ----------

router.get("/me/dar", requireAuth, async (req, res): Promise<void> => {
  if (req.user?.role !== "employee") {
    res.status(403).json({ error: "Forbidden", message: "Only employees can read this" });
    return;
  }
  const userId = req.user!.userId;
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
  const rows = await db
    .select({
      id: dailyActivityReportsTable.id,
      reportDate: dailyActivityReportsTable.reportDate,
      submittedAt: dailyActivityReportsTable.submittedAt,
      summary: dailyActivityReportsTable.summary,
      visitorsCount: dailyActivityReportsTable.visitorsCount,
      patrolsCount: dailyActivityReportsTable.patrolsCount,
      siteName: sitesTable.name,
    })
    .from(dailyActivityReportsTable)
    .leftJoin(sitesTable, eq(dailyActivityReportsTable.siteId, sitesTable.id))
    .where(eq(dailyActivityReportsTable.employeeId, userId))
    .orderBy(desc(dailyActivityReportsTable.submittedAt))
    .limit(limit);
  res.json({ reports: rows });
});

router.get("/me/dar/:id", requireAuth, async (req, res): Promise<void> => {
  if (req.user?.role !== "employee") {
    res.status(403).json({ error: "Forbidden", message: "Only employees can read this" });
    return;
  }
  const idParse = z.string().uuid().safeParse(req.params.id);
  if (!idParse.success) { res.status(400).json({ error: "Bad Request", message: "Invalid id" }); return; }
  const userId = req.user!.userId;
  const [row] = await db
    .select()
    .from(dailyActivityReportsTable)
    .where(and(
      eq(dailyActivityReportsTable.id, idParse.data),
      eq(dailyActivityReportsTable.employeeId, userId),
    ))
    .limit(1);
  if (!row) { res.status(404).json({ error: "Not Found" }); return; }
  res.json(row);
});

// ---------- Admin: feed / detail ----------

const adminListQuery = z.object({
  employeeId: z.string().uuid().optional(),
  siteId: z.string().uuid().optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

router.get("/admin/dar", requireAuth, requireAdmin, async (req, res): Promise<void> => {
  const q = adminListQuery.safeParse(req.query);
  if (!q.success) { res.status(400).json({ error: "Bad Request", issues: q.error.issues }); return; }
  const { employeeId, siteId, from: fromStr, to: toStr } = q.data;
  const limit = q.data.limit ?? 100;

  const conditions: any[] = [];
  if (employeeId) conditions.push(eq(dailyActivityReportsTable.employeeId, employeeId));
  if (siteId) conditions.push(eq(dailyActivityReportsTable.siteId, siteId));
  if (fromStr) conditions.push(gte(dailyActivityReportsTable.reportDate, fromStr));
  if (toStr) conditions.push(lte(dailyActivityReportsTable.reportDate, toStr));

  const rows = await db
    .select({
      id: dailyActivityReportsTable.id,
      reportDate: dailyActivityReportsTable.reportDate,
      submittedAt: dailyActivityReportsTable.submittedAt,
      summary: dailyActivityReportsTable.summary,
      visitorsCount: dailyActivityReportsTable.visitorsCount,
      patrolsCount: dailyActivityReportsTable.patrolsCount,
      employeeId: dailyActivityReportsTable.employeeId,
      firstName: usersTable.firstName,
      lastName: usersTable.lastName,
      siteId: dailyActivityReportsTable.siteId,
      siteName: sitesTable.name,
    })
    .from(dailyActivityReportsTable)
    .leftJoin(usersTable, eq(dailyActivityReportsTable.employeeId, usersTable.id))
    .leftJoin(sitesTable, eq(dailyActivityReportsTable.siteId, sitesTable.id))
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(dailyActivityReportsTable.submittedAt))
    .limit(limit);

  res.json({ reports: rows });
});

router.get("/admin/dar/:id", requireAuth, requireAdmin, async (req, res): Promise<void> => {
  const idParse = z.string().uuid().safeParse(req.params.id);
  if (!idParse.success) { res.status(400).json({ error: "Bad Request", message: "Invalid id" }); return; }
  const [row] = await db
    .select({
      dar: dailyActivityReportsTable,
      siteName: sitesTable.name,
      firstName: usersTable.firstName,
      lastName: usersTable.lastName,
      email: usersTable.email,
      shiftTitle: shiftsTable.title,
      shiftStart: shiftsTable.startTime,
      shiftEnd: shiftsTable.endTime,
    })
    .from(dailyActivityReportsTable)
    .leftJoin(sitesTable, eq(dailyActivityReportsTable.siteId, sitesTable.id))
    .leftJoin(usersTable, eq(dailyActivityReportsTable.employeeId, usersTable.id))
    .leftJoin(shiftsTable, eq(dailyActivityReportsTable.shiftId, shiftsTable.id))
    .where(eq(dailyActivityReportsTable.id, idParse.data))
    .limit(1);
  if (!row) { res.status(404).json({ error: "Not Found" }); return; }
  res.json(row);
});

void isNull; void sql;
export default router;
