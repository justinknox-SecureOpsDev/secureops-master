import { Router, type IRouter } from "express";
import { eq, and, gte, lte, ne, isNull, inArray, sql } from "drizzle-orm";
import { db, timeEntriesTable, shiftsTable, usersTable, sitesTable, shiftAssignmentsTable, licensesTable } from "@workspace/db";
import { requireAuth, requireAdmin, requireAdminOrSiteManager, requireStaff } from "../middlewares/auth";
import { upsertWeeklyInvoiceForTimeEntry } from "../lib/invoiceSync";
import { pushClockEvent } from "../lib/schedulerSync";
import { getEffectiveLevel } from "../lib/eligibility";
import { buildTimeEntryAuditMetadata, timeEntrySnapshot } from "../lib/timeEntryAudit";
import { stripTimeEntryBillRateForRole } from "../lib/financeVisibility";
import { canManageSite, getManagedSiteIds } from "../lib/siteManagerAuthz";
import { broadcastOfficerLeft, broadcastOfficerJoined } from "../lib/wsManager";
import { businessTimeZone, businessDateIso, businessDateToUtc, businessDayWindow, startOfBusinessWeek } from "../lib/businessTime";

const router: IRouter = Router();

function calcHours(clockIn: Date, clockOut: Date): number {
  return Math.round(((clockOut.getTime() - clockIn.getTime()) / 3600000) * 100) / 100;
}

const SHIFT_MATCH_GRACE_MS = 60 * 60 * 1000;

// Find a scheduled shift at `siteId` whose window contains `whenAt`
// (± 60-min grace). Used by clock-in (auto-attach for ad-hoc geo
// clock-ins) and the backfill admin route — the goal is to recover the
// per-shift `billRate` so the client gets billed at the rate posted for
// that slot. We deliberately do NOT require the employee to have an
// accepted assignment: client billing depends on the scheduled rate for
// the slot, not on which officer ultimately covered it (fill-ins, last-
// minute swaps, and pre-assignment-tracking history all need to bill
// correctly). The officer's *pay* rate is resolved separately by the
// payroll board and is not affected here.
//
// `employeeId` is accepted for symmetry/logging and possible future
// preference (e.g. prefer an assigned shift if multiple match), but is
// not currently used in the WHERE clause. Disambiguation when multiple
// shifts overlap: pick the one whose startTime is closest to whenAt.
// Skips junk seed rows pinned to the year 2099.
export async function findMatchingScheduledShift(
  _employeeId: string,
  siteId: string,
  whenAt: Date,
): Promise<string | null> {
  const lowerBound = new Date(whenAt.getTime() - SHIFT_MATCH_GRACE_MS);
  const upperBound = new Date(whenAt.getTime() + SHIFT_MATCH_GRACE_MS);
  const farFutureCutoff = new Date("2090-01-01T00:00:00Z");
  const hits = await db
    .select({ id: shiftsTable.id, startTime: shiftsTable.startTime })
    .from(shiftsTable)
    .where(and(
      eq(shiftsTable.siteId, siteId),
      lte(shiftsTable.startTime, upperBound),
      gte(shiftsTable.endTime, lowerBound),
      lte(shiftsTable.startTime, farFutureCutoff),
    ));
  if (hits.length === 0) return null;
  if (hits.length === 1) return hits[0].id;
  let best = hits[0];
  let bestDelta = Math.abs(best.startTime.getTime() - whenAt.getTime());
  for (const h of hits.slice(1)) {
    const d = Math.abs(h.startTime.getTime() - whenAt.getTime());
    if (d < bestDelta) { best = h; bestDelta = d; }
  }
  return best.id;
}

// Pick the candidate whose startTime is closest to `whenAt`.
function closestByStart<T extends { startTime: Date }>(rows: T[], whenAt: Date): T | null {
  if (rows.length === 0) return null;
  let best = rows[0];
  let bestDelta = Math.abs(best.startTime.getTime() - whenAt.getTime());
  for (const r of rows.slice(1)) {
    const d = Math.abs(r.startTime.getTime() - whenAt.getTime());
    if (d < bestDelta) { best = r; bestDelta = d; }
  }
  return best;
}

// Clock-in window: an officer may only clock into a shift from 30 minutes
// before its scheduled start until its scheduled end. Blocks clocking into a
// wrong-date / not-yet-started shift (e.g. tapping OR site-picking a shift
// days out) which otherwise polluted the Dispatch board with phantom "on
// duty" officers attached to a shift outside today. Late officers may still
// clock in during the shift (flagged "late" on the board). Admins bypass this
// — they fix stuck records / cover posts on others' behalf via the dedicated
// dispatch on-behalf endpoint. Returns a 409-shaped rejection, or null when
// the current time is inside the allowed window.
const CLOCK_IN_EARLY_GRACE_MS = 30 * 60_000;

function clockInWindowRejection(
  shift: { startTime: Date; endTime: Date },
  now: Date,
): { error: string; code: string; message: string } | null {
  const opensAt = new Date(shift.startTime.getTime() - CLOCK_IN_EARLY_GRACE_MS);
  const tz = process.env.PAYROLL_TIMEZONE?.trim() || "America/Chicago";
  const fmtWhen = (d: Date): string =>
    d.toLocaleString("en-US", {
      timeZone: tz, weekday: "short", month: "short", day: "numeric",
      hour: "numeric", minute: "2-digit",
    });
  if (now < opensAt) {
    return {
      error: "Too Early",
      code: "clock_in_too_early",
      message: `This shift starts ${fmtWhen(shift.startTime)}. You can clock in from ${fmtWhen(opensAt)} (30 minutes before the start).`,
    };
  }
  if (now > shift.endTime) {
    return {
      error: "Shift Ended",
      code: "clock_in_after_end",
      message: `This shift ended ${fmtWhen(shift.endTime)}. Ask your supervisor to record this time for you.`,
    };
  }
  return null;
}

