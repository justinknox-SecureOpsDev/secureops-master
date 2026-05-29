import { Router, type IRouter } from "express";
import { randomUUID } from "node:crypto";
import { eq, and, gt, gte, lt, lte, ne, sql, or, isNull, inArray } from "drizzle-orm";
import { db, shiftsTable, shiftAssignmentsTable, usersTable, licensesTable, sitesTable, clientsTable, trainingCertificationsTable, employeesTable } from "@workspace/db";
import { requireAuth, requireAdmin, requireAdminOrDispatcher } from "../middlewares/auth";
import { haversineMiles } from "../lib/geofence";
import { getEffectiveLevel, effectiveLevelSql } from "../lib/eligibility";

const router: IRouter = Router();

// Returns the offset (ms ahead of UTC) that `tz` was actually using at the
// given UTC instant. e.g. America/Chicago in winter → -6h, in summer → -5h.
function tzOffsetAt(utcMs: number, tz: string): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  });
  const parts: Record<string, string> = {};
  for (const p of dtf.formatToParts(new Date(utcMs))) parts[p.type] = p.value;
  const localAsUtc = Date.UTC(
    Number(parts.year), Number(parts.month) - 1, Number(parts.day),
    Number(parts.hour) % 24, Number(parts.minute), Number(parts.second),
  );
  return localAsUtc - utcMs;
}

// Convert a wall-clock time (Y/M/D h:m) in `tz` (IANA, e.g. "America/Chicago")
// into the correct UTC instant. DST-safe: iterates once so the offset is read
// at the resolved instant, not the naive guess. For nonexistent/ambiguous wall
// times during DST transitions this resolves consistently (no throw).
function wallTimeToUtc(year: number, month1to12: number, day: number, hour: number, minute: number, tz: string): Date {
  const naiveUtc = Date.UTC(year, month1to12 - 1, day, hour, minute, 0);
  try {
    let offset = tzOffsetAt(naiveUtc, tz);
    // Re-evaluate offset at the *target* instant (handles DST boundary crossing).
    offset = tzOffsetAt(naiveUtc - offset, tz);
    return new Date(naiveUtc - offset);
  } catch {
    return new Date(naiveUtc);
  }
}

// Returns YYYY-MM-DD as observed in `tz` for a given UTC instant.
function localDateInTz(utcMs: number, tz: string): string {
  try {
    const dtf = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
    });
    return dtf.format(new Date(utcMs)); // en-CA → "YYYY-MM-DD"
  } catch {
    return new Date(utcMs).toISOString().slice(0, 10);
  }
}

/** Short label for a shift's required level used in push/SMS copy. */
function shiftLevelLabel(lvl: number): string {
  if (lvl <= 1) return "Support";
  if (lvl === 4) return "L4/PPO";
  return `L${lvl}+`;
}

/**
 * Slugs of training-certification types the officer currently holds with
 * either no expiry (perpetual) or an unexpired expiry. Used to enforce
 * site.requiredTrainings on shift visibility/claim.
 */
async function getEmployeeHeldTrainings(employeeId: string): Promise<Set<string>> {
  const rows = await db
    .select({ type: trainingCertificationsTable.type })
    .from(trainingCertificationsTable)
    .where(and(
      eq(trainingCertificationsTable.employeeId, employeeId),
      or(
        sql`${trainingCertificationsTable.expiryDate} IS NULL`,
        gte(trainingCertificationsTable.expiryDate, sql`current_date`),
      ),
    ));
  return new Set(rows.map((r) => r.type));
}

