import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import { z } from "zod/v4";
import { and, eq, gte, lt, sql, inArray } from "drizzle-orm";
import {
  db,
  officerAvailabilityWindowsTable,
  employeesTable,
  shiftsTable,
  shiftAssignmentsTable,
  sitesTable,
} from "@workspace/db";
import { requireAuth } from "../middlewares/auth";
import { getEffectiveLevel } from "../lib/eligibility";
import { resolvePayRate } from "../lib/payRate";
import { requireFeature } from "../lib/features";

const router: IRouter = Router();
router.use(["/me/availability", "/me/suggested-shifts"], requireFeature("availability"));

// ---------- shared helpers ----------

const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const hhmmToMin = (s: string): number => {
  const [h, m] = s.split(":").map(Number);
  return h * 60 + m;
};
const dateToHHMM = (d: Date): string =>
  `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;

const windowSchema = z.object({
  dayOfWeek: z.number().int().min(0).max(6),
  startTime: z.string().regex(HHMM_RE),
  endTime: z.string().regex(HHMM_RE),
}).refine((w) => hhmmToMin(w.endTime) > hhmmToMin(w.startTime), {
  message: "endTime must be after startTime (overnight windows: split into two days)",
});

const putBodySchema = z.object({
  windows: z.array(windowSchema).max(50),
  maxWeeklyHours: z.number().int().min(0).max(168).nullable().optional(),
});

// ISO week key "YYYY-Wnn" computed from a UTC Date.
function isoWeekKey(d: Date): string {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const wk = Math.ceil((((t.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(wk).padStart(2, "0")}`;
}

/**
 * Decompose a shift's [start,end] interval into one or two per-UTC-day segments
 * the windows can be matched against. Returns null if shift > 24h (out of scope
 * for this v1 matcher).
 *
 *   same-day:           [{ dow, startMin, endMin }]
 *   crosses midnight:   [{ dow, startMin, 1440 }, { (dow+1)%7, 0, endMinNextDay }]
 */
function shiftSegments(start: Date, end: Date): { dow: number; startMin: number; endMin: number }[] | null {
  const durationMs = end.getTime() - start.getTime();
  if (durationMs <= 0 || durationMs > 24 * 60 * 60 * 1000) return null;
  const startDow = start.getUTCDay();
  const startMin = hhmmToMin(dateToHHMM(start));
  const endMinSameDay = startMin + Math.round(durationMs / 60000);
  if (endMinSameDay <= 1440) {
    return [{ dow: startDow, startMin, endMin: endMinSameDay }];
  }
  // Crosses UTC midnight.
  return [
    { dow: startDow, startMin, endMin: 1440 },
    { dow: (startDow + 1) % 7, startMin: 0, endMin: endMinSameDay - 1440 },
  ];
}

// Employee-role gate. The availability surface only makes sense for the
// officer-facing app — admins / pending users have no business writing
// employees rows or being suggested shifts.
function requireEmployee(req: Request, res: Response, next: NextFunction): void {
  if (req.user?.role !== "employee") {
    res.status(403).json({ error: "Forbidden", message: "Employee role required" });
    return;
  }
  next();
}

// ---------- GET /me/availability ----------
router.get("/me/availability", requireAuth, requireEmployee, async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  const [windows, employee] = await Promise.all([
    db.select({
      id: officerAvailabilityWindowsTable.id,
      dayOfWeek: officerAvailabilityWindowsTable.dayOfWeek,
      startTime: officerAvailabilityWindowsTable.startTime,
      endTime: officerAvailabilityWindowsTable.endTime,
    })
      .from(officerAvailabilityWindowsTable)
      .where(eq(officerAvailabilityWindowsTable.userId, userId)),
    db.select({ maxWeeklyHours: employeesTable.maxWeeklyHours })
      .from(employeesTable)
      .where(eq(employeesTable.userId, userId))
      .limit(1),
  ]);
  res.json({
    windows: windows.sort((a, b) =>
      a.dayOfWeek - b.dayOfWeek || hhmmToMin(a.startTime) - hhmmToMin(b.startTime)),
    maxWeeklyHours: employee[0]?.maxWeeklyHours ?? null,
  });
});

// ---------- PUT /me/availability (replace-all) ----------
router.put("/me/availability", requireAuth, requireEmployee, async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  const parsed = putBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Bad Request", issues: parsed.error.issues });
    return;
  }
  const { windows, maxWeeklyHours } = parsed.data;

  await db.transaction(async (tx) => {
    await tx.delete(officerAvailabilityWindowsTable)
      .where(eq(officerAvailabilityWindowsTable.userId, userId));
    if (windows.length > 0) {
      await tx.insert(officerAvailabilityWindowsTable).values(
        windows.map((w) => ({
          userId,
          dayOfWeek: w.dayOfWeek,
          startTime: w.startTime,
          endTime: w.endTime,
        })),
      );
    }
    if (maxWeeklyHours !== undefined) {
      // Real upsert: relies on the UNIQUE (user_id) constraint on employees.
      // ON CONFLICT lets two concurrent requests serialize at the DB without
      // creating duplicate employee rows.
      await tx.insert(employeesTable)
        .values({ userId, maxWeeklyHours })
        .onConflictDoUpdate({
          target: employeesTable.userId,
          set: { maxWeeklyHours },
        });
    }
  });

  res.json({ ok: true });
});