// Resolve which scheduled shift an ad-hoc geo clock-in should attach to,
// auto-assigning the officer to an open shift when they aren't already
// rostered. This is what makes a clocked-in officer surface on the Dispatch
// clock-in status board: that board is driven entirely by *accepted*
// shift_assignments, so an officer with only an open time entry (and no
// assignment) never appears as "on duty". Resolution order:
//
//   1. The officer already has an accepted assignment for a shift at this
//      site whose window contains "now" (±60-min grace) — attach to that
//      shift (closest start). No new assignment.
//   2. No assignment yet → find an OPEN shift (accepted count < headcount)
//      at this site in the window and atomically self-assign the officer to
//      it (race-safe: FOR UPDATE on the shift row + headcount re-check,
//      mirroring POST /shifts/:id/claim). Returns that shift.
//   3. Nothing open / nothing matched → fall back to the billing-only
//      attach (findMatchingScheduledShift) so per-shift billRate is still
//      recovered for invoicing even when no slot could be claimed.
async function resolveOrAssignShiftForAdHocClockIn(
  employeeId: string,
  siteId: string,
  whenAt: Date,
  log: { info: (obj: unknown, msg: string) => void; warn: (obj: unknown, msg: string) => void },
): Promise<string | null> {
  const lowerBound = new Date(whenAt.getTime() - SHIFT_MATCH_GRACE_MS);
  const upperBound = new Date(whenAt.getTime() + SHIFT_MATCH_GRACE_MS);
  const farFutureCutoff = new Date("2090-01-01T00:00:00Z");

  // 1. Already rostered on a shift at this site in the window.
  const assigned = await db
    .select({ id: shiftsTable.id, startTime: shiftsTable.startTime })
    .from(shiftAssignmentsTable)
    .innerJoin(shiftsTable, eq(shiftAssignmentsTable.shiftId, shiftsTable.id))
    .where(and(
      eq(shiftAssignmentsTable.employeeId, employeeId),
      eq(shiftAssignmentsTable.status, "accepted"),
      eq(shiftsTable.siteId, siteId),
      lte(shiftsTable.startTime, upperBound),
      gte(shiftsTable.endTime, lowerBound),
      lte(shiftsTable.startTime, farFutureCutoff),
    ));
  const ownShift = closestByStart(assigned, whenAt);
  if (ownShift) return ownShift.id;

  // 2. Not rostered — look for an open shift at this site to auto-assign.
  // Only shifts the officer is actually eligible for: the auto-assign must
  // honour the same licence hierarchy the manual claim route enforces, so we
  // never create an assignment record asserting an under-licensed officer
  // covered a higher-level (e.g. armed) shift. Effective level = MAX(highest
  // unexpired licence, worker baseline of 1); higher covers lower — every
  // worker qualifies for level-1 support shifts with no licence.
  const effectiveLevel = await getEffectiveLevel(employeeId);
  const candidates = await db
    .select({
      id: shiftsTable.id,
      startTime: shiftsTable.startTime,
      headcount: shiftsTable.headcount,
      requiredLicenseLevel: shiftsTable.requiredLicenseLevel,
      filled: sql<number>`(
        SELECT count(*)::int FROM ${shiftAssignmentsTable}
        WHERE ${shiftAssignmentsTable.shiftId} = ${shiftsTable.id}
          AND ${shiftAssignmentsTable.status} = 'accepted'
      )`,
    })
    .from(shiftsTable)
    .where(and(
      eq(shiftsTable.siteId, siteId),
      lte(shiftsTable.startTime, upperBound),
      gte(shiftsTable.endTime, lowerBound),
      lte(shiftsTable.startTime, farFutureCutoff),
      ne(shiftsTable.status, "cancelled"),
      ne(shiftsTable.status, "completed"),
    ));

  // Try open shifts in order of closeness to "now". Stop at the first one we
  // can atomically claim a slot on. Skip shifts requiring a higher licence
  // level than the officer holds.
  const openOrdered = candidates
    .filter((c) => c.filled < c.headcount && c.requiredLicenseLevel <= effectiveLevel)
    .sort((a, b) =>
      Math.abs(a.startTime.getTime() - whenAt.getTime()) -
      Math.abs(b.startTime.getTime() - whenAt.getTime()),
    );

  for (const c of openOrdered) {
    try {
      const claimed = await db.transaction(async (tx) => {
        // Lock the shift row so concurrent claims serialize on it.
        const locked = await tx.execute(sql`
          SELECT headcount FROM shifts WHERE id = ${c.id}::uuid FOR UPDATE
        `);
        const lockedRow = (locked as any).rows?.[0];
        if (!lockedRow) return false;
        const headcount: number = lockedRow.headcount;

        // Already assigned (shouldn't happen — step 1 covers it — but the
        // unique index makes this race-safe anyway).
        const dupRes = await tx.execute(sql`
          SELECT 1 FROM shift_assignments
          WHERE shift_id = ${c.id}::uuid AND employee_id = ${employeeId}::uuid
          LIMIT 1
        `);
        if ((dupRes as any).rows?.length) return true;

        // Count ALL assignment rows (any status), mirroring the authoritative
        // recheck in POST /shifts/:id/claim. Declines DELETE the row, so in
        // practice every row is 'accepted'; counting all keeps the fullness
        // gate identical to the manual claim path.
        const countRes = await tx.execute(sql`
          SELECT count(*)::int AS c FROM shift_assignments
          WHERE shift_id = ${c.id}::uuid
        `);
        const filled: number = (countRes as any).rows?.[0]?.c ?? 0;
        if (filled >= headcount) return false;

        await tx.execute(sql`
          INSERT INTO shift_assignments (shift_id, employee_id, status)
          VALUES (${c.id}::uuid, ${employeeId}::uuid, 'accepted')
        `);
        return true;
      });
      if (claimed) {
        log.info(
          { employeeId, siteId, shiftId: c.id },
          "[clock-in] auto-assigned ad-hoc clock-in to open shift at site",
        );
        return c.id;
      }
    } catch (err) {
      log.warn({ err, shiftId: c.id }, "[clock-in] auto-assign attempt failed, trying next open shift");
    }
  }

  // 3. Nothing claimable — fall back to billing-only attach.
  return findMatchingScheduledShift(employeeId, siteId, whenAt);
}

// How long after a shift ends an officer may still self-clock-in to its site
// via the GPS-less manual picker (covers late clock-ins). There is no early
// bound beyond excluding far-future seed rows — an officer rostered at a site
// is allowed to pick it. Used to gate BOTH the picker list AND the explicit-
// siteId clock-in path so a clock-in carrying no location proof can only land
// on a site the officer is actually rostered at. Blocks remote-site time /
// dispatch spoofing introduced by trusting an arbitrary picked siteId.
const CLOCK_IN_PICK_END_GRACE_MS = 2 * 60 * 60 * 1000;

// Accepted, live-or-upcoming shifts for an officer (any site), used to derive
// which sites the manual picker may offer and which the explicit-siteId path
// may accept. Excludes cancelled/completed shifts and 2099 seed junk.
async function officerRosteredShiftsForPicker(
  employeeId: string,
  whenAt: Date,
): Promise<Array<{ shiftId: string; siteId: string | null; startTime: Date; endTime: Date; requiredLicenseLevel: number | null }>> {
  const endFloor = new Date(whenAt.getTime() - CLOCK_IN_PICK_END_GRACE_MS);
  const farFutureCutoff = new Date("2090-01-01T00:00:00Z");
  return db
    .select({ shiftId: shiftsTable.id, siteId: shiftsTable.siteId, startTime: shiftsTable.startTime, endTime: shiftsTable.endTime, requiredLicenseLevel: shiftsTable.requiredLicenseLevel })
    .from(shiftAssignmentsTable)
    .innerJoin(shiftsTable, eq(shiftAssignmentsTable.shiftId, shiftsTable.id))
    .where(and(
      eq(shiftAssignmentsTable.employeeId, employeeId),
      eq(shiftAssignmentsTable.status, "accepted"),
      ne(shiftsTable.status, "cancelled"),
      ne(shiftsTable.status, "completed"),
      gte(shiftsTable.endTime, endFloor),
      lte(shiftsTable.startTime, farFutureCutoff),
    ));
}

// Coalesce: prefer the time entry's direct siteId (set by geo-resolution when no shift),
// otherwise fall back to the linked shift's siteId.
const baseSelect = {
  id: timeEntriesTable.id,
  shiftId: timeEntriesTable.shiftId,
  employeeId: timeEntriesTable.employeeId,
  clockInTime: timeEntriesTable.clockInTime,
  clockInLat: timeEntriesTable.clockInLat,
  clockInLng: timeEntriesTable.clockInLng,
  clockOutTime: timeEntriesTable.clockOutTime,
  clockOutLat: timeEntriesTable.clockOutLat,
  clockOutLng: timeEntriesTable.clockOutLng,
  hoursWorked: timeEntriesTable.hoursWorked,
  isVerified: timeEntriesTable.isVerified,
  approvalStatus: timeEntriesTable.approvalStatus,
  approvedAt: timeEntriesTable.approvedAt,
  approvedBy: timeEntriesTable.approvedBy,
  notes: timeEntriesTable.notes,
  correctionRequested: timeEntriesTable.correctionRequested,
  correctionNote: timeEntriesTable.correctionNote,
  confirmationStatus: timeEntriesTable.confirmationStatus,
  originalClockInTime: timeEntriesTable.originalClockInTime,
  originalClockOutTime: timeEntriesTable.originalClockOutTime,
  employeeEdited: timeEntriesTable.employeeEdited,
  employeeEditReason: timeEntriesTable.employeeEditReason,
  confirmedAt: timeEntriesTable.confirmedAt,
  createdAt: timeEntriesTable.createdAt,
  shiftTitle: shiftsTable.title,
  siteId: sql<string | null>`coalesce(${timeEntriesTable.siteId}, ${shiftsTable.siteId})`,
  siteName: sitesTable.name,
  payRate: shiftsTable.payRate,
  billRate: shiftsTable.billRate,
  employeeName: sql<string>`${usersTable.firstName} || ' ' || ${usersTable.lastName}`,
};