router.get("/shifts", requireAuth, async (req, res): Promise<void> => {
  const { status, employeeId, from, to } = req.query as { status?: string; employeeId?: string; from?: string; to?: string };
  // Dispatchers get the same full read as admins (they need to see
  // every shift to assign/notify). Employees stay scoped to their own
  // assigned + qualifying-open shifts.
  const isAdmin = req.user!.role === "admin" || req.user!.role === "dispatcher";
  const userId = req.user!.userId;

  const conditions = [];
  if (status) conditions.push(eq(shiftsTable.status, status));
  if (from) conditions.push(gte(shiftsTable.startTime, new Date(from)));
  if (to) conditions.push(lte(shiftsTable.startTime, new Date(to)));
  // When the caller asks for "upcoming" shifts, exclude any whose end time
  // has already passed. The shifts table is not actively swept into
  // "completed", so past rows linger as status=upcoming and leak into Open
  // Vacancies and the mobile Shifts tab. Filter them out here so every
  // consumer (dashboard, admin shifts, employee shifts) sees only truly
  // upcoming work.
  if (status === "upcoming") conditions.push(gte(shiftsTable.endTime, new Date()));

  // Non-admins are limited: only shifts they're assigned to OR open shifts they qualify for.
  let restrictToEmployee: string | undefined;
  if (!isAdmin) {
    restrictToEmployee = userId;
  } else if (employeeId) {
    restrictToEmployee = employeeId;
  }

  let shifts;
  if (restrictToEmployee) {
    const myMaxLevel = !isAdmin ? await getEffectiveLevel(userId) : 4;
    const myHeldTrainings = !isAdmin ? await getEmployeeHeldTrainings(userId) : new Set<string>();
    const assignedRows = await db
      .select({ shiftId: shiftAssignmentsTable.shiftId })
      .from(shiftAssignmentsTable)
      .where(eq(shiftAssignmentsTable.employeeId, restrictToEmployee));
    const assignedIds = assignedRows.map((r) => r.shiftId);

    const all = conditions.length > 0
      ? await db.select().from(shiftsTable).where(and(...conditions))
      : await db.select().from(shiftsTable);

    if (isAdmin) {
      shifts = all.filter((s) => assignedIds.includes(s.id));
    } else {
      // Employee sees: assigned shifts + open shifts they qualify for (upcoming, not full).
      // Training-compliance check: any site-required training the officer
      // doesn't currently hold (unexpired) hides the shift from feeds.
      // Assigned shifts are always visible so an officer keeps seeing
      // shifts they've already committed to even if a cert lapsed.
      const counts = await db
        .select({ shiftId: shiftAssignmentsTable.shiftId, n: sql<number>`count(*)::int` })
        .from(shiftAssignmentsTable)
        .groupBy(shiftAssignmentsTable.shiftId);
      const countMap = new Map(counts.map((c) => [c.shiftId, c.n]));
      const siteIds = Array.from(new Set(all.map((s) => s.siteId).filter((id): id is string => !!id)));
      const siteReqMap = new Map<string, string[]>();
      if (siteIds.length > 0) {
        const siteRows = await db
          .select({ id: sitesTable.id, req: sitesTable.requiredTrainings })
          .from(sitesTable)
          .where(inArray(sitesTable.id, siteIds));
        for (const s of siteRows) siteReqMap.set(s.id, Array.isArray(s.req) ? s.req : []);
      }
      const nowMs = Date.now();
      shifts = all.filter((s) => {
        if (assignedIds.includes(s.id)) return true;
        if (s.status !== "upcoming") return false;
        // Hide open shifts whose end time has already passed — they are no
        // longer claimable and should not appear in the officer's feed.
        if (new Date(s.endTime).getTime() < nowMs) return false;
        if (myMaxLevel < s.requiredLicenseLevel) return false;
        if ((countMap.get(s.id) ?? 0) >= s.headcount) return false;
        const req = s.siteId ? (siteReqMap.get(s.siteId) ?? []) : [];
        for (const t of req) if (!myHeldTrainings.has(t)) return false;
        return true;
      });
    }
  } else {
    shifts = conditions.length > 0
      ? await db.select().from(shiftsTable).where(and(...conditions))
      : await db.select().from(shiftsTable);
  }

  const shiftIds = shifts.map((s) => s.id);
  if (shiftIds.length === 0) { res.json(shifts.map((s) => ({ ...s, assignments: [] }))); return; }

  const assignments = await db
    .select({
      id: shiftAssignmentsTable.id,
      shiftId: shiftAssignmentsTable.shiftId,
      employeeId: shiftAssignmentsTable.employeeId,
      status: shiftAssignmentsTable.status,
      createdAt: shiftAssignmentsTable.createdAt,
      employeeName: sql<string>`${usersTable.firstName} || ' ' || ${usersTable.lastName}`,
    })
    .from(shiftAssignmentsTable)
    .leftJoin(usersTable, eq(shiftAssignmentsTable.employeeId, usersTable.id));

  const assignmentMap = new Map<string, typeof assignments>();
  for (const a of assignments) {
    if (!assignmentMap.has(a.shiftId)) assignmentMap.set(a.shiftId, []);
    assignmentMap.get(a.shiftId)!.push(a);
  }

  // Compute distanceMilesFromHome for the requesting employee so the mobile
  // open-shifts list can sort nearest-first and prompt a confirmation on
  // 50+mi shifts. Admins/dispatchers don't get a distance (their feed is
  // global, not personal). Distance is always measured from the employee's
  // geocoded home to the SITE's coordinates — never to shift.locationLat/Lng
  // (those are an ad-hoc geo for site-less shifts and don't represent a
  // canonical worksite location). Null when caller is admin, the employee
  // has no home coords, the shift has no siteId, or the site has no coords.
  let distanceMap: Map<string, number> | null = null;
  if (!isAdmin) {
    const [meEmp] = await db
      .select({ homeLat: employeesTable.homeLat, homeLng: employeesTable.homeLng })
      .from(employeesTable)
      .where(eq(employeesTable.userId, userId))
      .limit(1);
    const homeLat = meEmp?.homeLat != null ? Number(meEmp.homeLat) : null;
    const homeLng = meEmp?.homeLng != null ? Number(meEmp.homeLng) : null;
    if (homeLat != null && homeLng != null && Number.isFinite(homeLat) && Number.isFinite(homeLng)) {
      const siteIdsForDist = Array.from(new Set(
        shifts.map((s) => s.siteId).filter((id): id is string => !!id),
      ));
      const siteCoordMap = new Map<string, { lat: number; lng: number }>();
      if (siteIdsForDist.length > 0) {
        const siteRows = await db
          .select({ id: sitesTable.id, lat: sitesTable.locationLat, lng: sitesTable.locationLng })
          .from(sitesTable)
          .where(inArray(sitesTable.id, siteIdsForDist));
        for (const r of siteRows) {
          if (r.lat != null && r.lng != null) {
            const lat = Number(r.lat);
            const lng = Number(r.lng);
            if (Number.isFinite(lat) && Number.isFinite(lng)) {
              siteCoordMap.set(r.id, { lat, lng });
            }
          }
        }
      }
      distanceMap = new Map();
      for (const s of shifts) {
        if (!s.siteId) continue;
        const c = siteCoordMap.get(s.siteId);
        if (!c) continue;
        const d = haversineMiles(homeLat, homeLng, c.lat, c.lng);
        distanceMap.set(s.id, Math.round(d * 10) / 10);
      }
    }
  }

  res.json(shifts.map((s) => ({
    ...s,
    assignments: assignmentMap.get(s.id) ?? [],
    distanceMilesFromHome: distanceMap?.get(s.id) ?? null,
  })));
});

