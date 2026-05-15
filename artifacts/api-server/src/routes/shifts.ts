import { Router, type IRouter } from "express";
import { eq, and, gte, lte, sql, or, isNull, inArray } from "drizzle-orm";
import { db, shiftsTable, shiftAssignmentsTable, usersTable, licensesTable, sitesTable, clientsTable } from "@workspace/db";
import { requireAuth, requireAdmin } from "../middlewares/auth";

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

async function getEmployeeMaxLevel(employeeId: string): Promise<number | null> {
  const rows = await db
    .select({ level: licensesTable.level })
    .from(licensesTable)
    .where(and(
      eq(licensesTable.employeeId, employeeId),
      gte(licensesTable.expiryDate, sql`current_date`),
    ));
  let max: number | null = null;
  for (const r of rows) {
    if (r.level != null && (max == null || r.level > max)) max = r.level;
  }
  return max;
}

router.get("/shifts", requireAuth, async (req, res): Promise<void> => {
  const { status, employeeId, from, to } = req.query as { status?: string; employeeId?: string; from?: string; to?: string };
  const isAdmin = req.user!.role === "admin";
  const userId = req.user!.userId;

  const conditions = [];
  if (status) conditions.push(eq(shiftsTable.status, status));
  if (from) conditions.push(gte(shiftsTable.startTime, new Date(from)));
  if (to) conditions.push(lte(shiftsTable.startTime, new Date(to)));

  // Non-admins are limited: only shifts they're assigned to OR open shifts they qualify for.
  let restrictToEmployee: string | undefined;
  if (!isAdmin) {
    restrictToEmployee = userId;
  } else if (employeeId) {
    restrictToEmployee = employeeId;
  }

  let shifts;
  if (restrictToEmployee) {
    const myMaxLevel = !isAdmin ? (await getEmployeeMaxLevel(userId)) ?? 0 : 4;
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
      // Employee sees: assigned shifts + open shifts they qualify for (upcoming, not full)
      const counts = await db
        .select({ shiftId: shiftAssignmentsTable.shiftId, n: sql<number>`count(*)::int` })
        .from(shiftAssignmentsTable)
        .groupBy(shiftAssignmentsTable.shiftId);
      const countMap = new Map(counts.map((c) => [c.shiftId, c.n]));
      shifts = all.filter((s) => {
        if (assignedIds.includes(s.id)) return true;
        if (s.status !== "upcoming") return false;
        if (myMaxLevel < s.requiredLicenseLevel) return false;
        if ((countMap.get(s.id) ?? 0) >= s.headcount) return false;
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

  res.json(shifts.map((s) => ({ ...s, assignments: assignmentMap.get(s.id) ?? [] })));
});

router.post("/shifts", requireAdmin, async (req, res): Promise<void> => {
  const {
    title, siteId, clientName: bodyClientName, location: bodyLocation, locationLat, locationLng,
    startTime, endTime,
    payRate, billRate, hourlyRate, billableRate,
    isRepeat, repeatPattern, notes, employeeIds, requiredLicenseLevel, headcount,
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

  const lvl = [2, 3, 4].includes(Number(requiredLicenseLevel)) ? Number(requiredLicenseLevel) : 2;
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
        maxLevel: sql<number | null>`max(${licensesTable.level}) filter (where ${licensesTable.expiryDate} >= current_date)`,
      })
      .from(usersTable)
      .leftJoin(licensesTable, eq(licensesTable.employeeId, usersTable.id))
      .where(and(eq(usersTable.role, "employee"), eq(usersTable.status, "active")))
      .groupBy(usersTable.id);

    const eligibleIds = candidates
      .filter((c) => (c.maxLevel ?? 0) >= lvl)
      .map((c) => c.userId);

    if (eligibleIds.length > 0) {
      const { sendPushToUsers } = await import("../lib/push");
      const start = new Date(shift.startTime).toLocaleString("en-AU", { weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
      const levelLabel = lvl === 4 ? "L4/PPO" : `L${lvl}+`;
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
    title, siteId, payRate, billRate, requiredLicenseLevel, headcount, notes,
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

  const lvl = [2, 3, 4].includes(Number(requiredLicenseLevel)) ? Number(requiredLicenseLevel) : 2;
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
      notes: notes || null,
      status: "upcoming" as const,
      requiredLicenseLevel: lvl,
      headcount: hc,
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
    if (![2, 3, 4].includes(n)) { res.status(400).json({ error: "Bad Request", message: "requiredLicenseLevel must be 2|3|4" }); return; }
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
  const { title, siteId, startTime, endTime, payRate, billRate, hourlyRate, billableRate, status, notes, requiredLicenseLevel, headcount } = req.body;
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
  if (requiredLicenseLevel !== undefined && [2, 3, 4].includes(Number(requiredLicenseLevel))) {
    updates.requiredLicenseLevel = Number(requiredLicenseLevel);
  }
  if (headcount !== undefined) updates.headcount = Math.max(1, Number(headcount) || 1);

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

  const myLevel = (await getEmployeeMaxLevel(userId)) ?? 0;
  if (myLevel < shift.requiredLicenseLevel) {
    res.status(403).json({
      error: "Forbidden",
      message: `This shift requires Level ${shift.requiredLicenseLevel}${shift.requiredLicenseLevel === 4 ? "/PPO" : ""}. Your highest valid licence is ${myLevel === 0 ? "none" : `Level ${myLevel}`}.`,
    });
    return;
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

      const countRes = await tx.execute(sql`
        SELECT COUNT(*)::int AS c FROM shift_assignments WHERE shift_id = ${shiftId}::uuid
      `);
      const filled: number = (countRes as any).rows?.[0]?.c ?? 0;
      if (filled >= headcount) return undefined;

      try {
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
      } catch (e: any) {
        // Unique violation = user already signed up
        if (e?.code === "23505") {
          alreadyAssigned = true;
          return undefined;
        }
        throw e;
      }
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

router.post("/shifts/:id/notify-vacancy", requireAdmin, async (req, res): Promise<void> => {
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
      maxLevel: sql<number | null>`max(${licensesTable.level}) filter (where ${licensesTable.expiryDate} >= current_date)`,
    })
    .from(usersTable)
    .leftJoin(licensesTable, eq(licensesTable.employeeId, usersTable.id))
    .where(and(eq(usersTable.role, "employee"), eq(usersTable.status, "active")))
    .groupBy(usersTable.id);

  const assignedSet = new Set(assignedIds.filter(Boolean));
  const targetIds = candidates
    .filter((c) => (c.maxLevel ?? 0) >= shift.requiredLicenseLevel && !assignedSet.has(c.userId))
    .map((c) => c.userId);

  if (targetIds.length > 0) {
    try {
      const { sendPushToUsers } = await import("../lib/push");
      const start = new Date(shift.startTime).toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
      const levelLabel = shift.requiredLicenseLevel === 4 ? "L4/PPO" : `L${shift.requiredLicenseLevel}+`;
      await sendPushToUsers(targetIds, {
        title: `🛡️ Open ${levelLabel} Shift — ${vacanciesRemaining} vacancy${vacanciesRemaining === 1 ? "" : "s"}`,
        body: `${shift.title} @ ${shift.clientName} — ${start}. Tap to reserve.`,
        data: { type: "shift_vacancy_reminder", shiftId },
      });
    } catch (err) {
      req.log.warn({ err }, "Failed to send vacancy reminder push");
    }
  }

  res.json({ notifiedCount: targetIds.length, vacanciesRemaining });
});

router.post("/shifts/:id/assignments", requireAdmin, async (req, res): Promise<void> => {
  const shiftId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const { employeeId } = req.body;
  if (!employeeId) { res.status(400).json({ error: "Bad Request", message: "employeeId required" }); return; }

  const [shift] = await db.select().from(shiftsTable).where(eq(shiftsTable.id, shiftId));
  if (!shift) { res.status(404).json({ error: "Not Found" }); return; }

  const empLevel = (await getEmployeeMaxLevel(employeeId)) ?? 0;
  if (empLevel < shift.requiredLicenseLevel) {
    res.status(403).json({
      error: "Forbidden",
      message: `Employee's highest valid licence (${empLevel === 0 ? "none" : `Level ${empLevel}`}) does not meet the shift requirement (Level ${shift.requiredLicenseLevel}${shift.requiredLicenseLevel === 4 ? "/PPO" : ""}).`,
    });
    return;
  }

  // Admin assignment is final — the officer is on the schedule immediately.
  // No pending/accept dance: when admin taps "+", the slot is filled.
  const [assignment] = await db.insert(shiftAssignmentsTable).values({ shiftId, employeeId, status: "accepted" }).returning();
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