// Haversine distance in miles between two lat/lng points.
function haversineMiles(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 3958.7613;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

const GEO_RESOLVE_RADIUS_MILES = 1;

// Find the closest Site within GEO_RESOLVE_RADIUS_MILES of (lat, lng), or null.
async function resolveNearestSite(lat: number, lng: number): Promise<{ id: string; name: string; distanceMiles: number } | null> {
  const sites = await db
    .select({ id: sitesTable.id, name: sitesTable.name, lat: sitesTable.locationLat, lng: sitesTable.locationLng })
    .from(sitesTable)
    .where(and(
      eq(sitesTable.status, "active"),
      sql`${sitesTable.locationLat} IS NOT NULL`,
      sql`${sitesTable.locationLng} IS NOT NULL`,
    ));
  let best: { id: string; name: string; distanceMiles: number } | null = null;
  for (const s of sites) {
    if (s.lat == null || s.lng == null) continue;
    const d = haversineMiles(lat, lng, Number(s.lat), Number(s.lng));
    if (d <= GEO_RESOLVE_RADIUS_MILES && (!best || d < best.distanceMiles)) {
      best = { id: s.id, name: s.name, distanceMiles: d };
    }
  }
  return best;
}

// Minimal site list for the officer manual clock-in picker (web GPS fallback).
// Employees can't call admin /sites, so this exposes ONLY the fields the picker
// needs (id, name, address, coords) — no client, bill rate, geofence or notes.
router.get("/me/clock-in-sites", requireStaff, async (req, res): Promise<void> => {
  // Non-admins only see sites they're actually rostered at (an accepted, live-or-
  // upcoming shift). The picker is the GPS-less clock-in fallback, so leaving it
  // unfiltered would let an officer self-clock-in to an arbitrary remote site.
  // Admins (covering a post / troubleshooting a stuck record) see every site.
  let allowedSiteIds: string[] | null = null;
  if (req.user!.role !== "admin") {
    const rostered = await officerRosteredShiftsForPicker(req.user!.userId, new Date());
    allowedSiteIds = [...new Set(rostered.map((r) => r.siteId).filter((x): x is string => x != null))];
    if (allowedSiteIds.length === 0) {
      res.json([]);
      return;
    }
  }
  const rows = await db
    .select({
      id: sitesTable.id,
      name: sitesTable.name,
      address: sitesTable.address,
      locationLat: sitesTable.locationLat,
      locationLng: sitesTable.locationLng,
    })
    .from(sitesTable)
    .where(
      allowedSiteIds
        ? and(eq(sitesTable.status, "active"), inArray(sitesTable.id, allowedSiteIds))
        : eq(sitesTable.status, "active"),
    )
    .orderBy(sitesTable.name);
  res.json(rows);
});

// Reserved shifts the current officer can clock into RIGHT NOW. This is the
// preferred manual clock-in picker: selecting a shift binds the time entry to
// that shift, so payRate/billRate resolve from the shift and payroll/invoicing
// stay clean (vs. an ad-hoc site pick that carries no rate). Only shifts inside
// the live clock-in window are returned — from 30 min before start until end —
// mirroring clockInWindowRejection, so the list never offers a shift the
// /clock-in handler would reject. Officer-facing: NO finance fields exposed.
router.get("/me/clock-in-shifts", requireStaff, async (req, res): Promise<void> => {
  const now = new Date();
  const opensCutoff = new Date(now.getTime() + CLOCK_IN_EARLY_GRACE_MS);
  const farFutureCutoff = new Date("2090-01-01T00:00:00Z");
  const rows = await db
    .select({
      shiftId: shiftsTable.id,
      title: shiftsTable.title,
      siteId: shiftsTable.siteId,
      siteName: sitesTable.name,
      address: sitesTable.address,
      startTime: shiftsTable.startTime,
      endTime: shiftsTable.endTime,
    })
    .from(shiftAssignmentsTable)
    .innerJoin(shiftsTable, eq(shiftAssignmentsTable.shiftId, shiftsTable.id))
    .leftJoin(sitesTable, eq(shiftsTable.siteId, sitesTable.id))
    .where(and(
      eq(shiftAssignmentsTable.employeeId, req.user!.userId),
      eq(shiftAssignmentsTable.status, "accepted"),
      ne(shiftsTable.status, "cancelled"),
      ne(shiftsTable.status, "completed"),
      // Window: now >= startTime - 30min  AND  now <= endTime.
      lte(shiftsTable.startTime, opensCutoff),
      gte(shiftsTable.endTime, now),
      lte(shiftsTable.startTime, farFutureCutoff),
    ))
    .orderBy(shiftsTable.startTime);
  res.json(rows);
});

router.get("/time-entries", requireStaff, async (req, res): Promise<void> => {
  const { employeeId, shiftId, siteId, approvalStatus, from, to } = req.query as Record<string, string | undefined>;

  const conditions = [];
  const role = req.user!.role;
  if (role === "admin") {
    if (employeeId) conditions.push(eq(timeEntriesTable.employeeId, employeeId));
  } else if (role === "site_manager") {
    // Site managers see every entry at the sites they manage (so they can
    // approve them), scoped by the entry's resolved site. No managed sites →
    // nothing to show.
    const managed = await getManagedSiteIds(req.user!.userId);
    if (managed.length === 0) { res.json([]); return; }
    conditions.push(inArray(sql`coalesce(${timeEntriesTable.siteId}, ${shiftsTable.siteId})`, managed));
    if (employeeId) conditions.push(eq(timeEntriesTable.employeeId, employeeId));
  } else {
    conditions.push(eq(timeEntriesTable.employeeId, req.user!.userId));
  }
  if (shiftId) conditions.push(eq(timeEntriesTable.shiftId, shiftId));
  if (siteId) conditions.push(sql`coalesce(${timeEntriesTable.siteId}, ${shiftsTable.siteId}) = ${siteId}`);
  if (approvalStatus) conditions.push(eq(timeEntriesTable.approvalStatus, approvalStatus));
  if (from) conditions.push(gte(timeEntriesTable.clockInTime, new Date(from)));
  if (to) conditions.push(lte(timeEntriesTable.clockInTime, new Date(to)));

  const rows = await db
    .select(baseSelect)
    .from(timeEntriesTable)
    .leftJoin(shiftsTable, eq(timeEntriesTable.shiftId, shiftsTable.id))
    .leftJoin(sitesTable, sql`${sitesTable.id} = coalesce(${timeEntriesTable.siteId}, ${shiftsTable.siteId})`)
    .leftJoin(usersTable, eq(timeEntriesTable.employeeId, usersTable.id))
    .where(conditions.length > 0 ? and(...conditions) : undefined);

  res.json(rows.map((r) => stripTimeEntryBillRateForRole(req.user!.role, r)));
});

router.post("/time-entries/clock-in", requireStaff, async (req, res): Promise<void> => {
  const { shiftId, siteId: bodySiteId, lat, lng, notes } = req.body;
  const hasCoords = lat != null && lng != null;
  // Coordinates are only mandatory for the geo-resolve path. When the officer
  // selects a shift (shiftId) or explicitly picks their site (siteId) we trust
  // that choice and don't need GPS — critical for venues whose Site has no
  // saved coordinates, where geo-resolution can never match.
  if (!hasCoords && !shiftId && !bodySiteId) {
    res.status(400).json({ error: "Bad Request", message: "Provide your location, pick your site, or select a reserved shift to clock in." });
    return;
  }
  const existing = await db
    .select()
    .from(timeEntriesTable)
    .where(and(eq(timeEntriesTable.employeeId, req.user!.userId), isNull(timeEntriesTable.clockOutTime)));

  if (existing.length > 0) {
    res.status(400).json({ error: "Bad Request", message: "Already clocked in" });
    return;
  }

  // License compliance is LEVEL-AWARE: every worker has a baseline effective
  // level of 1 (Support — no license required), so an unlicensed worker may
  // clock in to Level-1 work and ad-hoc (no-shift) entries. Shifts requiring
  // Level 2+ still demand an unexpired license of that level at clock-in time
  // (catches licenses that lapsed AFTER the officer was rostered). Admins are
  // exempt (they may be covering a post or fixing a stuck record).
  const myEffectiveLevel =
    req.user!.role !== "admin" ? await getEffectiveLevel(req.user!.userId) : Number.MAX_SAFE_INTEGER;
  const levelRejection = (requiredLevel: number): { error: string; code: string; message: string } => ({
    error: "Forbidden",
    code: "license_expired",
    message: `This shift requires a Level ${requiredLevel} license and your license is expired or missing. Upload a renewed license from Profile → My licenses before clocking in.`,
  });

  // Geo-resolve site if no shiftId provided.
  let resolvedSite: { id: string; name: string; distanceMiles: number } | null = null;
  let assignedShiftSiteId: string | null = null;
  let pickedSite: { id: string; name: string } | null = null;
  let pickedOwnShiftId: string | null = null;
  if (shiftId) {
    // Validate the shift exists and the user is assigned to it (admins may
    // clock in on behalf of any user, but normal employees can only clock in
    // to shifts they have an accepted assignment for). When shiftId is
    // provided we skip the geo-radius check entirely and just trust the
    // assignment — this is the "click on my shift to clock in" flow.
    const [shift] = await db.select().from(shiftsTable).where(eq(shiftsTable.id, shiftId));
    if (!shift) {
      res.status(404).json({ error: "Not Found", message: "Shift not found" });
      return;
    }
    if (shift.status === "completed" || shift.status === "cancelled") {
      res.status(409).json({
        error: "Conflict",
        message: `This shift is ${shift.status} — you can't clock in to it.`,
      });
      return;
    }
    if (req.user!.role !== "admin") {
      const assignment = await db
        .select()
        .from(shiftAssignmentsTable)
        .where(and(
          eq(shiftAssignmentsTable.shiftId, shiftId),
          eq(shiftAssignmentsTable.employeeId, req.user!.userId),
          eq(shiftAssignmentsTable.status, "accepted"),
        ));
      if (assignment.length === 0) {
        res.status(403).json({
          error: "Forbidden",
          message: "You are not assigned to this shift. Reserve it first from the Shifts tab.",
        });
        return;
      }

      // Clock-in window guard — see clockInWindowRejection.
      const windowRej = clockInWindowRejection(shift, new Date());
      if (windowRej) {
        res.status(409).json(windowRej);
        return;
      }

      // Level gate at clock-in time: the roster gate ran when the assignment
      // was created, but a license can expire between rostering and shift day.
      const requiredLevel = shift.requiredLicenseLevel ?? 1;
      if (requiredLevel > myEffectiveLevel) {
        res.status(403).json(levelRejection(requiredLevel));
        return;
      }
    }
    assignedShiftSiteId = shift.siteId ?? null;
  } else if (bodySiteId) {
    // Officer explicitly picked their site (web GPS unavailable, or the site has
    // no saved coordinates so geo-resolution can never match it). Because this
    // path carries NO location proof, a non-admin may only clock in to a site
    // they're actually rostered at (an accepted, live-or-upcoming shift) —
    // otherwise it would let anyone fabricate presence at an arbitrary remote
    // site and even auto-attach to its open shifts. Admins are trusted (covering
    // a post / fixing a stuck record). The geo-radius check is still skipped:
    // the accepted-assignment is the authorization instead. Inactive sites are
    // deliberately allowed here (and in the dispatch clock-in): these are
    // trusted-admin recovery paths, and existing operations at a just-retired
    // site must remain fixable — only NEW shifts/coverage are blocked.
    const [site] = await db.select().from(sitesTable).where(eq(sitesTable.id, bodySiteId));
    if (!site) {
      res.status(404).json({ error: "Not Found", message: "Site not found" });
      return;
    }
    if (req.user!.role !== "admin") {
      const rostered = await officerRosteredShiftsForPicker(req.user!.userId, new Date());
      const ownShift = closestByStart(rostered.filter((r) => r.siteId === site.id), new Date());
      if (!ownShift) {
        res.status(403).json({
          error: "Forbidden",
          code: "not_rostered_here",
          message: "You don't have a shift at this site. Tap your reserved shift in the Shifts tab, or move closer so GPS can place you.",
        });
        return;
      }
      // Same clock-in window applies on the GPS-less site-pick path — the
      // picker eligibility query has no early bound (an officer rostered at a
      // site sees it regardless of date), so without this an officer could
      // clock into a shift days out by picking its site.
      const windowRej = clockInWindowRejection(ownShift, new Date());
      if (windowRej) {
        res.status(409).json(windowRej);
        return;
      }
      // Same lapsed-license guard as the explicit-shift path.
      const requiredLevel = ownShift.requiredLicenseLevel ?? 1;
      if (requiredLevel > myEffectiveLevel) {
        res.status(403).json(levelRejection(requiredLevel));
        return;
      }
      pickedOwnShiftId = ownShift.shiftId;
    }
    assignedShiftSiteId = site.id;
    pickedSite = { id: site.id, name: site.name };
  } else {
    resolvedSite = await resolveNearestSite(Number(lat), Number(lng));
    if (!resolvedSite) {
      res.status(422).json({
        error: "No Site Nearby",
        message: `You are not within ${GEO_RESOLVE_RADIUS_MILES} mile of any known site. Move closer to a site or tap a reserved shift in the Shifts tab to clock in to it directly.`,
      });
      return;
    }
  }

  // Resolve (and, when needed, auto-assign) the scheduled shift for an
  // ad-hoc geo clock-in. Prefers the officer's own accepted assignment at
  // the resolved site; otherwise self-assigns them to an open shift there so
  // they show up on the Dispatch status board's "On duty" tab. Falls back to
  // a billing-only attach when nothing is claimable. See the helper above.
  let autoAttachedShiftId: string | null = null;
  if (!shiftId) {
    if (resolvedSite) {
      // GPS-verified ad-hoc clock-in: the officer is physically within range of
      // the resolved site, so it's safe to auto-assign them to an open shift
      // there (so they surface as "on duty" on the Dispatch board).
      autoAttachedShiftId = await resolveOrAssignShiftForAdHocClockIn(
        req.user!.userId,
        resolvedSite.id,
        new Date(),
        req.log,
      );
    } else if (pickedSite) {
      // Manually-picked site carries NO location proof, so we NEVER auto-assign
      // it to an arbitrary open shift. Non-admins attach only to their own
      // rostered shift validated above; admins get a billing-only match so the
      // per-shift billRate is still recovered for invoicing.
      if (pickedOwnShiftId) {
        autoAttachedShiftId = pickedOwnShiftId;
      } else if (req.user!.role === "admin") {
        autoAttachedShiftId = await findMatchingScheduledShift(req.user!.userId, pickedSite.id, new Date());
      }
    }
  }

  const [entry] = await db.insert(timeEntriesTable).values({
    shiftId: shiftId || autoAttachedShiftId || null,
    siteId: resolvedSite ? resolvedSite.id : assignedShiftSiteId,
    employeeId: req.user!.userId,
    clockInTime: new Date(),
    clockInLat: hasCoords ? String(lat) : null,
    clockInLng: hasCoords ? String(lng) : null,
    notes: notes || null,
    isVerified: false,
    approvalStatus: "pending",
  }).returning();

  // Real-time push: tell live-map viewers a new time entry just opened so the
  // officer marker appears immediately instead of waiting for the next 30s
  // poll. Clients invalidate/refetch the active-officers query on receipt.
  broadcastOfficerJoined(req.user!.userId);

  // Seed users.lastLat/Lng from the clock-in coords so the officer pops up
  // on the Dispatch Live Map immediately — without this, they only appear
  // after the first 60s /me/location ping (and never at all if GPS was
  // denied or we're running in a web preview that can't background-ping).
  try {
    const latNum = Number(lat);
    const lngNum = Number(lng);
    if (hasCoords && Number.isFinite(latNum) && Number.isFinite(lngNum)) {
      await db
        .update(usersTable)
        .set({
          lastLat: String(latNum),
          lastLng: String(lngNum),
          lastLocationAt: new Date(),
        })
        .where(eq(usersTable.id, req.user!.userId));
    }
  } catch (err) {
    req.log.warn({ err }, "Failed to seed users.lastLat from clock-in coords");
  }

  // When clocking into a specific shift — or auto-attached one — flip its
  // status to "active" so the mobile app's My Shifts → Active tab (and
  // admin dashboards) reflect the on-duty state. Without this, the
  // matching clock-out completion flip (which requires status='active')
  // never fires for auto-attached shifts and they'd hang in "upcoming"
  // indefinitely. Don't downgrade if already past upcoming.
  const effectiveShiftId = shiftId || autoAttachedShiftId;
  if (effectiveShiftId) {
    await db
      .update(shiftsTable)
      .set({ status: "active" })
      .where(and(eq(shiftsTable.id, effectiveShiftId), eq(shiftsTable.status, "upcoming")));
  }

  const [shift] = effectiveShiftId
    ? await db.select().from(shiftsTable).where(eq(shiftsTable.id, effectiveShiftId))
    : [undefined];
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, req.user!.userId));

  // Outbound sync: push clock-in event to scheduler (best-effort)
  if (user) {
    void pushClockEvent({
      ...entry,
      employeeEmail: user.email,
      employeeName: `${user.firstName} ${user.lastName}`,
      shiftExternalId: (shift as any)?.externalId ?? null,
      siteName: resolvedSite?.name ?? pickedSite?.name ?? null,
    });
  }

  res.status(201).json({
    ...entry,
    shiftTitle: shift?.title ?? null,
    siteId: entry.siteId ?? shift?.siteId ?? null,
    siteName: resolvedSite?.name ?? pickedSite?.name ?? null,
    geoResolved: resolvedSite ? { siteName: resolvedSite.name, distanceMiles: Math.round(resolvedSite.distanceMiles * 100) / 100 } : null,
    employeeName: user ? `${user.firstName} ${user.lastName}` : null,
  });
});