router.post("/shifts", requireAdmin, async (req, res): Promise<void> => {
  const {
    title, siteId, clientName: bodyClientName, location: bodyLocation, locationLat, locationLng,
    startTime, endTime,
    payRate, billRate, hourlyRate, billableRate,
    isRepeat, repeatPattern, notes, employeeIds, requiredLicenseLevel, headcount,
    siteRateId,
  } = req.body;

  // Resolve site to populate clientName/location automatically.
  let resolvedClientName = bodyClientName ?? null;
  let resolvedLocation = bodyLocation ?? null;
  if (siteId) {
    const [site] = await db
      .select({ id: sitesTable.id, name: sitesTable.name, address: sitesTable.address, lat: sitesTable.locationLat, lng: sitesTable.locationLng, clientName: clientsTable.name })
      .from(sitesTable)
      .leftJoin(clientsTable, eq(sitesTable.clientId, clientsTable.id))
      .where(eq(sitesTable.id, siteId));
    if (!site) { res.status(400).json({ error: "Bad Request", message: "Site not found" }); return; }
    resolvedClientName = site.clientName ?? resolvedClientName ?? null;
    resolvedLocation = site.address ?? resolvedLocation ?? site.name;
  }

  if (!title || !startTime || !endTime) {
    res.status(400).json({ error: "Bad Request", message: "title, startTime, endTime required" });
    return;
  }

  const lvl = [1, 2, 3, 4].includes(Number(requiredLicenseLevel)) ? Number(requiredLicenseLevel) : 2;
  const hc = Math.max(1, Number(headcount) || 1);
  // payRate/billRate are the canonical fields; legacy hourlyRate/billableRate fall back when not set.
  const finalPay = payRate != null ? Number(payRate) : (hourlyRate != null ? Number(hourlyRate) : 0);
  const finalBill = billRate != null ? Number(billRate) : (billableRate != null ? Number(billableRate) : 0);

  const [shift] = await db.insert(shiftsTable).values({
    title,
    siteId: siteId || null,
    clientName: resolvedClientName,
    location: resolvedLocation,
    locationLat: locationLat ? String(locationLat) : null,
    locationLng: locationLng ? String(locationLng) : null,
    startTime: new Date(startTime),
    endTime: new Date(endTime),
    payRate: String(finalPay),
    billRate: String(finalBill),
    hourlyRate: String(finalPay),
    billableRate: String(finalBill),
    isRepeat: isRepeat || false,
    repeatPattern: repeatPattern || null,
    notes: notes || null,
    status: "upcoming",
    requiredLicenseLevel: lvl,
    headcount: hc,
    siteRateId: siteRateId || null,
  }).returning();

  if (employeeIds && Array.isArray(employeeIds) && employeeIds.length > 0) {
    await db.insert(shiftAssignmentsTable).values(
      employeeIds.map((eid: string) => ({ shiftId: shift.id, employeeId: eid, status: "accepted" }))
    );
  }

  // Broadcast push notification to all qualifying active employees
  try {
    const candidates = await db
      .select({
        userId: usersTable.id,
        effLevel: effectiveLevelSql,
      })
      .from(usersTable)
      .leftJoin(licensesTable, eq(licensesTable.employeeId, usersTable.id))
      .leftJoin(employeesTable, eq(employeesTable.userId, usersTable.id))
      .where(and(eq(usersTable.role, "employee"), eq(usersTable.status, "active")))
      .groupBy(usersTable.id);

    const eligibleIds = candidates
      .filter((c) => c.effLevel >= lvl)
      .map((c) => c.userId);

    if (eligibleIds.length > 0) {
      const { sendPushToUsers } = await import("../lib/push");
      const start = new Date(shift.startTime).toLocaleString("en-AU", { weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
      const levelLabel = shiftLevelLabel(lvl);
      await sendPushToUsers(eligibleIds, {
        title: `🛡️ New ${levelLabel} Shift Available`,
        body: `${shift.title} @ ${shift.clientName} — ${start}`,
        data: { type: "shift_available", shiftId: shift.id },
      });
    }
  } catch (err) {
    req.log.warn({ err }, "Failed to broadcast new shift push");
  }

  res.status(201).json({ ...shift, assignments: [] });
});

/**
 * Bulk-create a series of shifts from a recurrence pattern.
 *
 * Body shape:
 *   {
 *     base: { title, siteId, payRate, billRate, requiredLicenseLevel, headcount, notes? },
 *     recurrence: {
 *       startDate: "YYYY-MM-DD",      // first eligible day (inclusive)
 *       untilDate: "YYYY-MM-DD",      // last eligible day (inclusive)
 *       daysOfWeek: number[],         // 0=Sun ... 6=Sat
 *       startTime: "HH:MM",           // local 24h, applied each occurrence
 *       endTime:   "HH:MM",           // wraps to next day if <= startTime
 *     }
 *   }
 *
 * Returns: { created, skippedExisting, shifts[] }.
 *
 * Times are stored UTC; we apply the HH:MM directly to the calendar date as
 * UTC instants so the admin sees what they typed. (Multi-timezone scheduling
 * is out of scope for this feature.) Existing shifts at the same site +
 * startTime are skipped to make re-runs idempotent.
 */
router.post("/shifts/repeat", requireAdmin, async (req, res): Promise<void> => {
  const { base, recurrence } = req.body ?? {};
  if (!base || !recurrence) {
    res.status(400).json({ error: "Bad Request", message: "base and recurrence required" });
    return;
  }
  const {
    title, siteId, payRate, billRate, requiredLicenseLevel, headcount, notes, siteRateId,
  } = base;
  const { startDate, untilDate, daysOfWeek, startTime, endTime } = recurrence;
  const tz: string = typeof recurrence.tz === "string" && recurrence.tz ? recurrence.tz : "America/Chicago";

  if (!title || !siteId) {
    res.status(400).json({ error: "Bad Request", message: "base.title and base.siteId required" });
    return;
  }
  if (!startDate || !untilDate || !startTime || !endTime || !Array.isArray(daysOfWeek) || daysOfWeek.length === 0) {
    res.status(400).json({ error: "Bad Request", message: "recurrence.startDate, untilDate, daysOfWeek, startTime, endTime required" });
    return;
  }

  const dateRe = /^\d{4}-\d{2}-\d{2}$/;
  const timeRe = /^\d{2}:\d{2}$/;
  if (!dateRe.test(startDate) || !dateRe.test(untilDate)) {
    res.status(400).json({ error: "Bad Request", message: "dates must be YYYY-MM-DD" });
    return;
  }
  if (!timeRe.test(startTime) || !timeRe.test(endTime)) {
    res.status(400).json({ error: "Bad Request", message: "times must be HH:MM" });
    return;
  }

  const validDays = (daysOfWeek as unknown[])
    .map((d) => Number(d))
    .filter((d) => Number.isInteger(d) && d >= 0 && d <= 6);
  if (validDays.length === 0) {
    res.status(400).json({ error: "Bad Request", message: "daysOfWeek must contain integers 0..6" });
    return;
  }

  // Resolve site → clientName/location for back-compat columns.
  const [site] = await db
    .select({ id: sitesTable.id, name: sitesTable.name, address: sitesTable.address, lat: sitesTable.locationLat, lng: sitesTable.locationLng, clientName: clientsTable.name })
    .from(sitesTable)
    .leftJoin(clientsTable, eq(sitesTable.clientId, clientsTable.id))
    .where(eq(sitesTable.id, siteId));
  if (!site) { res.status(400).json({ error: "Bad Request", message: "Site not found" }); return; }

  const lvl = [1, 2, 3, 4].includes(Number(requiredLicenseLevel)) ? Number(requiredLicenseLevel) : 2;
  const hc = Math.max(1, Number(headcount) || 1);
  const pay = Number(payRate) || 0;
  const bill = Number(billRate) || 0;

  // Cap series length to prevent runaway expansion (~1 year of daily shifts).
  const MAX_OCCURRENCES = 366;
  const start = new Date(`${startDate}T00:00:00Z`);
  const until = new Date(`${untilDate}T00:00:00Z`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(until.getTime()) || until < start) {
    res.status(400).json({ error: "Bad Request", message: "untilDate must be on/after startDate" });
    return;
  }

  const [sh, sm] = startTime.split(":").map(Number);
  const [eh, em] = endTime.split(":").map(Number);
  const wrapsOvernight = (eh * 60 + em) <= (sh * 60 + sm);

  const repeatPattern = JSON.stringify({ daysOfWeek: validDays.sort(), startTime, endTime, startDate, untilDate });
  // Stable series identifier shared by every occurrence in this batch. Lets
  // the admin UI group, bulk-edit, and bulk-delete a series without relying
  // on fragile site+title+repeatPattern JSON comparisons.
  const seriesId = randomUUID();

  const occurrences: { startTime: Date; endTime: Date }[] = [];
  for (let d = new Date(start); d <= until && occurrences.length < MAX_OCCURRENCES; d = new Date(d.getTime() + 86400000)) {
    if (!validDays.includes(d.getUTCDay())) continue;
    const y = d.getUTCFullYear(), mo = d.getUTCMonth() + 1, da = d.getUTCDate();
    const startInst = wallTimeToUtc(y, mo, da, sh, sm, tz);
    const endBase = wrapsOvernight ? new Date(d.getTime() + 86400000) : d;
    const ey = endBase.getUTCFullYear(), em2 = endBase.getUTCMonth() + 1, ed = endBase.getUTCDate();
    const endInst = wallTimeToUtc(ey, em2, ed, eh, em, tz);
    occurrences.push({ startTime: startInst, endTime: endInst });
  }

  if (occurrences.length === 0) {
    res.status(400).json({ error: "Bad Request", message: "No matching dates in range" });
    return;
  }

  // Idempotency: skip occurrences that already exist (same site + exact startTime).
  const existing = await db
    .select({ startTime: shiftsTable.startTime })
    .from(shiftsTable)
    .where(and(
      eq(shiftsTable.siteId, siteId),
      gte(shiftsTable.startTime, occurrences[0].startTime),
      lte(shiftsTable.startTime, occurrences[occurrences.length - 1].startTime),
    ));
  const existingMs = new Set(existing.map((r) => new Date(r.startTime).getTime()));

  const toInsert = occurrences
    .filter((o) => !existingMs.has(o.startTime.getTime()))
    .map((o) => ({
      title,
      siteId,
      clientName: site.clientName ?? null,
      location: site.address ?? site.name,
      locationLat: site.lat ? String(site.lat) : null,
      locationLng: site.lng ? String(site.lng) : null,
      startTime: o.startTime,
      endTime: o.endTime,
      payRate: String(pay),
      billRate: String(bill),
      hourlyRate: String(pay),
      billableRate: String(bill),
      isRepeat: true,
      repeatPattern,
      seriesId,
      notes: notes || null,
      status: "upcoming" as const,
      requiredLicenseLevel: lvl,
      headcount: hc,
      siteRateId: siteRateId || null,
    }));

  const inserted = toInsert.length > 0
    ? await db.insert(shiftsTable).values(toInsert).returning()
    : [];

  res.status(201).json({
    created: inserted.length,
    skippedExisting: occurrences.length - inserted.length,
    totalOccurrences: occurrences.length,
    shifts: inserted,
  });
});

// Bulk update a set of shifts (typically every occurrence in a recurring
// series). Times are HH:MM in `tz` and applied to each row's existing date.
router.put("/shifts/bulk", requireAdmin, async (req, res): Promise<void> => {
  const { ids, changes } = req.body ?? {};
  if (!Array.isArray(ids) || ids.length === 0) {
    res.status(400).json({ error: "Bad Request", message: "ids[] required" }); return;
  }
  if (!changes || typeof changes !== "object") {
    res.status(400).json({ error: "Bad Request", message: "changes object required" }); return;
  }
  const tz: string = typeof changes.tz === "string" && changes.tz ? changes.tz : "America/Chicago";
  const timeRe = /^\d{2}:\d{2}$/;
  const newStart = typeof changes.startTime === "string" && timeRe.test(changes.startTime) ? changes.startTime : null;
  const newEnd = typeof changes.endTime === "string" && timeRe.test(changes.endTime) ? changes.endTime : null;

  const setCommon: Record<string, unknown> = {};
  if (changes.payRate != null && changes.payRate !== "") {
    const n = Number(changes.payRate);
    if (!Number.isFinite(n)) { res.status(400).json({ error: "Bad Request", message: "payRate must be a number" }); return; }
    setCommon.payRate = String(n); setCommon.hourlyRate = String(n);
  }
  if (changes.billRate != null && changes.billRate !== "") {
    const n = Number(changes.billRate);
    if (!Number.isFinite(n)) { res.status(400).json({ error: "Bad Request", message: "billRate must be a number" }); return; }
    setCommon.billRate = String(n); setCommon.billableRate = String(n);
  }
  if (changes.requiredLicenseLevel != null && changes.requiredLicenseLevel !== "") {
    const n = Number(changes.requiredLicenseLevel);
    if (![1, 2, 3, 4].includes(n)) { res.status(400).json({ error: "Bad Request", message: "requiredLicenseLevel must be 1|2|3|4" }); return; }
    setCommon.requiredLicenseLevel = n;
  }
  if (changes.headcount != null && changes.headcount !== "") {
    const n = Math.max(1, Math.floor(Number(changes.headcount)));
    if (!Number.isFinite(n)) { res.status(400).json({ error: "Bad Request", message: "headcount must be a number" }); return; }
    setCommon.headcount = n;
  }
  if (typeof changes.notes === "string") setCommon.notes = changes.notes || null;
  if (typeof changes.title === "string" && changes.title.trim()) setCommon.title = changes.title.trim();
  if (typeof changes.status === "string" && ["upcoming", "active", "completed", "cancelled"].includes(changes.status)) {
    setCommon.status = changes.status;
  }

  const rows = await db.select().from(shiftsTable).where(inArray(shiftsTable.id, ids as string[]));
  if (rows.length === 0) { res.status(404).json({ error: "Not Found", message: "no matching shifts" }); return; }

  let updated = 0;
  await db.transaction(async (tx) => {
    for (const r of rows) {
      const patch: Record<string, unknown> = { ...setCommon };
      if (newStart || newEnd) {
        // Anchor on the existing start day as observed in `tz`.
        const startDateLocal = localDateInTz(new Date(r.startTime).getTime(), tz);
        const [y, mo, da] = startDateLocal.split("-").map(Number);
        if (newStart) {
          const [sh, sm] = newStart.split(":").map(Number);
          patch.startTime = wallTimeToUtc(y, mo, da, sh, sm, tz);
        }
        if (newEnd) {
          const [eh, eM] = newEnd.split(":").map(Number);
          // Decide overnight: if the user supplied newStart, compare HH:MM
          // pairs directly. Otherwise preserve the existing shift's
          // overnight-ness by comparing the local dates of the existing
          // start vs. end in `tz` (NOT raw UTC proximity, which breaks
          // for normal multi-hour overnight shifts).
          let wraps: boolean;
          if (newStart) {
            const [sh2, sm2] = newStart.split(":").map(Number);
            wraps = (eh * 60 + eM) <= (sh2 * 60 + sm2);
          } else {
            const endDateLocal = localDateInTz(new Date(r.endTime).getTime(), tz);
            wraps = endDateLocal !== startDateLocal;
          }
          let ey = y, em3 = mo, ed = da;
          if (wraps) {
            const next = new Date(Date.UTC(y, mo - 1, da) + 86400000);
            ey = next.getUTCFullYear();
            em3 = next.getUTCMonth() + 1;
            ed = next.getUTCDate();
          }
          patch.endTime = wallTimeToUtc(ey, em3, ed, eh, eM, tz);
        }
      }
      if (Object.keys(patch).length === 0) continue;
      await tx.update(shiftsTable).set(patch).where(eq(shiftsTable.id, r.id));
      updated++;
    }
  });

  res.json({ updated, total: rows.length });
});

// Bulk-delete a set of shifts (typically every occurrence in a recurring
// series). Trivial wrapper made cheap by the new shifts.series_id column —
// the admin UI passes the series's full id list.
router.delete("/shifts/bulk", requireAdmin, async (req, res): Promise<void> => {
  const { ids } = req.body ?? {};
  if (!Array.isArray(ids) || ids.length === 0) {
    res.status(400).json({ error: "Bad Request", message: "ids[] required" }); return;
  }
  const result = await db.delete(shiftsTable).where(inArray(shiftsTable.id, ids as string[])).returning({ id: shiftsTable.id });
  res.json({ deleted: result.length });
});

/**
 * Repair recurring shifts that were created before the timezone fix landed:
 * historically the repeat builder applied the chosen HH:MM directly to a UTC
 * calendar date, so a "9:00 AM" Texas shift was stored as 09:00 UTC (04:00
 * Central). Each shift's `repeatPattern` JSON still carries the intended
 * local HH:MM, so we re-anchor every row to that local time using the UTC
 * calendar date of the existing `startTime` as the day key (that's the day
 * the bug originally aimed at).
 *
 * Body: `{ ids: string[], tz?: string }` (defaults to America/Chicago).
 *
 * Idempotent: a row already on the correct UTC instant is left untouched and
 * counted under `alreadyCorrect`. Single (non-repeat) shifts and rows with a
 * missing/unreadable repeatPattern are counted under `skipped` so the admin
 * sees a precise tally.
 */
router.post("/shifts/series/fix-timezone", requireAdmin, async (req, res): Promise<void> => {
  const { ids } = req.body ?? {};
  if (!Array.isArray(ids) || ids.length === 0) {
    res.status(400).json({ error: "Bad Request", message: "ids[] required" }); return;
  }
  // Repair zone is hard-pinned to America/Chicago: every affected series was
  // created with that intent (WCSG operates in Texas), and pinning the zone
  // keeps the operation idempotent regardless of which admin browser triggers
  // it. We deliberately ignore any client-supplied tz here.
  const tz = "America/Chicago";
  const timeRe = /^\d{2}:\d{2}$/;

  const rows = await db.select().from(shiftsTable).where(inArray(shiftsTable.id, ids as string[]));
  if (rows.length === 0) {
    res.status(404).json({ error: "Not Found", message: "no matching shifts" }); return;
  }

  let fixed = 0;
  let alreadyCorrect = 0;
  let skipped = 0;
  await db.transaction(async (tx) => {
    for (const r of rows) {
      if (!r.isRepeat || !r.repeatPattern) { skipped++; continue; }
      let pattern: { startTime?: unknown; endTime?: unknown } | null = null;
      try { pattern = JSON.parse(r.repeatPattern); } catch { /* ignore */ }
      const startStr = pattern?.startTime;
      const endStr = pattern?.endTime;
      if (typeof startStr !== "string" || !timeRe.test(startStr)
          || typeof endStr !== "string" || !timeRe.test(endStr)) {
        skipped++; continue;
      }
      const [sh, sm] = startStr.split(":").map(Number);
      const [eh, em] = endStr.split(":").map(Number);
      const wraps = (eh * 60 + em) <= (sh * 60 + sm);

      const cur = new Date(r.startTime);
      const y = cur.getUTCFullYear(), mo = cur.getUTCMonth() + 1, da = cur.getUTCDate();
      const newStart = wallTimeToUtc(y, mo, da, sh, sm, tz);
      const endBase = wraps ? new Date(Date.UTC(y, mo - 1, da) + 86400000) : new Date(Date.UTC(y, mo - 1, da));
      const ey = endBase.getUTCFullYear(), em2 = endBase.getUTCMonth() + 1, ed = endBase.getUTCDate();
      const newEnd = wallTimeToUtc(ey, em2, ed, eh, em, tz);

      if (newStart.getTime() === new Date(r.startTime).getTime()
          && newEnd.getTime() === new Date(r.endTime).getTime()) {
        alreadyCorrect++; continue;
      }
      await tx.update(shiftsTable).set({ startTime: newStart, endTime: newEnd }).where(eq(shiftsTable.id, r.id));
      fixed++;
    }
  });

  res.json({ fixed, alreadyCorrect, skipped, total: rows.length });
});

router.get("/shifts/:id", requireAuth, async (req, res): Promise<void> => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const [shift] = await db.select().from(shiftsTable).where(eq(shiftsTable.id, id));
  if (!shift) { res.status(404).json({ error: "Not Found" }); return; }

  const assignments = await db
    .select({
      id: shiftAssignmentsTable.id,
      shiftId: shiftAssignmentsTable.shiftId,
      employeeId: shiftAssignmentsTable.employeeId,
      status: shiftAssignmentsTable.status,
      createdAt: shiftAssignmentsTable.createdAt,
      employeeName: sql<string>`${usersTable.firstName} || ' ' || ${usersTable.lastName}`,
    })
    .from(shiftAssignmentsTable)
    .leftJoin(usersTable, eq(shiftAssignmentsTable.employeeId, usersTable.id))
    .where(eq(shiftAssignmentsTable.shiftId, id));

  res.json({ ...shift, assignments });
});

router.put("/shifts/:id", requireAdmin, async (req, res): Promise<void> => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const { title, siteId, startTime, endTime, payRate, billRate, hourlyRate, billableRate, status, notes, requiredLicenseLevel, headcount, siteRateId } = req.body;
  const updates: Record<string, unknown> = {};
  if (title) updates.title = title;
  if (siteId) {
    const [site] = await db
      .select({ name: sitesTable.name, address: sitesTable.address, clientName: clientsTable.name })
      .from(sitesTable)
      .leftJoin(clientsTable, eq(sitesTable.clientId, clientsTable.id))
      .where(eq(sitesTable.id, siteId));
    if (site) {
      updates.siteId = siteId;
      updates.clientName = site.clientName;
      updates.location = site.address ?? site.name;
    }
  }
  if (startTime) updates.startTime = new Date(startTime);
  if (endTime) updates.endTime = new Date(endTime);
  if (payRate !== undefined) { updates.payRate = String(payRate); updates.hourlyRate = String(payRate); }
  if (billRate !== undefined) { updates.billRate = String(billRate); updates.billableRate = String(billRate); }
  if (hourlyRate !== undefined && payRate === undefined) { updates.payRate = String(hourlyRate); updates.hourlyRate = String(hourlyRate); }
  if (billableRate !== undefined && billRate === undefined) { updates.billRate = String(billableRate); updates.billableRate = String(billableRate); }
  if (status) updates.status = status;
  if (notes !== undefined) updates.notes = notes;
  if (requiredLicenseLevel !== undefined && [1, 2, 3, 4].includes(Number(requiredLicenseLevel))) {
    updates.requiredLicenseLevel = Number(requiredLicenseLevel);
  }
  if (headcount !== undefined) updates.headcount = Math.max(1, Number(headcount) || 1);
  // Explicit null clears the FK (admin selected "Custom" rate); undefined leaves it alone.
  if (siteRateId !== undefined) updates.siteRateId = siteRateId || null;

  const [shift] = await db.update(shiftsTable).set(updates).where(eq(shiftsTable.id, id)).returning();
  if (!shift) { res.status(404).json({ error: "Not Found" }); return; }
  res.json({ ...shift, assignments: [] });
});

