import { Router, type IRouter } from "express";
import { randomUUID } from "node:crypto";
import { eq, and, gt, gte, lt, lte, ne, sql, or, isNull, inArray } from "drizzle-orm";
import { db, shiftsTable, shiftAssignmentsTable, usersTable, licensesTable, sitesTable, clientsTable, trainingCertificationsTable, employeesTable } from "@workspace/db";
import { requireStaff, requireAdmin, requireAdminOrDispatcher, requireAdminOrSiteManager, requireSchedulingStaff } from "../middlewares/auth";
import { haversineMiles } from "../lib/geofence";
import { getEffectiveLevel, effectiveLevelSql } from "../lib/eligibility";
import { pushShiftUpsert, pushShiftDelete, pushAssignmentEvent } from "../lib/schedulerSync";
import { stripShiftFinanceForRole } from "../lib/financeVisibility";
import { canManageSite, getManagedSiteIds, getSiteManagerUserIds } from "../lib/siteManagerAuthz";

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

// Company operating timezone (Central). Shift times are stored as UTC instants;
// notification/SMS copy must render them in the officer's local zone, otherwise
// the UTC clock reading is shown (e.g. a 5:30 PM Central start renders as
// "10:30 PM", which reads like the shift's end time).
export const COMPANY_TZ = "America/Chicago";