router.post("/time-entries/clock-out", requireStaff, async (req, res): Promise<void> => {
  const { timeEntryId, lat, lng, notes, correctionNote } = req.body;
  if (!timeEntryId || lat == null || lng == null) {
    res.status(400).json({ error: "Bad Request", message: "timeEntryId, lat, lng required" });
    return;
  }

  const [entry] = await db.select().from(timeEntriesTable).where(eq(timeEntriesTable.id, timeEntryId));
  if (!entry) { res.status(404).json({ error: "Not Found" }); return; }
  if (entry.employeeId !== req.user!.userId && req.user!.role !== "admin") {
    res.status(403).json({ error: "Forbidden" }); return;
  }

  const clockOut = new Date();
  const hours = calcHours(entry.clockInTime, clockOut);

  // Time-correction request: when the officer leaves a non-empty correction
  // note on clock-out, flag the entry so admins know to adjust the recorded
  // times before approving it for payroll. Empty/whitespace-only notes leave
  // the existing flag untouched (so re-clocking-out without a note doesn't
  // silently clear a previously raised request).
  // Cap the free-text note to a sane length so an oversized body can't bloat
  // the row / admin UI. 1 KB is plenty for "I forgot to clock in at 8am".
  const trimmedCorrection = typeof correctionNote === "string" ? correctionNote.trim().slice(0, 1000) : "";
  const hasCorrection = trimmedCorrection.length > 0;

  // Officer confirmation workflow: when the OWNER clocks themselves out, the
  // entry enters 'awaiting_confirmation' — the officer must review/confirm
  // (or edit) the recorded times before it joins the pending-approval queue.
  // We snapshot the GPS/clock-recorded times here, BEFORE any officer edit,
  // so approvers always see original → submitted. Admin clock-outs on behalf
  // of someone else skip confirmation (behave as today).
  const ownerInitiated = entry.employeeId === req.user!.userId;

  // Reset syncSource to 'local' so clock-outs of scheduler-origin entries
  // are pushed back rather than suppressed by the loop-prevention guard.
  const [updated] = await db.update(timeEntriesTable).set({
    clockOutTime: clockOut,
    clockOutLat: String(lat),
    clockOutLng: String(lng),
    hoursWorked: String(hours),
    notes: notes || entry.notes,
    ...(hasCorrection ? { correctionRequested: true, correctionNote: trimmedCorrection } : {}),
    ...(ownerInitiated ? {
      confirmationStatus: "awaiting_confirmation",
      originalClockInTime: entry.clockInTime,
      originalClockOutTime: clockOut,
      employeeEdited: false,
      employeeEditReason: null,
      confirmedAt: null,
    } : {}),
    syncSource: "local",
  }).where(eq(timeEntriesTable.id, timeEntryId)).returning();

  // Tell any open live-map screens this officer just clocked out so the
  // marker is removed immediately instead of lingering until the next poll.
  broadcastOfficerLeft(updated.employeeId);

  // If this entry was tied to a shift, mark the shift completed — but ONLY
  // when no other officer still has an open time entry on it. The NOT EXISTS
  // predicate runs inside the same UPDATE so we close the TOCTOU window
  // between "check open entries" and "set completed": if another officer
  // races a clock-in for the same shift between this clock-out's row update
  // and the shift update, the WHERE will see their open entry and skip the
  // status flip — leaving the shift correctly in "active".
  if (updated.shiftId) {
    await db
      .update(shiftsTable)
      .set({ status: "completed" })
      .where(and(
        eq(shiftsTable.id, updated.shiftId),
        eq(shiftsTable.status, "active"),
        sql`NOT EXISTS (
          SELECT 1 FROM ${timeEntriesTable}
          WHERE ${timeEntriesTable.shiftId} = ${updated.shiftId}
            AND ${timeEntriesTable.clockOutTime} IS NULL
        )`,
      ));
  }

  const [shift] = updated.shiftId
    ? await db.select().from(shiftsTable).where(eq(shiftsTable.id, updated.shiftId))
    : [undefined];
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, updated.employeeId));

  // Outbound sync: push clock-out event to scheduler (best-effort)
  if (user) {
    void pushClockEvent({
      ...updated,
      employeeEmail: user.email,
      employeeName: `${user.firstName} ${user.lastName}`,
      shiftExternalId: (shift as any)?.externalId ?? null,
      siteName: null,
    });
  }

  res.json({
    ...updated,
    shiftTitle: shift?.title,
    employeeName: user ? `${user.firstName} ${user.lastName}` : null,
  });
});