router.delete("/shifts/:id", requireAdmin, async (req, res): Promise<void> => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  await db.delete(shiftsTable).where(eq(shiftsTable.id, id));
  res.sendStatus(204);
});

router.post("/shifts/:id/claim", requireAuth, async (req, res): Promise<void> => {
  const shiftId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const userId = req.user!.userId;

  const [shift] = await db.select().from(shiftsTable).where(eq(shiftsTable.id, shiftId));
  if (!shift) { res.status(404).json({ error: "Not Found", message: "Shift not found" }); return; }
  if (shift.status !== "upcoming") {
    res.status(409).json({ error: "Conflict", message: "This shift is no longer open" });
    return;
  }

  const myLevel = await getEffectiveLevel(userId);
  if (myLevel < shift.requiredLicenseLevel) {
    res.status(403).json({
      error: "Forbidden",
      message: shift.requiredLicenseLevel <= 1
        ? `This is a support shift. Your account isn't cleared to claim it yet — ask your administrator to set you up as support staff.`
        : `This shift requires Level ${shift.requiredLicenseLevel}${shift.requiredLicenseLevel === 4 ? "/PPO" : ""}. Your highest valid licence is ${myLevel === 0 ? "none" : `Level ${myLevel}`}.`,
    });
    return;
  }
  // Training compliance: if the site declares required training slugs,
  // the officer must hold each one (unexpired). 403 with a precise
  // "you're missing X, Y" so the officer can self-serve the fix from
  // the mobile profile page.
  if (shift.siteId) {
    const [site] = await db
      .select({ req: sitesTable.requiredTrainings })
      .from(sitesTable)
      .where(eq(sitesTable.id, shift.siteId))
      .limit(1);
    const required = Array.isArray(site?.req) ? site!.req : [];
    if (required.length > 0) {
      const held = await getEmployeeHeldTrainings(userId);
      const missing = required.filter((t) => !held.has(t));
      if (missing.length > 0) {
        res.status(403).json({
          error: "Forbidden",
          code: "missing_training",
          message: `This site requires training you don't currently hold: ${missing.join(", ")}. Upload the certificate from Profile → My training.`,
          missingTrainings: missing,
        });
        return;
      }
    }
  }

  // Race-safe atomic claim: lock the parent shift row inside a transaction so
  // concurrent claims serialize on it; the unique index on (shift_id, employee_id)
  // prevents duplicate assignments. Returns null when full or already-assigned.
  let assignment: typeof shiftAssignmentsTable.$inferSelect | undefined;
  let alreadyAssigned = false;
  try {
    assignment = await db.transaction(async (tx) => {
      // Lock the shift row so only one concurrent claim can proceed at a time.
      const locked = await tx.execute(sql`
        SELECT headcount FROM shifts WHERE id = ${shiftId}::uuid FOR UPDATE
      `);
      const lockedRow = (locked as any).rows?.[0];
      if (!lockedRow) return undefined;
      const headcount: number = lockedRow.headcount;

      // Pre-check duplicate BEFORE the INSERT. A 23505 thrown inside the
      // transaction aborts it at the Postgres level, and the subsequent
      // COMMIT then errors out — turning a friendly 409 into a 500. Since
      // we already hold FOR UPDATE on the parent shift row, no concurrent
      // claim by this same officer can slip in between this check and the
      // insert below.
      const dupRes = await tx.execute(sql`
        SELECT 1 FROM shift_assignments
        WHERE shift_id = ${shiftId}::uuid AND employee_id = ${userId}::uuid
        LIMIT 1
      `);
      if ((dupRes as any).rows?.length) {
        alreadyAssigned = true;
        return undefined;
      }

      const countRes = await tx.execute(sql`
        SELECT COUNT(*)::int AS c FROM shift_assignments WHERE shift_id = ${shiftId}::uuid
      `);
      const filled: number = (countRes as any).rows?.[0]?.c ?? 0;
      if (filled >= headcount) return undefined;

      // One-tap reserve: officer is committed immediately. No separate
      // pending→accepted confirmation step (admins were getting confused
      // about whether the slot was actually filled).
      const inserted = await tx.execute(sql`
        INSERT INTO shift_assignments (shift_id, employee_id, status)
        VALUES (${shiftId}::uuid, ${userId}::uuid, 'accepted')
        RETURNING id, shift_id, employee_id, status, created_at, updated_at
      `);
      const row = (inserted as any).rows?.[0];
      return {
        id: row.id,
        shiftId: row.shift_id,
        employeeId: row.employee_id,
        status: row.status,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      } as any;
    });
  } catch (err) {
    req.log.error({ err }, "claim shift insert failed");
    res.status(500).json({ error: "Internal", message: "Could not sign up" });
    return;
  }

  if (!assignment) {
    if (alreadyAssigned) {
      res.status(409).json({ error: "Conflict", message: "You're already signed up for this shift" });
    } else {
      res.status(409).json({ error: "Conflict", message: "This shift is fully staffed" });
    }
    return;
  }

  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId));

  // Reminder push so the officer confirms the shift on-device (accountability trail).
  try {
    const { sendPushToUsers } = await import("../lib/push");
    const start = new Date(shift.startTime).toLocaleString("en-GB", { weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
    await sendPushToUsers([userId], {
      title: "✅ Shift Reserved",
      body: `You're booked for ${shift.title} on ${start}.`,
      data: { type: "shift_reserved", shiftId },
    });
  } catch (err) {
    req.log.warn({ err }, "Failed to send claim confirmation push");
  }

  res.status(201).json({ ...assignment, employeeName: user ? `${user.firstName} ${user.lastName}` : null });
});