// ---------- GET /me/suggested-shifts ----------
//
// Returns upcoming open shifts (next 14 days, status=upcoming, filled<headcount)
// where:
//   - officer's max license level covers shift.requiredLicenseLevel
//   - every shift segment (same-day OR both halves of an overnight shift) is
//     fully covered by at least one availability window for its UTC day-of-week
//   - if maxWeeklyHours is set, claiming the shift would NOT push the
//     officer's already-ACCEPTED hours for that ISO week over the cap.
router.get("/me/suggested-shifts", requireAuth, requireEmployee, async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  const now = new Date();
  const horizon = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);

  const [windows, empRows, myLevel] = await Promise.all([
    db.select({
      dayOfWeek: officerAvailabilityWindowsTable.dayOfWeek,
      startTime: officerAvailabilityWindowsTable.startTime,
      endTime: officerAvailabilityWindowsTable.endTime,
    })
      .from(officerAvailabilityWindowsTable)
      .where(eq(officerAvailabilityWindowsTable.userId, userId)),
    db.select({ maxWeeklyHours: employeesTable.maxWeeklyHours, hourlyRate: employeesTable.hourlyRate })
      .from(employeesTable)
      .where(eq(employeesTable.userId, userId))
      .limit(1),
    getEffectiveLevel(userId),
  ]);

  if (windows.length === 0) { res.json({ shifts: [], reason: "no_windows" }); return; }
  const maxWeekly = empRows[0]?.maxWeeklyHours ?? null;
  // Officer-facing rate parity: the "$X/hr" on a suggested shift must be the
  // rate this officer would actually be paid — the shared payroll resolver
  // (profile hourlyRate > shift rate, zero = not set, holiday-adjusted).
  const myProfileRate = empRows[0]?.hourlyRate ?? null;

  // Index windows by dow for fast lookup.
  const windowsByDow = new Map<number, { startMin: number; endMin: number }[]>();
  for (const w of windows) {
    const list = windowsByDow.get(w.dayOfWeek) ?? [];
    list.push({ startMin: hhmmToMin(w.startTime), endMin: hhmmToMin(w.endTime) });
    windowsByDow.set(w.dayOfWeek, list);
  }

  // Candidate shifts: upcoming, in horizon, not yet at headcount.
  const candidates = await db
    .select({
      id: shiftsTable.id,
      title: shiftsTable.title,
      startTime: shiftsTable.startTime,
      endTime: shiftsTable.endTime,
      payRate: shiftsTable.payRate,
      requiredLicenseLevel: shiftsTable.requiredLicenseLevel,
      headcount: shiftsTable.headcount,
      siteName: sitesTable.name,
      siteAddress: sitesTable.address,
      filled: sql<number>`COALESCE((
        SELECT COUNT(*)::int FROM shift_assignments sa WHERE sa.shift_id = ${shiftsTable.id}
      ), 0)`,
    })
    .from(shiftsTable)
    .leftJoin(sitesTable, eq(shiftsTable.siteId, sitesTable.id))
    .where(and(
      eq(shiftsTable.status, "upcoming"),
      gte(shiftsTable.startTime, now),
      lt(shiftsTable.startTime, horizon),
    ));

  // Pre-compute per-ISO-week ACCEPTED hours already committed by this officer
  // in the horizon. Pending/declined are excluded — only confirmed work counts
  // against maxWeeklyHours.
  const horizonAssignments = await db
    .select({
      start: shiftsTable.startTime,
      end: shiftsTable.endTime,
    })
    .from(shiftAssignmentsTable)
    .innerJoin(shiftsTable, eq(shiftAssignmentsTable.shiftId, shiftsTable.id))
    .where(and(
      eq(shiftAssignmentsTable.employeeId, userId),
      eq(shiftAssignmentsTable.status, "accepted"),
      gte(shiftsTable.startTime, now),
      lt(shiftsTable.startTime, horizon),
    ));
  const weekHours = new Map<string, number>();
  for (const a of horizonAssignments) {
    const hrs = (a.end.getTime() - a.start.getTime()) / 36e5;
    const k = isoWeekKey(a.start);
    weekHours.set(k, (weekHours.get(k) ?? 0) + hrs);
  }

  const matches: typeof candidates = [];
  for (const s of candidates) {
    if (Number(s.filled) >= s.headcount) continue;
    if (myLevel < s.requiredLicenseLevel) continue;

    const segments = shiftSegments(s.startTime, s.endTime);
    if (!segments) continue; // unsupported (negative or >24h)

    const allCovered = segments.every((seg) => {
      const dayWindows = windowsByDow.get(seg.dow);
      if (!dayWindows) return false;
      return dayWindows.some((w) => w.startMin <= seg.startMin && w.endMin >= seg.endMin);
    });
    if (!allCovered) continue;

    if (maxWeekly != null) {
      const k = isoWeekKey(s.startTime);
      const shiftHours = (s.endTime.getTime() - s.startTime.getTime()) / 36e5;
      const current = weekHours.get(k) ?? 0;
      if (current + shiftHours > maxWeekly) continue;
    }

    matches.push(s);
  }

  matches.sort((a, b) => a.startTime.getTime() - b.startTime.getTime());
  res.json({
    shifts: matches.slice(0, 50).map((s) => {
      const r = resolvePayRate({ profileRate: myProfileRate, shiftRate: s.payRate, clockInTime: s.startTime });
      return r.source !== "none" ? { ...s, payRate: String(r.effectiveRate) } : s;
    }),
    maxWeeklyHours: maxWeekly,
  });
});

export default router;