router.get("/time-entries/active", requireStaff, async (req, res): Promise<void> => {
  const [entry] = await db
    .select(baseSelect)
    .from(timeEntriesTable)
    .leftJoin(shiftsTable, eq(timeEntriesTable.shiftId, shiftsTable.id))
    .leftJoin(sitesTable, sql`${sitesTable.id} = coalesce(${timeEntriesTable.siteId}, ${shiftsTable.siteId})`)
    .leftJoin(usersTable, eq(timeEntriesTable.employeeId, usersTable.id))
    .where(and(eq(timeEntriesTable.employeeId, req.user!.userId), isNull(timeEntriesTable.clockOutTime)));

  // Return 200 with null rather than 404 when there's no active entry — this
  // lets react-query (and our mobile clock screen) cleanly clear stale data
  // after a clock-out instead of treating "no entry" as an error and keeping
  // the previous cached value.
  if (!entry) { res.json(null); return; }
  res.json(stripTimeEntryBillRateForRole(req.user!.role, entry));
});

// Weekly time card — a human-readable per-week view of one employee's hours.
//
// Week boundaries follow the business timezone (PAYROLL_TIMEZONE, Monday-start
// weeks via startOfBusinessWeek) and entries are bucketed into the business
// day containing their clock-in — the same convention payroll uses to qualify
// entries, so the time card never disagrees with payroll totals. Hours math
// mirrors /payroll/generate exactly: per-entry stored hoursWorked are summed
// raw, then the total is rounded to 2dp at the end.
//
// Authz: admins and dispatchers may pass ?employeeId to view any employee's
// card; everyone else (employees, site managers) is forced to their own card.
// requireStaff already excludes client-portal users. No finance fields are
// returned — this surface is hours-only by design.
router.get("/time-entries/time-card", requireStaff, async (req, res): Promise<void> => {
  const role = req.user!.role;
  const { employeeId: qEmployeeId, weekStart: qWeekStart } = req.query as Record<string, string | undefined>;

  let targetEmployeeId = req.user!.userId;
  if (qEmployeeId && qEmployeeId !== req.user!.userId) {
    if (role !== "admin" && role !== "dispatcher") {
      res.status(403).json({ error: "Forbidden", message: "You can only view your own time card." });
      return;
    }
    targetEmployeeId = qEmployeeId;
  }

  const tz = businessTimeZone();
  // Anchor instant: noon UTC on the requested date lands safely inside that
  // business day for any US timezone; default is "now".
  let anchor = new Date();
  if (qWeekStart) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(qWeekStart)) {
      res.status(400).json({ error: "Bad Request", message: "weekStart must be YYYY-MM-DD" });
      return;
    }
    anchor = new Date(businessDateToUtc(qWeekStart, tz).getTime() + 12 * 3600_000);
  }
  const weekStartUtc = startOfBusinessWeek(anchor, tz);
  // Next Monday: jump 8.5 days in (well past any DST-shortened week), snap back.
  const nextWeekStartUtc = startOfBusinessWeek(new Date(weekStartUtc.getTime() + 8.5 * 24 * 3600_000), tz);
  const prevWeekStartUtc = startOfBusinessWeek(new Date(weekStartUtc.getTime() - 3.5 * 24 * 3600_000), tz);

  // The 7 business dates of the week (walk day-by-day, DST-safe).
  const dayDates: string[] = [];
  let cursor = weekStartUtc;
  for (let i = 0; i < 7; i++) {
    dayDates.push(businessDateIso(cursor, tz));
    cursor = businessDayWindow(cursor, tz).endOfDay;
  }

  const [targetUser] = await db
    .select({ firstName: usersTable.firstName, lastName: usersTable.lastName })
    .from(usersTable)
    .where(eq(usersTable.id, targetEmployeeId));
  if (!targetUser) {
    res.status(404).json({ error: "Not Found", message: "Employee not found" });
    return;
  }

  const rows = await db
    .select({
      id: timeEntriesTable.id,
      clockInTime: timeEntriesTable.clockInTime,
      clockOutTime: timeEntriesTable.clockOutTime,
      hoursWorked: timeEntriesTable.hoursWorked,
      approvalStatus: timeEntriesTable.approvalStatus,
      shiftTitle: shiftsTable.title,
      siteName: sitesTable.name,
    })
    .from(timeEntriesTable)
    .leftJoin(shiftsTable, eq(timeEntriesTable.shiftId, shiftsTable.id))
    .leftJoin(sitesTable, sql`${sitesTable.id} = coalesce(${timeEntriesTable.siteId}, ${shiftsTable.siteId})`)
    .where(and(
      eq(timeEntriesTable.employeeId, targetEmployeeId),
      gte(timeEntriesTable.clockInTime, weekStartUtc),
      sql`${timeEntriesTable.clockInTime} < ${nextWeekStartUtc}`,
    ))
    .orderBy(timeEntriesTable.clockInTime);

  type CardEntry = {
    id: string;
    clockInTime: Date;
    clockOutTime: Date | null;
    hoursWorked: number | null;
    approvalStatus: string;
    siteName: string | null;
    shiftTitle: string | null;
    open: boolean;
  };
  const byDay = new Map<string, { entries: CardEntry[]; rawTotal: number }>();
  for (const d of dayDates) byDay.set(d, { entries: [], rawTotal: 0 });

  let rawTotal = 0;
  let rawApproved = 0;
  let rawPending = 0;
  for (const r of rows) {
    const dayIso = businessDateIso(r.clockInTime, tz);
    const bucket = byDay.get(dayIso);
    if (!bucket) continue; // clock-in outside the 7 business days (shouldn't happen)
    const open = r.clockOutTime == null;
    const hours = open ? null : parseFloat(String(r.hoursWorked || "0"));
    bucket.entries.push({
      id: r.id,
      clockInTime: r.clockInTime,
      clockOutTime: r.clockOutTime,
      hoursWorked: hours,
      approvalStatus: r.approvalStatus,
      siteName: r.siteName,
      shiftTitle: r.shiftTitle,
      open,
    });
    if (hours != null && r.approvalStatus !== "rejected") {
      bucket.rawTotal += hours;
      rawTotal += hours;
      if (r.approvalStatus === "approved") rawApproved += hours;
      else rawPending += hours;
    }
  }

  const round2 = (n: number) => Math.round(n * 100) / 100;
  res.json({
    employeeId: targetEmployeeId,
    employeeName: `${targetUser.firstName} ${targetUser.lastName}`,
    timezone: tz,
    weekStart: dayDates[0],
    weekEnd: dayDates[6],
    prevWeekStart: businessDateIso(prevWeekStartUtc, tz),
    nextWeekStart: businessDateIso(nextWeekStartUtc, tz),
    days: dayDates.map((d) => {
      const bucket = byDay.get(d)!;
      return { date: d, entries: bucket.entries, totalHours: round2(bucket.rawTotal) };
    }),
    totalHours: round2(rawTotal),
    approvedHours: round2(rawApproved),
    pendingHours: round2(rawPending),
  });
});