router.post("/shifts/:id/notify-vacancy", requireAdminOrDispatcher, async (req, res): Promise<void> => {
  const shiftId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

  const [shift] = await db.select().from(shiftsTable).where(eq(shiftsTable.id, shiftId));
  if (!shift) { res.status(404).json({ error: "Not Found", message: "Shift not found" }); return; }

  const filledRes = await db.execute(sql`
    SELECT COUNT(*)::int AS c, ARRAY_AGG(employee_id) AS ids
    FROM shift_assignments WHERE shift_id = ${shiftId}::uuid
  `);
  const filled: number = (filledRes as any).rows?.[0]?.c ?? 0;
  const assignedIds: string[] = (filledRes as any).rows?.[0]?.ids ?? [];
  const vacanciesRemaining = Math.max(0, shift.headcount - filled);
  if (vacanciesRemaining === 0) {
    res.status(409).json({ error: "Conflict", message: "This shift is already fully staffed" });
    return;
  }

  // Find active employees whose highest unexpired licence covers the requirement
  // and who aren't already assigned to this shift.
  const candidates = await db
    .select({
      userId: usersTable.id,
      effLevel: effectiveLevelSql,
    })
    .from(usersTable)
    .leftJoin(licensesTable, eq(licensesTable.employeeId, usersTable.id))
    .leftJoin(employeesTable, eq(employeesTable.userId, usersTable.id))
    .where(and(eq(usersTable.role, "employee"), eq(usersTable.status, "active")))
    .groupBy(usersTable.id);

  const assignedSet = new Set(assignedIds.filter(Boolean));
  const targetIds = candidates
    .filter((c) => c.effLevel >= shift.requiredLicenseLevel && !assignedSet.has(c.userId))
    .map((c) => c.userId);

  if (targetIds.length > 0) {
    try {
      const { sendPushToUsers } = await import("../lib/push");
      const start = new Date(shift.startTime).toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
      const levelLabel = shiftLevelLabel(shift.requiredLicenseLevel);
      await sendPushToUsers(targetIds, {
        title: `🛡️ Open ${levelLabel} Shift — ${vacanciesRemaining} vacancy${vacanciesRemaining === 1 ? "" : "s"}`,
        body: `${shift.title} @ ${shift.clientName} — ${start}. Tap to reserve.`,
        data: { type: "shift_vacancy_reminder", shiftId },
      });
      const { sendSmsToUsers } = await import("../lib/sms");
      sendSmsToUsers(
        targetIds,
        `[WCSG] Open ${levelLabel} shift @ ${shift.clientName} — ${start}. Reserve in the app.`,
      ).catch((err: unknown) => req.log.warn({ err, shiftId }, "vacancy SMS dispatch failed"));
    } catch (err) {
      req.log.warn({ err }, "Failed to send vacancy reminder push");
    }
  }

  res.json({ notifiedCount: targetIds.length, vacanciesRemaining });
});