/** Format a shift instant for human-facing push/SMS copy, in company time. */
export function fmtShiftWhen(when: Date | string | number): string {
  return new Date(when).toLocaleString("en-US", {
    timeZone: COMPANY_TZ,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
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

router.get("/shifts", requireStaff, async (req, res): Promise<void> => {
  const { status, employeeId, from, to, view } = req.query as { status?: string; employeeId?: string; from?: string; to?: string; view?: string };
  // Admins and dispatchers get a full global read (they assign/notify/schedule
  // across every site). Site managers get a SCOPED read: shifts at the sites
  // they manage, PLUS any shift they're personally rostered on (their officer
  // view) — finance is stripped for them below. Employees stay scoped to their
  // own assigned + qualifying-open shifts.
  //
  // ?view=worker: ANY staff role can ask for the personal worker feed (their
  // own assigned shifts + qualifying open shifts) instead of their default
  // read. All internal staff work shifts, so admins/dispatchers/site managers
  // use this for "my work" surfaces; the eligibility gate (real effective
  // level + held trainings) is applied to them exactly like an employee.
  const role = req.user!.role;
  const workerView = view === "worker";
  const isAdmin = !workerView && (role === "admin" || role === "dispatcher");
  const isSiteManager = !workerView && role === "site_manager";
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

  let shifts;
  if (isSiteManager) {
    // Site managers see a scoped management view: every shift at a site they
    // manage (assigned or open) PLUS any shift they're personally rostered on.
    // No qualifying-open filter — they're managing, not picking up work. Empty
    // managed-set + no assignments => empty list (no IDOR across sites).
    const managed = new Set(await getManagedSiteIds(userId));
    const myAssignedRows = await db
      .select({ shiftId: shiftAssignmentsTable.shiftId })
      .from(shiftAssignmentsTable)
      .where(eq(shiftAssignmentsTable.employeeId, userId));
    const myAssigned = new Set(myAssignedRows.map((r) => r.shiftId));
    const all = conditions.length > 0
      ? await db.select().from(shiftsTable).where(and(...conditions))
      : await db.select().from(shiftsTable);
    shifts = all.filter((s) => (s.siteId != null && managed.has(s.siteId)) || myAssigned.has(s.id));
  } else {
  // Non-admins are limited: only shifts they're assigned to OR open shifts they qualify for.
  let restrictToEmployee: string | undefined;
  if (!isAdmin) {
    restrictToEmployee = userId;
  } else if (employeeId) {
    restrictToEmployee = employeeId;
  }

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
  if (!isAdmin && !isSiteManager) {
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

  res.json(shifts.map((s) => stripShiftFinanceForRole(role, {
    ...s,
    assignments: assignmentMap.get(s.id) ?? [],
    distanceMilesFromHome: distanceMap?.get(s.id) ?? null,
  })));
});

router.post("/shifts", requireAdminOrSiteManager, async (req, res): Promise<void> => {
  const {
    title, siteId, clientName: bodyClientName, location: bodyLocation, locationLat, locationLng,
    startTime, endTime,
    payRate, billRate, hourlyRate, billableRate,
    isRepeat, repeatPattern, notes, employeeIds, requiredLicenseLevel, headcount,
    siteRateId, shiftType,
  } = req.body;
  // Site managers never see or set rates; ignore any client-supplied rate
  // fields and fall back to the site's configured defaults so payroll/invoicing
  // still resolve a rate (never let a manager post a 0 that would poison the
  // chain).
  const isSiteManager = req.user!.role === "site_manager";

  // Resolve site to populate clientName/location automatically. Also pull the
  // site's default rates so site-manager-created shifts inherit them.
  let resolvedClientName = bodyClientName ?? null;
  let resolvedLocation = bodyLocation ?? null;
  let siteDefaultPay: string | null = null;
  let siteDefaultBill: string | null = null;
  if (siteId) {
    const [site] = await db
      .select({ id: sitesTable.id, name: sitesTable.name, status: sitesTable.status, address: sitesTable.address, lat: sitesTable.locationLat, lng: sitesTable.locationLng, clientName: clientsTable.name, defaultPayRate: sitesTable.defaultPayRate, defaultBillRate: sitesTable.defaultBillRate })
      .from(sitesTable)
      .leftJoin(clientsTable, eq(sitesTable.clientId, clientsTable.id))
      .where(eq(sitesTable.id, siteId));
    if (!site) { res.status(400).json({ error: "Bad Request", message: "Site not found" }); return; }
    if (site.status !== "active") {
      res.status(400).json({ error: "Bad Request", message: "This site is inactive — reactivate it before posting new shifts." });
      return;
    }
    resolvedClientName = site.clientName ?? resolvedClientName ?? null;
    resolvedLocation = site.address ?? resolvedLocation ?? site.name;
    siteDefaultPay = site.defaultPayRate ?? null;
    siteDefaultBill = site.defaultBillRate ?? null;
  }

  if (!title || !startTime || !endTime) {
    res.status(400).json({ error: "Bad Request", message: "title, startTime, endTime required" });
    return;
  }

  // Site managers may only post against a site they manage, and inherit rates
  // ONLY from the site default — failing closed if the site has no usable
  // defaults so we never silently persist a 0 that would poison payroll/
  // invoicing downstream.
  if (isSiteManager) {
    if (!siteId) {
      res.status(400).json({ error: "Bad Request", message: "Select a site — site managers post shifts against a site they manage." });
      return;
    }
    if (!(await canManageSite({ userId: req.user!.userId, role: req.user!.role }, siteId))) {
      res.status(403).json({ error: "Forbidden", message: "You can only post shifts to sites you manage." });
      return;
    }
  }

  const lvl = [1, 2, 3, 4].includes(Number(requiredLicenseLevel)) ? Number(requiredLicenseLevel) : 2;
  const hc = Math.max(1, Number(headcount) || 1);
  // payRate/billRate are the canonical fields; legacy hourlyRate/billableRate fall back when not set.
  // Site managers: rates come from the site default when available, otherwise 0 (an admin can
  // set the rate afterwards — blocking creation outright is worse than a $0 placeholder).
  const finalPay = isSiteManager
    ? (Number(siteDefaultPay) || 0)
    : (payRate != null ? Number(payRate) : (hourlyRate != null ? Number(hourlyRate) : 0));
  const finalBill = isSiteManager
    ? (Number(siteDefaultBill) || 0)
    : (billRate != null ? Number(billRate) : (billableRate != null ? Number(billableRate) : 0));

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
    // siteRateId links a shift to a `site_rates` card (which carries pay/bill
    // rates) — site managers can't pick rate cards, so never persist a
    // client-supplied one for them.
    siteRateId: isSiteManager ? null : (siteRateId || null),
    // PPO Detail shifts carry a protection package (protection_persons rows);
    // anything else is a standard patrol/static shift. Server-side allowlist —
    // never trust an arbitrary client string.
    shiftType: shiftType === "ppo_detail" ? "ppo_detail" : "standard",
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
      const start = fmtShiftWhen(shift.startTime);
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

  // Notify the site's managers that a new shift was posted at their site
  // (push + SMS), excluding whoever created it.
  if (shift.siteId) {
    try {
      const managerIds = (await getSiteManagerUserIds(shift.siteId)).filter((mid) => mid !== req.user!.userId);
      if (managerIds.length > 0) {
        const { sendPushToUsers } = await import("../lib/push");
        const { sendSmsToUsers } = await import("../lib/sms");
        const start = fmtShiftWhen(shift.startTime);
        const where = shift.clientName ?? resolvedLocation ?? "your site";
        await sendPushToUsers(managerIds, {
          title: "🗓️ New Shift at Your Site",
          body: `${shift.title} @ ${where} — ${start}`,
          data: { type: "site_shift_created", shiftId: shift.id, siteId: shift.siteId },
        });
        void sendSmsToUsers(
          managerIds,
          `WCSG: New shift posted at your site — ${shift.title} on ${start}. Open the SecureOps app to manage it.`,
        );
      }
    } catch (err) {
      req.log.warn({ err }, "Failed to notify site managers of new shift");
    }
  }

  // Outbound sync to scheduler (best-effort, after response)
  void pushShiftUpsert(shift);

  res.status(201).json(stripShiftFinanceForRole(req.user!.role, { ...shift, assignments: [] }));
});

/**
 * Multi-position one-off bulk create: one shift per position row in a single
 * transaction. Used when a manager picks several license-level positions (each
 * with their own headcount and rate) for the same date/time window.
 *
 * Body shape:
 *   {
 *     title:     string,
 *     siteId?:   uuid,
 *     startTime: ISO8601,
 *     endTime:   ISO8601,
 *     notes?:    string,
 *     shiftType?: "standard" | "ppo_detail",
 *     positions: [
 *       { requiredLicenseLevel: 1|2|3|4, headcount: number, payRate: string, billRate: string, siteRateId?: uuid },
 *       ...
 *     ]
 *   }
 *
 * Returns: { created: number, shifts: Shift[] }.
 * Site-manager rules mirror POST /shifts: must have a site, site must be
 * managed, rate fields are ignored and the site's defaults are used.
 */
router.post("/shifts/bulk-create", requireAdminOrSiteManager, async (req, res): Promise<void> => {
  const { title, siteId, startTime, endTime, notes, shiftType, positions } = req.body ?? {};

  if (!title || !startTime || !endTime) {
    res.status(400).json({ error: "Bad Request", message: "title, startTime, endTime required" });
    return;
  }
  if (!Array.isArray(positions) || positions.length === 0) {
    res.status(400).json({ error: "Bad Request", message: "positions[] required with at least one entry" });
    return;
  }

  const isSiteManager = req.user!.role === "site_manager";

  // Resolve site → clientName/location/defaults (same pattern as POST /shifts).
  let resolvedClientName: string | null = null;
  let resolvedLocation: string | null = null;
  let siteDefaultPay: string | null = null;
  let siteDefaultBill: string | null = null;
  let siteLat: string | null = null;
  let siteLng: string | null = null;

  if (siteId) {
    const [site] = await db
      .select({ id: sitesTable.id, name: sitesTable.name, status: sitesTable.status, address: sitesTable.address, lat: sitesTable.locationLat, lng: sitesTable.locationLng, clientName: clientsTable.name, defaultPayRate: sitesTable.defaultPayRate, defaultBillRate: sitesTable.defaultBillRate })
      .from(sitesTable)
      .leftJoin(clientsTable, eq(sitesTable.clientId, clientsTable.id))
      .where(eq(sitesTable.id, siteId));
    if (!site) { res.status(400).json({ error: "Bad Request", message: "Site not found" }); return; }
    if (site.status !== "active") {
      res.status(400).json({ error: "Bad Request", message: "This site is inactive — reactivate it before posting new shifts." });
      return;
    }
    resolvedClientName = site.clientName ?? null;
    resolvedLocation = site.address ?? site.name;
    siteDefaultPay = site.defaultPayRate ?? null;
    siteDefaultBill = site.defaultBillRate ?? null;
    siteLat = site.lat ? String(site.lat) : null;
    siteLng = site.lng ? String(site.lng) : null;
  }

  if (isSiteManager) {
    if (!siteId) {
      res.status(400).json({ error: "Bad Request", message: "Select a site — site managers post shifts against a site they manage." });
      return;
    }
    if (!(await canManageSite({ userId: req.user!.userId, role: req.user!.role }, siteId))) {
      res.status(403).json({ error: "Forbidden", message: "You can only post shifts to sites you manage." });
      return;
    }
  }

  const startDt = new Date(startTime);
  const endDt = new Date(endTime);
  if (Number.isNaN(startDt.getTime()) || Number.isNaN(endDt.getTime()) || endDt <= startDt) {
    res.status(400).json({ error: "Bad Request", message: "endTime must be after startTime" });
    return;
  }

  // Validate + normalise every position row. Duplicates are rejected by
  // SIGNATURE (license level + rate selection), not by level alone: the same
  // level at two different rate tiers (e.g. L3 Rate 1 + L3 Rate 2) is a
  // legitimate staffing pattern. Two rows only clash when they'd produce
  // indistinguishable shift records.
  const seenSignatures = new Set<string>();
  const validPositions: Array<{
    requiredLicenseLevel: number; headcount: number;
    payRate: string; billRate: string; siteRateId: string | null;
  }> = [];

  for (const p of positions as unknown[]) {
    if (typeof p !== "object" || p === null) continue;
    const pObj = p as Record<string, unknown>;
    const lvl = [1, 2, 3, 4].includes(Number(pObj.requiredLicenseLevel)) ? Number(pObj.requiredLicenseLevel) : 2;
    const hc = Math.max(1, Math.floor(Number(pObj.headcount) || 1));
    const finalPay = isSiteManager
      ? (Number(siteDefaultPay) || 0)
      : (Number(pObj.payRate) || 0);
    const finalBill = isSiteManager
      ? (Number(siteDefaultBill) || 0)
      : (Number(pObj.billRate) || 0);
    const rateId = isSiteManager ? null : (typeof pObj.siteRateId === "string" ? pObj.siteRateId || null : null);
    const sig = rateId ? `${lvl}|card:${rateId}` : `${lvl}|custom:${finalPay}|${finalBill}`;
    if (seenSignatures.has(sig)) {
      const names: Record<number, string> = { 1: "Support", 2: "L2 Unarmed", 3: "L3 Armed", 4: "L4/PPO" };
      res.status(400).json({ error: "Bad Request", message: `Duplicate position: ${names[lvl] ?? lvl} with the same rate appears twice. Merge the rows or pick a different rate tier.` });
      return;
    }
    seenSignatures.add(sig);
    validPositions.push({
      requiredLicenseLevel: lvl,
      headcount: hc,
      payRate: String(finalPay),
      billRate: String(finalBill),
      siteRateId: rateId,
    });
  }

  if (validPositions.length === 0) {
    res.status(400).json({ error: "Bad Request", message: "No valid positions provided" });
    return;
  }

  const finalShiftType = shiftType === "ppo_detail" ? "ppo_detail" : "standard";

  const inserted = await db.transaction(async (tx) => {
    return tx.insert(shiftsTable).values(validPositions.map((p) => ({
      title,
      siteId: siteId || null,
      clientName: resolvedClientName,
      location: resolvedLocation,
      locationLat: siteLat,
      locationLng: siteLng,
      startTime: startDt,
      endTime: endDt,
      payRate: p.payRate,
      billRate: p.billRate,
      hourlyRate: p.payRate,
      billableRate: p.billRate,
      isRepeat: false,
      notes: notes || null,
      status: "upcoming" as const,
      requiredLicenseLevel: p.requiredLicenseLevel,
      headcount: p.headcount,
      siteRateId: p.siteRateId,
      shiftType: finalShiftType,
    }))).returning();
  });

  // Outbound sync + notifications (mirrors POST /shifts).
  for (const s of inserted) void pushShiftUpsert(s);

  // Push qualifying employees for each shift's license level.
  try {
    const candidates = await db
      .select({ userId: usersTable.id, effLevel: effectiveLevelSql })
      .from(usersTable)
      .leftJoin(licensesTable, eq(licensesTable.employeeId, usersTable.id))
      .leftJoin(employeesTable, eq(employeesTable.userId, usersTable.id))
      .where(and(eq(usersTable.role, "employee"), eq(usersTable.status, "active")))
      .groupBy(usersTable.id);
    const { sendPushToUsers } = await import("../lib/push");
    for (const s of inserted) {
      const eligibleIds = candidates.filter((c) => c.effLevel >= s.requiredLicenseLevel).map((c) => c.userId);
      if (eligibleIds.length > 0) {
        const start = fmtShiftWhen(s.startTime);
        await sendPushToUsers(eligibleIds, {
          title: `🛡️ New ${shiftLevelLabel(s.requiredLicenseLevel)} Shift Available`,
          body: `${s.title} @ ${s.clientName ?? resolvedLocation ?? "—"} — ${start}`,
          data: { type: "shift_available", shiftId: s.id },
        });
      }
    }
  } catch (err) {
    req.log.warn({ err }, "Failed to broadcast new-shift push (bulk-create)");
  }

  // One batched notification to site managers.
  if (inserted.length > 0 && siteId) {
    try {
      const managerIds = (await getSiteManagerUserIds(siteId)).filter((mid) => mid !== req.user!.userId);
      if (managerIds.length > 0) {
        const { sendPushToUsers } = await import("../lib/push");
        const { sendSmsToUsers } = await import("../lib/sms");
        const start = fmtShiftWhen(inserted[0].startTime);
        const where = resolvedClientName ?? resolvedLocation ?? "your site";
        const plural = inserted.length === 1 ? "" : "s";
        await sendPushToUsers(managerIds, {
          title: "🗓️ New Shift at Your Site",
          body: `${inserted.length} ${title} shift${plural} posted at ${where} — ${start}`,
          data: { type: "site_shift_created", siteId, count: String(inserted.length) },
        });
        void sendSmsToUsers(
          managerIds,
          `WCSG: ${inserted.length} new shift${plural} posted at your site (${where}). Open the SecureOps app to manage them.`,
        );
      }
    } catch (err) {
      req.log.warn({ err }, "Failed to notify site managers of bulk-create shifts");
    }
  }

  res.status(201).json({
    created: inserted.length,
    shifts: inserted.map((s) => stripShiftFinanceForRole(req.user!.role, { ...s, assignments: [] })),
  });
});

/**
 * Bulk-create a series of shifts from a recurrence pattern.
 *
 * Body shape:
 *   {
 *     base: {
 *       title, siteId, notes?,
 *       // Single-position (legacy): payRate, billRate, requiredLicenseLevel, headcount, siteRateId
 *       // Multi-position (new):     positions: [{ requiredLicenseLevel, headcount, payRate, billRate, siteRateId? }, ...]
 *     },
 *     recurrence: {
 *       startDate: "YYYY-MM-DD",
 *       untilDate: "YYYY-MM-DD",
 *       daysOfWeek: number[],   // 0=Sun ... 6=Sat
 *       startTime: "HH:MM",
 *       endTime:   "HH:MM",
 *     }
 *   }
 *
 * Multi-position: each position gets its own repeat series (own seriesId).
 * Returns: { created, skippedExisting, totalOccurrences, positions, shifts[] }.
 *
 * Times are stored UTC. Existing shifts at same site + startTime are skipped.
 */
router.post("/shifts/repeat", requireAdminOrSiteManager, async (req, res): Promise<void> => {
  const { base, recurrence } = req.body ?? {};
  if (!base || !recurrence) {
    res.status(400).json({ error: "Bad Request", message: "base and recurrence required" });
    return;
  }
  const {
    title, siteId, payRate, billRate, requiredLicenseLevel, headcount, notes, siteRateId,
    positions: rawPositions,
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

  // Resolve site → clientName/location for back-compat columns, plus default
  // rates so a (rate-blind) site manager's series inherits them.
  const [site] = await db
    .select({ id: sitesTable.id, name: sitesTable.name, status: sitesTable.status, address: sitesTable.address, lat: sitesTable.locationLat, lng: sitesTable.locationLng, clientName: clientsTable.name, defaultPayRate: sitesTable.defaultPayRate, defaultBillRate: sitesTable.defaultBillRate })
    .from(sitesTable)
    .leftJoin(clientsTable, eq(sitesTable.clientId, clientsTable.id))
    .where(eq(sitesTable.id, siteId));
  if (!site) { res.status(400).json({ error: "Bad Request", message: "Site not found" }); return; }
  if (site.status !== "active") {
    res.status(400).json({ error: "Bad Request", message: "This site is inactive — reactivate it before posting new shifts." });
    return;
  }

  // Site managers may only bulk-create against a site they manage.
  const isSiteManager = req.user!.role === "site_manager";
  if (isSiteManager && !(await canManageSite({ userId: req.user!.userId, role: req.user!.role }, siteId))) {
    res.status(403).json({ error: "Forbidden", message: "You can only post shifts to sites you manage." });
    return;
  }

  // Build the canonical list of positions. Multi-position path (new): caller
  // supplies base.positions[]. Single-position path (legacy): fall back to
  // the top-level base fields for backwards compatibility.
  type RepeatPosition = { requiredLicenseLevel: number; headcount: number; pay: number; bill: number; siteRateId: string | null };
  const positions: RepeatPosition[] = [];

  if (Array.isArray(rawPositions) && rawPositions.length > 0) {
    // Duplicates are keyed by SIGNATURE (level + rate selection), not level
    // alone — same level at different rate tiers is a valid staffing pattern.
    const seenSignatures = new Set<string>();
    for (const p of rawPositions as unknown[]) {
      if (typeof p !== "object" || p === null) continue;
      const pObj = p as Record<string, unknown>;
      const lvl = [1, 2, 3, 4].includes(Number(pObj.requiredLicenseLevel)) ? Number(pObj.requiredLicenseLevel) : 2;
      const hc = Math.max(1, Math.floor(Number(pObj.headcount) || 1));
      const pay = isSiteManager ? (Number(site.defaultPayRate) || 0) : (Number(pObj.payRate) || 0);
      const bill = isSiteManager ? (Number(site.defaultBillRate) || 0) : (Number(pObj.billRate) || 0);
      const rateId = isSiteManager ? null : (typeof pObj.siteRateId === "string" ? pObj.siteRateId || null : null);
      const sig = rateId ? `${lvl}|card:${rateId}` : `${lvl}|custom:${pay}|${bill}`;
      if (seenSignatures.has(sig)) {
        const names: Record<number, string> = { 1: "Support", 2: "L2 Unarmed", 3: "L3 Armed", 4: "L4/PPO" };
        res.status(400).json({ error: "Bad Request", message: `Duplicate position: ${names[lvl] ?? lvl} with the same rate appears twice. Merge the rows or pick a different rate tier.` });
        return;
      }
      seenSignatures.add(sig);
      positions.push({
        requiredLicenseLevel: lvl, headcount: hc, pay, bill,
        siteRateId: rateId,
      });
    }
    if (positions.length === 0) {
      res.status(400).json({ error: "Bad Request", message: "No valid positions provided" });
      return;
    }
  } else {
    // Legacy single-position fallback.
    const lvl = [1, 2, 3, 4].includes(Number(requiredLicenseLevel)) ? Number(requiredLicenseLevel) : 2;
    const hc = Math.max(1, Number(headcount) || 1);
    const pay = isSiteManager ? (Number(site.defaultPayRate) || 0) : (Number(payRate) || 0);
    const bill = isSiteManager ? (Number(site.defaultBillRate) || 0) : (Number(billRate) || 0);
    positions.push({ requiredLicenseLevel: lvl, headcount: hc, pay, bill, siteRateId: siteRateId || null });
  }

  // Cap series length to prevent runaway expansion (~1 year of daily shifts).
  // The cap is per-position so multi-position series share the same date range.
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

  // Idempotency: skip occurrences that already exist for each position.
  // Match on siteId + startTime + requiredLicenseLevel + siteRateId so that
  // two rows with the same level but different rate tiers (e.g. L2 Tier 1 and
  // L2 Tier 2) can both be created even when one already exists.
  const existing = await db
    .select({
      startTime: shiftsTable.startTime,
      requiredLicenseLevel: shiftsTable.requiredLicenseLevel,
      siteRateId: shiftsTable.siteRateId,
      payRate: shiftsTable.payRate,
      billRate: shiftsTable.billRate,
    })
    .from(shiftsTable)
    .where(and(
      eq(shiftsTable.siteId, siteId),
      gte(shiftsTable.startTime, occurrences[0].startTime),
      lte(shiftsTable.startTime, occurrences[occurrences.length - 1].startTime),
    ));
  // Key convention mirrors the duplicate-position signature: rate-card rows
  // are identified by the card id, custom rows by their pay+bill values.
  const posKeyOf = (lvl: number, rateId: string | null, pay: unknown, bill: unknown): string =>
    rateId
      ? `${lvl}|card:${rateId}`
      : `${lvl}|custom:${Number(pay) || 0}|${Number(bill) || 0}`;
  // "positionKey|startTimeMs" strings for fast lookup.
  const existingKeys = new Set(
    existing.map((r) =>
      `${posKeyOf(r.requiredLicenseLevel ?? 2, r.siteRateId, r.payRate, r.billRate)}|${new Date(r.startTime).getTime()}`,
    ),
  );

  // Build all rows: for each position, each fresh occurrence = one shift row.
  // Freshness is judged PER POSITION so an existing L2 Tier 1 series doesn't
  // block a new L2 Tier 2 series at the same times.
  // Each position gets its own stable seriesId so the series-group UI works.
  let skippedExisting = 0;
  const allToInsert = positions.flatMap((pos) => {
    const posKey = posKeyOf(pos.requiredLicenseLevel, pos.siteRateId, pos.pay, pos.bill);
    const freshForPos = occurrences.filter((o) => !existingKeys.has(`${posKey}|${o.startTime.getTime()}`));
    skippedExisting += occurrences.length - freshForPos.length;
    const seriesId = randomUUID();
    return freshForPos.map((o) => ({
      title,
      siteId,
      clientName: site.clientName ?? null,
      location: site.address ?? site.name,
      locationLat: site.lat ? String(site.lat) : null,
      locationLng: site.lng ? String(site.lng) : null,
      startTime: o.startTime,
      endTime: o.endTime,
      payRate: String(pos.pay),
      billRate: String(pos.bill),
      hourlyRate: String(pos.pay),
      billableRate: String(pos.bill),
      isRepeat: true,
      repeatPattern,
      seriesId,
      notes: notes || null,
      status: "upcoming" as const,
      requiredLicenseLevel: pos.requiredLicenseLevel,
      headcount: pos.headcount,
      siteRateId: pos.siteRateId,
    }));
  });

  const inserted = allToInsert.length > 0
    ? await db.insert(shiftsTable).values(allToInsert).returning()
    : [];

  // Outbound sync: push each created shift to the scheduler (best-effort).
  for (const s of inserted) void pushShiftUpsert(s);

  // One BATCHED summary to the site's managers (excluding the actor) so a bulk
  // series doesn't fan out one push per occurrence.
  if (inserted.length > 0) {
    try {
      const managerIds = (await getSiteManagerUserIds(siteId)).filter((mid) => mid !== req.user!.userId);
      if (managerIds.length > 0) {
        const { sendPushToUsers } = await import("../lib/push");
        const { sendSmsToUsers } = await import("../lib/sms");
        const firstStart = fmtShiftWhen(inserted[0].startTime);
        const where = site.clientName ?? site.name;
        const plural = inserted.length === 1 ? "" : "s";
        await sendPushToUsers(managerIds, {
          title: "🗓️ New Shifts at Your Site",
          body: `${inserted.length} new ${title} shift${plural} posted at ${where}, starting ${firstStart}.`,
          data: { type: "site_shift_created", siteId, count: String(inserted.length) },
        });
        void sendSmsToUsers(
          managerIds,
          `WCSG: ${inserted.length} new shift${plural} posted at your site (${where}). Open the SecureOps app to manage them.`,
        );
      }
    } catch (err) {
      req.log.warn({ err }, "Failed to notify site managers of repeating shifts");
    }
  }

  res.status(201).json({
    created: inserted.length,
    skippedExisting,
    totalOccurrences: occurrences.length * positions.length,
    positions: positions.length,
    shifts: inserted.map((s) => stripShiftFinanceForRole(req.user!.role, s)),
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

  // Reset syncSource so edits to scheduler-origin records propagate back.
  const setCommon: Record<string, unknown> = { syncSource: "local" };
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

  // Outbound sync: push each updated shift (best-effort). Re-fetch the updated
  // rows so we send current data rather than pre-update values.
  if (updated > 0) {
    const updatedRows = await db.select().from(shiftsTable).where(inArray(shiftsTable.id, ids as string[]));
    for (const s of updatedRows) void pushShiftUpsert(s);
  }

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
  // Fetch externalId/syncSource before deletion so we can push the delete events.
  const toDelete = await db
    .select({ id: shiftsTable.id, externalId: shiftsTable.externalId, syncSource: shiftsTable.syncSource })
    .from(shiftsTable)
    .where(inArray(shiftsTable.id, ids as string[]));

  const result = await db.delete(shiftsTable).where(inArray(shiftsTable.id, ids as string[])).returning({ id: shiftsTable.id });

  // Outbound sync: push delete events (best-effort, skips scheduler-sourced rows).
  for (const s of toDelete) void pushShiftDelete(s);

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

router.get("/shifts/:id", requireStaff, async (req, res): Promise<void> => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const [shift] = await db.select().from(shiftsTable).where(eq(shiftsTable.id, id));
  if (!shift) { res.status(404).json({ error: "Not Found" }); return; }

  // Site managers may only view shift detail for a site they manage, or a shift
  // they're personally rostered on. Admins/dispatchers/officers are unaffected.
  if (req.user!.role === "site_manager") {
    const manages = await canManageSite({ userId: req.user!.userId, role: req.user!.role }, shift.siteId);
    if (!manages) {
      const [mine] = await db
        .select({ id: shiftAssignmentsTable.id })
        .from(shiftAssignmentsTable)
        .where(and(eq(shiftAssignmentsTable.shiftId, id), eq(shiftAssignmentsTable.employeeId, req.user!.userId)))
        .limit(1);
      if (!mine) { res.status(403).json({ error: "Forbidden", message: "You can only view shifts at sites you manage." }); return; }
    }
  }

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

  res.json(stripShiftFinanceForRole(req.user!.role, { ...shift, assignments }));
});

router.put("/shifts/:id", requireAdminOrSiteManager, async (req, res): Promise<void> => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const { title, siteId, startTime, endTime, payRate, billRate, hourlyRate, billableRate, status, notes, requiredLicenseLevel, headcount, siteRateId, shiftType } = req.body;
  // Site managers must not change rates — ignore any rate fields they submit.
  const isSiteManager = req.user!.role === "site_manager";

  // Site managers may only edit shifts at sites they manage (and may only move
  // a shift to another site they also manage). Admins are unrestricted.
  // `siteManagerMovedSite` records a manager moving a shift across two managed
  // sites so we can recompute finance from the destination site below.
  let siteManagerMovedSite = false;
  if (isSiteManager) {
    const [current] = await db
      .select({ siteId: shiftsTable.siteId })
      .from(shiftsTable)
      .where(eq(shiftsTable.id, id));
    if (!current) { res.status(404).json({ error: "Not Found" }); return; }
    const actor = { userId: req.user!.userId, role: req.user!.role };
    if (!(await canManageSite(actor, current.siteId))) {
      res.status(403).json({ error: "Forbidden", message: "You can only edit shifts at sites you manage." });
      return;
    }
    if (siteId && siteId !== current.siteId) {
      if (!(await canManageSite(actor, siteId))) {
        res.status(403).json({ error: "Forbidden", message: "You can only move shifts to sites you manage." });
        return;
      }
      siteManagerMovedSite = true;
    }
  }
  const updates: Record<string, unknown> = {};
  if (title) updates.title = title;
  // Destination site rate defaults, captured when a site change is requested.
  let destDefaultPay: string | null = null;
  let destDefaultBill: string | null = null;
  if (siteId) {
    const [site] = await db
      .select({ name: sitesTable.name, address: sitesTable.address, clientName: clientsTable.name, defaultPayRate: sitesTable.defaultPayRate, defaultBillRate: sitesTable.defaultBillRate })
      .from(sitesTable)
      .leftJoin(clientsTable, eq(sitesTable.clientId, clientsTable.id))
      .where(eq(sitesTable.id, siteId));
    if (site) {
      updates.siteId = siteId;
      updates.clientName = site.clientName;
      updates.location = site.address ?? site.name;
      destDefaultPay = site.defaultPayRate ?? null;
      destDefaultBill = site.defaultBillRate ?? null;
    }
  }
  if (startTime) updates.startTime = new Date(startTime);
  if (endTime) updates.endTime = new Date(endTime);
  if (!isSiteManager) {
    if (payRate !== undefined) { updates.payRate = String(payRate); updates.hourlyRate = String(payRate); }
    if (billRate !== undefined) { updates.billRate = String(billRate); updates.billableRate = String(billRate); }
    if (hourlyRate !== undefined && payRate === undefined) { updates.payRate = String(hourlyRate); updates.hourlyRate = String(hourlyRate); }
    if (billableRate !== undefined && billRate === undefined) { updates.billRate = String(billableRate); updates.billableRate = String(billableRate); }
  }
  if (status) updates.status = status;
  if (notes !== undefined) updates.notes = notes;
  if (requiredLicenseLevel !== undefined && [1, 2, 3, 4].includes(Number(requiredLicenseLevel))) {
    updates.requiredLicenseLevel = Number(requiredLicenseLevel);
  }
  if (headcount !== undefined) updates.headcount = Math.max(1, Number(headcount) || 1);
  // Explicit null clears the FK (admin selected "Custom" rate); undefined leaves it alone.
  // siteRateId points at a `site_rates` card that carries pay/bill rates, so it is
  // finance metadata — site managers must never set it (parity with the rate guard above).
  if (!isSiteManager && siteRateId !== undefined) updates.siteRateId = siteRateId || null;
  // Allowlisted shift-type toggle (standard ↔ ppo_detail); anything else ignored.
  if (shiftType === "standard" || shiftType === "ppo_detail") updates.shiftType = shiftType;

  // A site manager moving a shift to a DIFFERENT managed site must not carry the
  // previous site's admin-set finance onto the new site/client. Recompute pay/bill
  // from the DESTINATION site defaults when available, otherwise 0 — an admin can
  // correct the rate afterwards; blocking the move entirely is worse.
  if (siteManagerMovedSite) {
    updates.payRate = String(Number(destDefaultPay) || 0);
    updates.hourlyRate = String(Number(destDefaultPay) || 0);
    updates.billRate = String(Number(destDefaultBill) || 0);
    updates.billableRate = String(Number(destDefaultBill) || 0);
    updates.siteRateId = null;
  }

  // Always reset syncSource to 'local' on admin edits so that changes to
  // scheduler-origin records (syncSource='scheduler') get pushed back rather
  // than being suppressed by the loop-prevention guard in pushShiftUpsert.
  updates.syncSource = "local";

  const [shift] = await db.update(shiftsTable).set(updates).where(eq(shiftsTable.id, id)).returning();
  if (!shift) { res.status(404).json({ error: "Not Found" }); return; }
  // Outbound sync to scheduler (best-effort, after response)
  void pushShiftUpsert(shift);
  res.json(stripShiftFinanceForRole(req.user!.role, { ...shift, assignments: [] }));
});

router.delete("/shifts/:id", requireAdminOrSiteManager, async (req, res): Promise<void> => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  // Fetch the row before deletion so we can include externalId + syncSource in the push.
  const [toDelete] = await db.select({ id: shiftsTable.id, siteId: shiftsTable.siteId, externalId: shiftsTable.externalId, syncSource: shiftsTable.syncSource }).from(shiftsTable).where(eq(shiftsTable.id, id));
  // Site managers may only delete shifts at sites they manage.
  if (req.user!.role === "site_manager" && !(await canManageSite({ userId: req.user!.userId, role: req.user!.role }, toDelete?.siteId ?? null))) {
    res.status(403).json({ error: "Forbidden", message: "You can only delete shifts at sites you manage." });
    return;
  }
  await db.delete(shiftsTable).where(eq(shiftsTable.id, id));
  // Outbound sync to scheduler (best-effort)
  if (toDelete) void pushShiftDelete(toDelete);
  res.sendStatus(204);
});

router.post("/shifts/:id/claim", requireStaff, async (req, res): Promise<void> => {
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
        ? `This is a support shift — no licence is required. Your account isn't cleared to claim it yet; contact your administrator.`
        : `This shift requires Level ${shift.requiredLicenseLevel}${shift.requiredLicenseLevel === 4 ? "/PPO" : ""}. Your highest valid licence is ${myLevel <= 1 ? "none" : `Level ${myLevel}`}.`,
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

      // Officer self-claim: create a HELD slot pending admin approval. The
      // slot counts toward headcount immediately (the COUNT(*) above includes
      // every status) so the seat can't be double-claimed, but the officer
      // isn't confirmed on the roster until an admin approves (status ->
      // 'accepted'). Rejection deletes the row and frees the seat.
      const inserted = await tx.execute(sql`
        INSERT INTO shift_assignments (shift_id, employee_id, status)
        VALUES (${shiftId}::uuid, ${userId}::uuid, 'pending_approval')
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

  // Let the officer know their request is in (the slot is held, not yet confirmed).
  try {
    const { sendPushToUsers } = await import("../lib/push");
    const start = fmtShiftWhen(shift.startTime);
    await sendPushToUsers([userId], {
      title: "🕓 Shift Request Submitted",
      body: `Your request for ${shift.title} on ${start} is awaiting admin approval.`,
      data: { type: "shift_reserved", shiftId },
    });
  } catch (err) {
    req.log.warn({ err }, "Failed to send claim confirmation push");
  }

  // Notify the approvers that an officer self-claimed and needs a decision:
  // all admins PLUS the managers of this shift's site, de-duplicated and with
  // the claiming officer removed (a site manager can be an officer too).
  try {
    const admins = await db
      .select({ id: usersTable.id })
      .from(usersTable)
      .where(eq(usersTable.role, "admin"));
    const adminIds = admins.map((a) => a.id);
    const managerIds = shift.siteId ? await getSiteManagerUserIds(shift.siteId) : [];
    const recipientIds = Array.from(new Set([...adminIds, ...managerIds])).filter((rid) => rid !== userId);
    if (recipientIds.length) {
      const officerName = user ? `${user.firstName} ${user.lastName}` : "An officer";
      const start = fmtShiftWhen(shift.startTime);
      const { sendPushToUsers } = await import("../lib/push");
      const { sendSmsToUsers } = await import("../lib/sms");
      await sendPushToUsers(recipientIds, {
        title: "🕓 Shift Claim Awaiting Approval",
        body: `${officerName} requested ${shift.title} on ${start}. Tap to approve or decline.`,
        data: { type: "shift_claim_request", shiftId },
      });
      void sendSmsToUsers(
        recipientIds,
        `WCSG: ${officerName} requested ${shift.title} on ${start}. Approve or decline in the SecureOps app.`,
      );
    }
  } catch (err) {
    req.log.warn({ err }, "Failed to notify approvers of shift claim");
  }

  // Keep the scheduler's roster in sync: an officer self-claimed this shift.
  void pushAssignmentEvent({
    action: "created",
    assignmentId: assignment.id,
    shiftId: shift.id,
    shiftExternalId: shift.externalId,
    shiftSyncSource: shift.syncSource,
    employeeEmail: user?.email ?? "",
    employeeName: user ? `${user.firstName} ${user.lastName}` : "",
    status: assignment.status,
  });

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
      const start = fmtShiftWhen(shift.startTime);
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

router.post("/shifts/:id/assignments", requireSchedulingStaff, async (req, res): Promise<void> => {
  const shiftId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const { employeeId, overrideLicense } = req.body;
  if (!employeeId) { res.status(400).json({ error: "Bad Request", message: "employeeId required" }); return; }

  const [shift] = await db.select().from(shiftsTable).where(eq(shiftsTable.id, shiftId));
  if (!shift) { res.status(404).json({ error: "Not Found" }); return; }

  // Site-scope gate: requireSchedulingStaff proves the caller holds a
  // scheduling role, but a site manager may only assign officers to shifts at
  // sites they manage. Admins/dispatchers are unscoped.
  if (
    req.user!.role === "site_manager" &&
    !(await canManageSite({ userId: req.user!.userId, role: req.user!.role }, shift.siteId))
  ) {
    res.status(403).json({ error: "Forbidden", message: "You do not manage this site" });
    return;
  }

  // License-level gate. Admins and dispatchers may explicitly override it
  // (e.g. an officer whose renewal is in flight, or a judgement call for an
  // urgent post) by passing `overrideLicense: true`. The override skips ONLY
  // this clearance check — the double-book conflict guard and headcount cap
  // below still apply. The override is recorded in the audit log (this route
  // is under the audited `/shifts` prefix and the request body is captured).
  //
  // Worker-role staff (admin, dispatcher, site_manager) are always treated as
  // level 4 — they are management staff who can work any shift, identical to
  // how the shift-list route computes myMaxLevel for the authenticated user.
  const [assigneeUser] = await db
    .select({ role: usersTable.role })
    .from(usersTable)
    .where(eq(usersTable.id, employeeId))
    .limit(1);
  if (!assigneeUser) {
    res.status(404).json({ error: "Not Found", message: "Employee not found" });
    return;
  }
  // Worker-role gate: only staff accounts can be put on a roster. Client-portal
  // accounts (role="client") are external customer contacts — with the
  // universal Level-1 baseline they would otherwise pass the clearance check
  // for support shifts, so reject them explicitly before any level math.
  const WORKER_ROLES = ["admin", "dispatcher", "employee", "site_manager"] as const;
  if (!WORKER_ROLES.includes(assigneeUser.role as (typeof WORKER_ROLES)[number])) {
    res.status(403).json({
      error: "Forbidden",
      message: "Only staff accounts can be assigned to shifts.",
    });
    return;
  }
  const MGMT_ROLES = ["admin", "dispatcher", "site_manager"] as const;
  const empLevel = MGMT_ROLES.includes(assigneeUser.role as (typeof MGMT_ROLES)[number])
    ? 4
    : await getEffectiveLevel(employeeId);
  // Only finance-bearing scheduling staff (admin/dispatcher) may override the
  // licence gate; site managers must never bypass clearance requirements.
  const canOverrideLicense =
    overrideLicense === true && (req.user!.role === "admin" || req.user!.role === "dispatcher");
  if (empLevel < shift.requiredLicenseLevel) {
    if (canOverrideLicense) {
      req.log.warn(
        { shiftId, employeeId, empLevel, requiredLicenseLevel: shift.requiredLicenseLevel, actor: req.user?.userId },
        "license requirement overridden on manual shift assignment",
      );
    } else {
      res.status(403).json({
        error: "Forbidden",
        message: `Employee's clearance (Level ${empLevel}) does not meet the shift requirement (Level ${shift.requiredLicenseLevel}${shift.requiredLicenseLevel === 4 ? "/PPO" : ""}).`,
      });
      return;
    }
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
    const start = fmtShiftWhen(shift.startTime);
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

  // Keep the scheduler's roster in sync: an officer was added to this shift.
  void pushAssignmentEvent({
    action: "created",
    assignmentId: assignment.id,
    shiftId: shift.id,
    shiftExternalId: shift.externalId,
    shiftSyncSource: shift.syncSource,
    employeeEmail: user?.email ?? "",
    employeeName: user ? `${user.firstName} ${user.lastName}` : "",
    status: assignment.status,
  });

  res.status(201).json({ ...assignment, employeeName: user ? `${user.firstName} ${user.lastName}` : null });
});

router.put("/shifts/:id/assignments/:assignmentId", requireStaff, async (req, res): Promise<void> => {
  const assignmentId = Array.isArray(req.params.assignmentId) ? req.params.assignmentId[0] : req.params.assignmentId;
  const { status } = req.body;
  if (!status) { res.status(400).json({ error: "Bad Request", message: "status required" }); return; }

  const [existing] = await db.select().from(shiftAssignmentsTable).where(eq(shiftAssignmentsTable.id, assignmentId));
  if (!existing) { res.status(404).json({ error: "Not Found" }); return; }

  // Admins manage any roster; site managers manage the roster only for shifts
  // at sites they're assigned to (remove an officer to free a slot, or
  // approve/decline a self-claim). Everyone else can only modify their own
  // assignment.
  let canManageRoster = req.user!.role === "admin";
  if (req.user!.role === "site_manager") {
    const [parentForScope] = await db
      .select({ siteId: shiftsTable.siteId })
      .from(shiftsTable)
      .where(eq(shiftsTable.id, existing.shiftId));
    canManageRoster = await canManageSite(
      { userId: req.user!.userId, role: req.user!.role },
      parentForScope?.siteId ?? null,
    );
  }
  if (!canManageRoster && existing.employeeId !== req.user!.userId) {
    res.status(403).json({ error: "Forbidden", message: "You can only update your own assignments" });
    return;
  }

  // Declining frees the slot — delete the assignment row so headcount opens back up.
  if (status === "declined") {
    await db.delete(shiftAssignmentsTable).where(eq(shiftAssignmentsTable.id, assignmentId));

    // Keep the scheduler's roster in sync: an officer was removed from this shift.
    const [parentShift] = await db
      .select({ id: shiftsTable.id, title: shiftsTable.title, startTime: shiftsTable.startTime, externalId: shiftsTable.externalId, syncSource: shiftsTable.syncSource })
      .from(shiftsTable)
      .where(eq(shiftsTable.id, existing.shiftId));
    const [declinedUser] = await db.select().from(usersTable).where(eq(usersTable.id, existing.employeeId));
    if (parentShift) {
      void pushAssignmentEvent({
        action: "deleted",
        assignmentId,
        shiftId: existing.shiftId,
        shiftExternalId: parentShift.externalId,
        shiftSyncSource: parentShift.syncSource,
        employeeEmail: declinedUser?.email ?? "",
        employeeName: declinedUser ? `${declinedUser.firstName} ${declinedUser.lastName}` : "",
        status: "declined",
      });
    }

    // If an admin/site manager rejected an officer's pending self-claim, tell the
    // officer their request wasn't approved and the slot is open again.
    if (
      canManageRoster &&
      existing.status === "pending_approval" &&
      existing.employeeId !== req.user!.userId
    ) {
      try {
        const { sendPushToUsers } = await import("../lib/push");
        const start = parentShift ? fmtShiftWhen(parentShift.startTime) : "";
        await sendPushToUsers([existing.employeeId], {
          title: "Shift Request Declined",
          body: `Your request for ${parentShift?.title ?? "a shift"}${start ? ` on ${start}` : ""} wasn't approved. The slot is open again.`,
          data: { type: "shift_available", shiftId: existing.shiftId },
        });
      } catch (err) {
        req.log.warn({ err }, "Failed to send claim rejection push");
      }
    }

    res.json({ id: assignmentId, status: "declined", removed: true });
    return;
  }

  // A non-manager (officer) may only ACCEPT an admin-issued invite
  // (existing.status === 'pending'). They must never be able to approve their
  // own self-claim (pending_approval -> accepted) or set any other status —
  // approving a claim is an admin/site-manager-only decision. (Declining their
  // own row is already handled above.)
  if (!canManageRoster && !(status === "accepted" && existing.status === "pending")) {
    res.status(403).json({ error: "Forbidden", message: "Only an admin or site manager can approve this request" });
    return;
  }

  // Capture whether this is an admin/site manager approving an officer's self-claim
  // BEFORE we overwrite the status, so we can confirm them on the roster and
  // notify them. (Officer-accepts-an-admin-invite — existing.status 'pending',
  // actor === employee — is intentionally excluded.)
  const isApprovingClaim =
    existing.status === "pending_approval" &&
    canManageRoster &&
    existing.employeeId !== req.user!.userId &&
    status === "accepted";

  const [assignment] = await db.update(shiftAssignmentsTable).set({ status }).where(eq(shiftAssignmentsTable.id, assignmentId)).returning();
  if (!assignment) { res.status(404).json({ error: "Not Found" }); return; }
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, assignment.employeeId));

  if (isApprovingClaim) {
    const [parentShift] = await db
      .select({ id: shiftsTable.id, title: shiftsTable.title, startTime: shiftsTable.startTime, externalId: shiftsTable.externalId, syncSource: shiftsTable.syncSource })
      .from(shiftsTable)
      .where(eq(shiftsTable.id, existing.shiftId));
    // Now confirmed — sync the accepted assignment onto the scheduler roster.
    if (parentShift) {
      void pushAssignmentEvent({
        action: "created",
        assignmentId,
        shiftId: existing.shiftId,
        shiftExternalId: parentShift.externalId,
        shiftSyncSource: parentShift.syncSource,
        employeeEmail: user?.email ?? "",
        employeeName: user ? `${user.firstName} ${user.lastName}` : "",
        status: "accepted",
      });
    }
    try {
      const { sendPushToUsers } = await import("../lib/push");
      const start = parentShift ? fmtShiftWhen(parentShift.startTime) : "";
      await sendPushToUsers([assignment.employeeId], {
        title: "✅ Shift Request Approved",
        body: `You're confirmed for ${parentShift?.title ?? "your shift"}${start ? ` on ${start}` : ""}.`,
        data: { type: "shift_assigned", shiftId: existing.shiftId },
      });
    } catch (err) {
      req.log.warn({ err }, "Failed to send claim approval push");
    }
  }

  res.json({ ...assignment, employeeName: user ? `${user.firstName} ${user.lastName}` : null });
});

export default router;