// Admin patches a missing clock-out on an existing time entry.
//
// Used from the Payroll Board "Missing clock-out" warning so admins can
// fix a stuck entry in one click instead of editing the raw DB row.
// Accepts either an explicit ISO clockOutTime, or `useShiftEnd:true` to
// snap to the linked shift's scheduled end. Recomputes hoursWorked from
// the new clock-out and clockIn (rounded to 0.01h, matching clock-out).
// Rejects entries that already have a clockOutTime to avoid silently
// overwriting verified payroll data.
//
// Normally the filled entry is still pending (POST /approve refuses entries
// with a null clockOutTime), so there are no billed hours to reconcile. But an
// admin CAN force an open entry to approvalStatus='approved' via the generic
// CRUD grid; in that case we re-sync the weekly client invoice here so the
// corrected billed hours track the fill (best-effort, mirrors /times + /approve).
router.patch("/time-entries/:id/clock-out", requireAdmin, async (req, res): Promise<void> => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const { clockOutTime, useShiftEnd, notes } = req.body ?? {};

  const [existing] = await db.select().from(timeEntriesTable).where(eq(timeEntriesTable.id, id));
  if (!existing) { res.status(404).json({ error: "Not Found" }); return; }
  if (existing.clockOutTime) {
    res.status(409).json({
      error: "Conflict",
      message: "This time entry already has a clock-out time. Edit it from the time entries grid instead.",
    });
    return;
  }

  let targetClockOut: Date | null = null;
  if (useShiftEnd) {
    if (!existing.shiftId) {
      res.status(400).json({
        error: "Bad Request",
        message: "This entry isn't linked to a shift, so there is no scheduled end. Provide an explicit clockOutTime instead.",
      });
      return;
    }
    const [shift] = await db.select().from(shiftsTable).where(eq(shiftsTable.id, existing.shiftId));
    if (!shift) {
      res.status(400).json({ error: "Bad Request", message: "Linked shift no longer exists." });
      return;
    }
    targetClockOut = shift.endTime;
  } else if (clockOutTime) {
    const parsed = new Date(clockOutTime);
    if (isNaN(parsed.getTime())) {
      res.status(400).json({ error: "Bad Request", message: "clockOutTime must be a valid ISO timestamp." });
      return;
    }
    targetClockOut = parsed;
  } else {
    res.status(400).json({ error: "Bad Request", message: "Provide clockOutTime or useShiftEnd:true." });
    return;
  }

  if (targetClockOut.getTime() <= existing.clockInTime.getTime()) {
    res.status(400).json({
      error: "Bad Request",
      message: "Clock-out must be after clock-in.",
    });
    return;
  }

  const hours = calcHours(existing.clockInTime, targetClockOut);

  // Reset syncSource so admin force-clock-outs of scheduler-origin entries propagate back.
  // Stamp last-edited provenance so reviewers can see this was admin-corrected.
  const [updated] = await db.update(timeEntriesTable).set({
    clockOutTime: targetClockOut,
    hoursWorked: String(hours),
    notes: notes ?? existing.notes,
    syncSource: "local",
    lastEditedByUserId: req.user!.userId,
    lastEditedByEmail: req.user!.email,
    lastEditedAt: new Date(),
  }).where(eq(timeEntriesTable.id, id)).returning();

  // The entry was open (guarded above) and is now closed — remove the
  // officer's marker from any open live-map screens immediately.
  broadcastOfficerLeft(updated.employeeId);

  // Record a before/after change-history entry, keyed by entry id, so the
  // Payroll Board can surface the full correction provenance. The global
  // auditLogMiddleware persists res.locals.auditMetadata into audit_logs.
  res.locals["auditMetadata"] = buildTimeEntryAuditMetadata(
    id,
    timeEntrySnapshot(existing),
    timeEntrySnapshot(updated),
  );

  // If the entry was force-approved while still open (via the generic CRUD
  // grid), re-sync the weekly client invoice so the newly billed hours flow
  // through (best-effort, matches the /times + /approve routes).
  if (updated.approvalStatus === "approved") {
    void upsertWeeklyInvoiceForTimeEntry(updated);
  }

  // Mirror the clock-out endpoint's shift-completion flip so an open shift
  // doesn't stay "active" after the admin patches the only outstanding entry.
  if (updated.shiftId) {
    await db
      .update(shiftsTable)
      .set({ status: "completed" })
      .where(and(
        eq(shiftsTable.id, updated.shiftId),
        eq(shiftsTable.status, "active"),
        sql`NOT EXISTS (
          SELECT 1 FROM ${timeEntriesTable}
          WHERE ${timeEntriesTable.shiftId} = ${updated.shiftId}
            AND ${timeEntriesTable.clockOutTime} IS NULL
        )`,
      ));
  }

  const [shift] = updated.shiftId
    ? await db.select().from(shiftsTable).where(eq(shiftsTable.id, updated.shiftId))
    : [undefined];
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, updated.employeeId));

  res.json({
    ...updated,
    shiftTitle: shift?.title,
    employeeName: user ? `${user.firstName} ${user.lastName}` : null,
  });
});