router.post("/shifts/:id/assignments", requireAdminOrDispatcher, async (req, res): Promise<void> => {
  const shiftId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const { employeeId } = req.body;
  if (!employeeId) { res.status(400).json({ error: "Bad Request", message: "employeeId required" }); return; }

  const [shift] = await db.select().from(shiftsTable).where(eq(shiftsTable.id, shiftId));
  if (!shift) { res.status(404).json({ error: "Not Found" }); return; }

  const empLevel = await getEffectiveLevel(employeeId);
  if (empLevel < shift.requiredLicenseLevel) {
    res.status(403).json({
      error: "Forbidden",
      message: shift.requiredLicenseLevel <= 1
        ? `This is a support shift. The selected employee isn't cleared for it — set their position to support staff or assign a licensed officer.`
        : `Employee's highest valid licence (${empLevel === 0 ? "none" : `Level ${empLevel}`}) does not meet the shift requirement (Level ${shift.requiredLicenseLevel}${shift.requiredLicenseLevel === 4 ? "/PPO" : ""}).`,
    });
    return;
  }

  // Double-book guard: refuse if the officer already has an accepted
  // assignment on another shift whose [start,end) window overlaps this
  // one. Dispatchers (and admins) can override by first revoking the
  // conflicting assignment. This mirrors the eligibility filter used
  // by /dispatch/assign-nearest, so explicit and auto picks share the
  // same correctness floor.
  const conflict = await db
    .select({ id: shiftAssignmentsTable.id, otherShiftId: shiftsTable.id, otherTitle: shiftsTable.title })
    .from(shiftAssignmentsTable)
    .innerJoin(shiftsTable, eq(shiftAssignmentsTable.shiftId, shiftsTable.id))
    .where(and(
      eq(shiftAssignmentsTable.employeeId, employeeId),
      eq(shiftAssignmentsTable.status, "accepted"),
      ne(shiftsTable.id, shiftId),
      lt(shiftsTable.startTime, shift.endTime),
      gt(shiftsTable.endTime, shift.startTime),
    ))
    .limit(1);
  if (conflict.length > 0) {
    res.status(409).json({
      error: "Conflict",
      message: `Employee already has an accepted shift that overlaps this one${conflict[0].otherTitle ? ` ("${conflict[0].otherTitle}")` : ""}.`,
      conflictingShiftId: conflict[0].otherShiftId,
    });
    return;
  }

  // Admin assignment is final — the officer is on the schedule immediately.
  // No pending/accept dance: when admin taps "+", the slot is filled.
  // Race-safe: lock the parent shift row and re-check headcount inside the
  // tx so a concurrent officer claim (or another dispatcher assigning at the
  // same moment) cannot push us past the configured headcount. The unique
  // index on (shift_id, employee_id) blocks duplicate assignments.
  let assignment: typeof shiftAssignmentsTable.$inferSelect | undefined;
  let outcome: string = "ok";
  try {
    assignment = await db.transaction(async (tx) => {
      const locked = await tx.execute(sql`
        SELECT headcount FROM shifts WHERE id = ${shiftId}::uuid FOR UPDATE
      `);
      const lockedRow = (locked as any).rows?.[0];
      if (!lockedRow) { outcome = "missing"; return undefined; }
      const headcount: number = lockedRow.headcount;

      const dupRes = await tx.execute(sql`
        SELECT 1 FROM shift_assignments
        WHERE shift_id = ${shiftId}::uuid AND employee_id = ${employeeId}::uuid
        LIMIT 1
      `);
      if ((dupRes as any).rows?.length) { outcome = "already"; return undefined; }

      const countRes = await tx.execute(sql`
        SELECT COUNT(*)::int AS c FROM shift_assignments WHERE shift_id = ${shiftId}::uuid
      `);
      const filled: number = (countRes as any).rows?.[0]?.c ?? 0;
      if (filled >= headcount) { outcome = "full"; return undefined; }

      const [row] = await tx.insert(shiftAssignmentsTable)
        .values({ shiftId, employeeId, status: "accepted" })
        .returning();
      return row;
    });
  } catch (err) {
    req.log.error({ err, shiftId, employeeId }, "admin assign shift insert failed");
    res.status(500).json({ error: "Internal", message: "Could not assign officer" });
    return;
  }
  if (!assignment) {
    if (outcome === "already") {
      res.status(409).json({ error: "Conflict", message: "Officer is already assigned to this shift" });
    } else if (outcome === "full") {
      res.status(409).json({ error: "Conflict", message: "This shift is already fully staffed" });
    } else {
      res.status(404).json({ error: "Not Found", message: "Shift not found" });
    }
    return;
  }
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, employeeId));

  // Send push notification to the assigned employee
  try {
    const { sendPushToUsers } = await import("../lib/push");
    const start = new Date(shift.startTime).toLocaleString("en-AU", { weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
    await sendPushToUsers([employeeId], {
      title: "📋 New Shift Assigned",
      body: `You've been assigned to ${shift.title} on ${start}`,
      data: { type: "shift_assigned", shiftId },
    });
    const { sendSmsToUsers } = await import("../lib/sms");
    sendSmsToUsers(
      [employeeId],
      `[WCSG] You've been assigned to ${shift.title} on ${start}. Open the app for details.`,
    ).catch((err: unknown) => req.log.warn({ err, shiftId, employeeId }, "shift-assign SMS dispatch failed"));
  } catch (err) {
    req.log.warn({ err }, "Failed to send assignment push");
  }

  res.status(201).json({ ...assignment, employeeName: user ? `${user.firstName} ${user.lastName}` : null });
});