// Admin corrects the clock-in and/or clock-out timestamps on an existing
// time entry. Unlike PATCH /time-entries/:id/clock-out (which only FILLS a
// missing clock-out), this overwrites already-set timestamps for genuine
// corrections — e.g. resolving an officer's "wrong time" correction request
// inline from the Site Detail page. Recomputes hoursWorked, stamps last-edited
// provenance, records before/after audit metadata, and re-syncs the weekly
// client invoice when the entry is already approved so billed hours track the
// correction (best-effort, mirrors the approve route).
router.patch("/time-entries/:id/times", requireAdmin, async (req, res): Promise<void> => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const { clockInTime, clockOutTime, notes } = req.body ?? {};

  if (clockInTime === undefined && clockOutTime === undefined) {
    res.status(400).json({ error: "Bad Request", message: "Provide clockInTime and/or clockOutTime to correct." });
    return;
  }

  const [existing] = await db.select().from(timeEntriesTable).where(eq(timeEntriesTable.id, id));
  if (!existing) { res.status(404).json({ error: "Not Found" }); return; }

  let targetClockIn = existing.clockInTime;
  if (clockInTime !== undefined) {
    const parsed = new Date(clockInTime);
    if (isNaN(parsed.getTime())) {
      res.status(400).json({ error: "Bad Request", message: "clockInTime must be a valid ISO timestamp." });
      return;
    }
    targetClockIn = parsed;
  }

  let targetClockOut = existing.clockOutTime;
  if (clockOutTime !== undefined) {
    if (clockOutTime === null) {
      res.status(400).json({ error: "Bad Request", message: "clockOutTime can't be cleared here." });
      return;
    }
    const parsed = new Date(clockOutTime);
    if (isNaN(parsed.getTime())) {
      res.status(400).json({ error: "Bad Request", message: "clockOutTime must be a valid ISO timestamp." });
      return;
    }
    targetClockOut = parsed;
  }

  if (targetClockOut && targetClockIn.getTime() >= targetClockOut.getTime()) {
    res.status(400).json({ error: "Bad Request", message: "Clock-out must be after clock-in." });
    return;
  }

  // Reset syncSource so corrections of scheduler-origin entries propagate back.
  // Stamp last-edited provenance so reviewers can see this was admin-corrected.
  // Saving a correction also resolves any pending correction request, so the
  // officer's amber "Correction" badge clears once the admin has fixed it.
  const updates: Record<string, unknown> = {
    clockInTime: targetClockIn,
    syncSource: "local",
    correctionRequested: false,
    correctionNote: null,
    lastEditedByUserId: req.user!.userId,
    lastEditedByEmail: req.user!.email,
    lastEditedAt: new Date(),
  };
  if (notes !== undefined) updates.notes = notes;
  if (targetClockOut) {
    updates.clockOutTime = targetClockOut;
    updates.hoursWorked = String(calcHours(targetClockIn, targetClockOut));
  }
  // An admin correction on an unconfirmed entry also clears the awaiting
  // state — the admin has reviewed the times, so officer confirmation is moot.
  if (existing.confirmationStatus === "awaiting_confirmation") {
    updates.confirmationStatus = "confirmed";
  }

  const [updated] = await db.update(timeEntriesTable).set(updates).where(eq(timeEntriesTable.id, id)).returning();

  // If this correction closed a previously OPEN entry, remove the officer's
  // marker from any open live-map screens immediately. (Corrections that only
  // adjust timestamps on an already-closed entry don't change on-duty state.)
  if (!existing.clockOutTime && updated.clockOutTime) {
    broadcastOfficerLeft(updated.employeeId);
  }

  // Record a before/after change-history entry, keyed by entry id, so the
  // Payroll Board can surface the full correction provenance. The global
  // auditLogMiddleware persists res.locals.auditMetadata into audit_logs.
  res.locals["auditMetadata"] = buildTimeEntryAuditMetadata(
    id,
    timeEntrySnapshot(existing),
    timeEntrySnapshot(updated),
  );

  // If the entry is already approved, re-sync the weekly client invoice so the
  // corrected hours flow through (best-effort, matches the approve route).
  if (updated.approvalStatus === "approved") {
    void upsertWeeklyInvoiceForTimeEntry(updated);
  }

  // Mirror the clock-out endpoints' shift-completion flip: if this correction
  // set a clock-out on the last outstanding entry, the linked shift shouldn't
  // stay "active". (No-op when the corrected entry has no clock-out.)
  if (updated.shiftId && updated.clockOutTime) {
    await db
      .update(shiftsTable)
      .set({ status: "completed" })
      .where(and(
        eq(shiftsTable.id, updated.shiftId),
        eq(shiftsTable.status, "active"),
        sql`NOT EXISTS (
          SELECT 1 FROM ${timeEntriesTable}
          WHERE ${timeEntriesTable.shiftId} = ${updated.shiftId}
            AND ${timeEntriesTable.clockOutTime} IS NULL
        )`,
      ));
  }

  const [shift] = updated.shiftId
    ? await db.select().from(shiftsTable).where(eq(shiftsTable.id, updated.shiftId))
    : [undefined];
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, updated.employeeId));

  res.json({
    ...updated,
    shiftTitle: shift?.title,
    employeeName: user ? `${user.firstName} ${user.lastName}` : null,
  });
});

// Officer confirms (optionally edits) their own clocked-out time entry.
//
// Owner-only, and only while the entry is 'awaiting_confirmation' (set by the
// officer-initiated clock-out). Confirming with no body accepts the recorded
// times as-is. Providing clockInTime and/or clockOutTime applies an officer
// edit — a reason note is then required, the entry is flagged employeeEdited,
// and the standard last-edited provenance + before/after audit metadata are
// stamped so the per-entry change history shows the officer's change.
// Hours are always recomputed server-side. Does NOT fire invoice sync — the
// entry is still pending approval; only approval bills the client.
router.post("/time-entries/:id/confirm", requireStaff, async (req, res): Promise<void> => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const { clockInTime, clockOutTime, editReason } = req.body ?? {};

  const [existing] = await db.select().from(timeEntriesTable).where(eq(timeEntriesTable.id, id));
  if (!existing) { res.status(404).json({ error: "Not Found" }); return; }
  if (existing.employeeId !== req.user!.userId) {
    res.status(403).json({ error: "Forbidden", message: "You can only confirm your own time entries." });
    return;
  }
  if (existing.confirmationStatus !== "awaiting_confirmation") {
    res.status(409).json({ error: "Conflict", message: "This time entry is not awaiting confirmation." });
    return;
  }
  if (!existing.clockOutTime) {
    // Defensive: awaiting entries are always clocked out, but never trust state.
    res.status(409).json({ error: "Conflict", message: "This time entry has no clock-out to confirm." });
    return;
  }

  let targetClockIn = existing.clockInTime;
  if (clockInTime !== undefined && clockInTime !== null) {
    const parsed = new Date(clockInTime);
    if (isNaN(parsed.getTime())) {
      res.status(400).json({ error: "Bad Request", message: "clockInTime must be a valid ISO timestamp." });
      return;
    }
    targetClockIn = parsed;
  }
  let targetClockOut = existing.clockOutTime;
  if (clockOutTime !== undefined && clockOutTime !== null) {
    const parsed = new Date(clockOutTime);
    if (isNaN(parsed.getTime())) {
      res.status(400).json({ error: "Bad Request", message: "clockOutTime must be a valid ISO timestamp." });
      return;
    }
    targetClockOut = parsed;
  }

  const timesChanged =
    targetClockIn.getTime() !== existing.clockInTime.getTime() ||
    targetClockOut.getTime() !== existing.clockOutTime.getTime();

  if (targetClockOut.getTime() <= targetClockIn.getTime()) {
    res.status(400).json({ error: "Bad Request", message: "Clock-out must be after clock-in." });
    return;
  }
  // Small skew allowance so "now"-ish submissions from slightly fast clocks pass.
  const futureCutoff = Date.now() + 2 * 60_000;
  if (targetClockIn.getTime() > futureCutoff || targetClockOut.getTime() > futureCutoff) {
    res.status(400).json({ error: "Bad Request", message: "Times can't be in the future." });
    return;
  }

  const trimmedReason = typeof editReason === "string" ? editReason.trim().slice(0, 1000) : "";
  if (timesChanged && trimmedReason.length === 0) {
    res.status(400).json({ error: "Bad Request", message: "Please add a short reason for changing your times." });
    return;
  }

  const updates: Record<string, unknown> = {
    confirmationStatus: "confirmed",
    confirmedAt: new Date(),
  };
  if (timesChanged) {
    updates.clockInTime = targetClockIn;
    updates.clockOutTime = targetClockOut;
    updates.hoursWorked = String(calcHours(targetClockIn, targetClockOut));
    updates.employeeEdited = true;
    updates.employeeEditReason = trimmedReason;
    // Officer-edited times must propagate to the scheduler like any local edit.
    updates.syncSource = "local";
    // Standard edit provenance so the "Edited" indicator + per-entry change
    // history (audit_logs filtered by entryId) cover officer edits too.
    updates.lastEditedByUserId = req.user!.userId;
    updates.lastEditedByEmail = req.user!.email;
    updates.lastEditedAt = new Date();
  }

  const [updated] = await db.update(timeEntriesTable).set(updates).where(eq(timeEntriesTable.id, id)).returning();

  if (timesChanged) {
    res.locals["auditMetadata"] = buildTimeEntryAuditMetadata(
      id,
      timeEntrySnapshot(existing),
      timeEntrySnapshot(updated),
    );
  }

  const [shift] = updated.shiftId
    ? await db.select().from(shiftsTable).where(eq(shiftsTable.id, updated.shiftId))
    : [undefined];
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, updated.employeeId));

  res.json({
    ...updated,
    shiftTitle: shift?.title,
    employeeName: user ? `${user.firstName} ${user.lastName}` : null,
  });
});