router.put("/shifts/:id/assignments/:assignmentId", requireAuth, async (req, res): Promise<void> => {
  const assignmentId = Array.isArray(req.params.assignmentId) ? req.params.assignmentId[0] : req.params.assignmentId;
  const { status } = req.body;
  if (!status) { res.status(400).json({ error: "Bad Request", message: "status required" }); return; }

  const [existing] = await db.select().from(shiftAssignmentsTable).where(eq(shiftAssignmentsTable.id, assignmentId));
  if (!existing) { res.status(404).json({ error: "Not Found" }); return; }

  // Non-admins can only modify their own assignments.
  if (req.user!.role !== "admin" && existing.employeeId !== req.user!.userId) {
    res.status(403).json({ error: "Forbidden", message: "You can only update your own assignments" });
    return;
  }

  // Declining frees the slot — delete the assignment row so headcount opens back up.
  if (status === "declined") {
    await db.delete(shiftAssignmentsTable).where(eq(shiftAssignmentsTable.id, assignmentId));
    res.json({ id: assignmentId, status: "declined", removed: true });
    return;
  }

  const [assignment] = await db.update(shiftAssignmentsTable).set({ status }).where(eq(shiftAssignmentsTable.id, assignmentId)).returning();
  if (!assignment) { res.status(404).json({ error: "Not Found" }); return; }
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, assignment.employeeId));
  res.json({ ...assignment, employeeName: user ? `${user.firstName} ${user.lastName}` : null });
});

export default router;