// Admin dismisses an officer's time-correction request without touching the
// timestamps — e.g. when the request was a misunderstanding or already resolved.
// Clears correctionRequested/correctionNote so the amber "Correction" badge goes
// away. Distinct from PATCH /times, which clears the flag as a side effect of an
// actual edit.
router.post("/time-entries/:id/dismiss-correction", requireAdmin, async (req, res): Promise<void> => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

  const [existing] = await db.select().from(timeEntriesTable).where(eq(timeEntriesTable.id, id));
  if (!existing) { res.status(404).json({ error: "Not Found" }); return; }

  const [updated] = await db
    .update(timeEntriesTable)
    .set({ correctionRequested: false, correctionNote: null })
    .where(eq(timeEntriesTable.id, id))
    .returning();

  res.locals["auditMetadata"] = buildTimeEntryAuditMetadata(
    id,
    timeEntrySnapshot(existing),
    timeEntrySnapshot(updated),
  );

  const [shift] = updated.shiftId
    ? await db.select().from(shiftsTable).where(eq(shiftsTable.id, updated.shiftId))
    : [undefined];
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, updated.employeeId));

  res.json({
    ...updated,
    shiftTitle: shift?.title,
    employeeName: user ? `${user.firstName} ${user.lastName}` : null,
  });
});

// Admin or site manager approves/rejects a time entry. Approval is required before payroll/invoice picks it up.
router.post("/time-entries/:id/approve", requireAdminOrSiteManager, async (req, res): Promise<void> => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const { decision, hoursWorked, notes } = req.body;
  if (decision !== "approved" && decision !== "rejected") {
    res.status(400).json({ error: "Bad Request", message: "decision must be 'approved' or 'rejected'" });
    return;
  }
  const [existing] = await db.select().from(timeEntriesTable).where(eq(timeEntriesTable.id, id));
  if (!existing) { res.status(404).json({ error: "Not Found" }); return; }
  if (!existing.clockOutTime) {
    res.status(400).json({ error: "Bad Request", message: "Cannot approve a time entry that hasn't been clocked out" });
    return;
  }

  // Site managers may only approve/reject entries at sites they manage. The
  // entry's site is its own siteId (geo/ad-hoc clock-in) falling back to the
  // linked shift's site; a null site is never manageable by a site manager.
  if (req.user!.role === "site_manager") {
    let entrySiteId = existing.siteId ?? null;
    if (!entrySiteId && existing.shiftId) {
      const [sh] = await db.select({ siteId: shiftsTable.siteId }).from(shiftsTable).where(eq(shiftsTable.id, existing.shiftId));
      entrySiteId = sh?.siteId ?? null;
    }
    if (!(await canManageSite({ userId: req.user!.userId, role: req.user!.role }, entrySiteId))) {
      res.status(403).json({ error: "Forbidden", message: "You can only approve time entries at sites you manage." });
      return;
    }
  }

  const updates: Record<string, unknown> = {
    approvalStatus: decision,
    approvedAt: new Date(),
    approvedBy: req.user!.userId,
    isVerified: decision === "approved",
  };
  if (hoursWorked !== undefined) updates.hoursWorked = String(hoursWorked);
  if (notes !== undefined) updates.notes = notes;
  // Admin action on an unconfirmed entry force-clears the awaiting state —
  // an officer who never confirms cannot block payroll. Original recorded
  // times stay preserved on the row.
  if (existing.confirmationStatus === "awaiting_confirmation") {
    updates.confirmationStatus = "confirmed";
  }

  const [updated] = await db.update(timeEntriesTable).set(updates).where(eq(timeEntriesTable.id, id)).returning();
  const [shift] = updated.shiftId
    ? await db.select().from(shiftsTable).where(eq(shiftsTable.id, updated.shiftId))
    : [undefined];
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, updated.employeeId));

  // Auto-populate the per-site weekly client invoice. Approval is the
  // only state that bills the client, so on "approved" we fold this
  // entry into the (siteId, week-of-clockIn) draft. On "rejected" we
  // also re-sync — if the entry was previously approved and rolled
  // into a draft, the rebuild will drop its line and (if it was the
  // only billable entry) prune the now-empty $0 draft. Best-effort:
  // the response status doesn't depend on the invoice write.
  if (decision === "approved" || decision === "rejected") {
    void upsertWeeklyInvoiceForTimeEntry(updated);
  }

  res.json({
    ...updated,
    shiftTitle: shift?.title,
    employeeName: user ? `${user.firstName} ${user.lastName}` : null,
  });
});

// One-shot admin backfill: walk every time entry with no shiftId, try to
// auto-attach a matching scheduled shift (same employee, same site, window
// overlaps clockInTime ± 60 min, accepted assignment), then re-run the
// invoice upsert for every entry we touched so historical approved hours
// roll into priced draft invoices. Safe to re-run: rows that don't match
// stay ad-hoc, rows that already have a shiftId are skipped. Returns a
// summary; failures inside the per-row loop are logged but do not abort
// the batch.
router.post("/admin/time-entries/backfill-shift-attach", requireAdmin, async (req, res): Promise<void> => {
  const candidates = await db
    .select()
    .from(timeEntriesTable)
    .where(isNull(timeEntriesTable.shiftId));

  let attached = 0;
  let unmatched = 0;
  const errors: Array<{ id: string; error: string }> = [];
  const invoiceSyncQueue: Array<typeof timeEntriesTable.$inferSelect> = [];

  for (const entry of candidates) {
    if (!entry.siteId) { unmatched++; continue; }
    try {
      const matched = await findMatchingScheduledShift(
        entry.employeeId,
        entry.siteId,
        entry.clockInTime,
      );
      if (!matched) { unmatched++; continue; }
      // Race-safe: only update if shiftId is still NULL — protects against
      // a concurrent clock-in / second backfill that already attached.
      const updatedRows = await db
        .update(timeEntriesTable)
        .set({ shiftId: matched })
        .where(and(eq(timeEntriesTable.id, entry.id), isNull(timeEntriesTable.shiftId)))
        .returning();
      if (updatedRows.length === 0) continue;
      attached++;
      if (updatedRows[0].approvalStatus === "approved") {
        invoiceSyncQueue.push(updatedRows[0]);
      }
    } catch (err) {
      errors.push({ id: entry.id, error: err instanceof Error ? err.message : String(err) });
    }
  }

  // Run invoice upserts with bounded concurrency (4 at a time) so a
  // big backfill doesn't fan out hundreds of parallel DB transactions.
  // We await them so the response reports real success/failure counts,
  // not "queued" — the operator needs to know whether invoices actually
  // built. Per-row failures are collected, never abort the batch.
  let invoiceSynced = 0;
  const CONCURRENCY = 4;
  for (let i = 0; i < invoiceSyncQueue.length; i += CONCURRENCY) {
    const slice = invoiceSyncQueue.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(
      slice.map(e => upsertWeeklyInvoiceForTimeEntry(e)),
    );
    results.forEach((r, j) => {
      if (r.status === "fulfilled") {
        invoiceSynced++;
      } else {
        errors.push({
          id: slice[j].id,
          error: `invoiceSync: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`,
        });
      }
    });
  }

  req.log.info(
    {
      scanned: candidates.length,
      attached,
      unmatched,
      invoiceSyncAttempted: invoiceSyncQueue.length,
      invoiceSynced,
      errorCount: errors.length,
    },
    "[admin] backfill-shift-attach complete",
  );
  res.json({
    scanned: candidates.length,
    attached,
    unmatched,
    invoiceSyncAttempted: invoiceSyncQueue.length,
    invoiceSynced,
    errors,
  });
});

export default router;
