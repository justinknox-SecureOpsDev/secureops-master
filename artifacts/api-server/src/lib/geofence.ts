import { brand } from "./brandConfig";

/**
 * Real-time geofence: raise an alert when an active officer drifts outside
 * the shift's site radius.
 *
 * `evaluateGeofence` is called from POST /me/location every time the mobile
 * app pings a fresh GPS reading (≈1 / minute while clocked in). It looks up
 * the caller's currently-active time entry, finds the linked site, and
 * decides whether to push admins.
 *
 * State machine on `time_entries`:
 *   null → inside    (first inside ping; no alert)
 *   null → outside   (first outside ping; alert)
 *   inside → outside (drift; alert)
 *   outside → inside (officer returned; no alert, just resets state)
 *   outside → outside (still outside; no duplicate alert)
 *
 * Radius is GEOFENCE_RADIUS_MILES env (default 0.25mi ≈ ~400m). Set to a
 * larger value for sites with sprawling perimeters; smaller for dense urban
 * sites.
 */
import { db, timeEntriesTable, sitesTable, usersTable, shiftsTable } from "@workspace/db";
import { and, eq, isNull } from "drizzle-orm";
import { sendPushToUsers, SMS_GEOFENCE_MAP_PROMPT } from "./push";
import { sendSmsToUsers } from "./sms";
import { logger } from "./logger";

const DEFAULT_RADIUS_MILES = 0.25;
// Suppress repeat outside-transition alerts on the same active time entry
// within this window. Tunable via env if a deployment wants noisier alerts.
const BREACH_COOLDOWN_MS = (() => {
  const raw = process.env["GEOFENCE_BREACH_COOLDOWN_MIN"];
  const n = raw ? parseFloat(raw) : NaN;
  const minutes = Number.isFinite(n) && n > 0 ? n : 5;
  return minutes * 60_000;
})();

async function getLastBreachMs(timeEntryId: string): Promise<number | null> {
  const [row] = await db
    .select({ at: timeEntriesTable.geofenceLastBreachAt })
    .from(timeEntriesTable)
    .where(eq(timeEntriesTable.id, timeEntryId))
    .limit(1);
  return row?.at ? new Date(row.at).getTime() : null;
}

/**
 * Resolve the configured geofence radius (miles). Exported so the
 * dispatcher map and any future site-perimeter UI render the EXACT same
 * boundary the backend uses to fire breach push/SMS — single source of
 * truth, no drift.
 */
export function getGeofenceRadiusMiles(): number {
  const raw = process.env["GEOFENCE_RADIUS_MILES"];
  const n = raw ? parseFloat(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_RADIUS_MILES;
}

function radiusMiles(): number {
  return getGeofenceRadiusMiles();
}

export function haversineMiles(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const toRad = (x: number) => (x * Math.PI) / 180;
  const R = 3958.7613; // mean Earth radius in miles
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/**
 * Check the caller's geofence and, on a fresh outside-transition, push +
 * SMS the admins. Safe to call on every location ping — does at most one
 * DB read for the active entry, one for the site, and one write only when
 * the state changes.
 */
export async function evaluateGeofence(userId: string, lat: number, lng: number): Promise<void> {
  // Find an open time entry for this user (clocked in, not clocked out).
  const [active] = await db
    .select({
      id: timeEntriesTable.id,
      siteId: timeEntriesTable.siteId,
      shiftId: timeEntriesTable.shiftId,
      shiftSiteId: shiftsTable.siteId,
      geofenceState: timeEntriesTable.geofenceState,
    })
    .from(timeEntriesTable)
    .leftJoin(shiftsTable, eq(shiftsTable.id, timeEntriesTable.shiftId))
    .where(and(eq(timeEntriesTable.employeeId, userId), isNull(timeEntriesTable.clockOutTime)))
    .limit(1);

  if (!active) return; // not clocked in
  const siteId = active.siteId ?? active.shiftSiteId;
  if (!siteId) return; // ad-hoc clock-in with no site resolved

  const [site] = await db
    .select({
      id: sitesTable.id,
      name: sitesTable.name,
      lat: sitesTable.locationLat,
      lng: sitesTable.locationLng,
      radiusOverride: sitesTable.geofenceRadiusMiles,
    })
    .from(sitesTable)
    .where(eq(sitesTable.id, siteId))
    .limit(1);

  if (!site || site.lat == null || site.lng == null) return; // site has no geo — can't evaluate

  const distance = haversineMiles(lat, lng, Number(site.lat), Number(site.lng));
  // Per-site override takes precedence; otherwise use the global env default.
  // Reject non-finite / non-positive overrides defensively so a bad row in
  // the DB can't paint the entire planet as "inside".
  const override = site.radiusOverride != null ? Number(site.radiusOverride) : NaN;
  const radius = Number.isFinite(override) && override > 0 ? override : radiusMiles();
  const nextState: "inside" | "outside" = distance <= radius ? "inside" : "outside";
  const prevState = active.geofenceState;

  if (prevState === nextState) return; // no transition

  // Cooldown: even with a state change, don't re-alert admins more often
  // than once per BREACH_COOLDOWN_MS for the same time entry. This stops
  // a malicious or buggy client from flipping inside↔outside coords on
  // every ping and turning the admin alert channel into a noise machine.
  // We still persist the state transition (so the live map / time-entry
  // detail reflects reality), we just suppress the outbound notification.
  const now = Date.now();
  const lastBreach = await getLastBreachMs(active.id);
  const inCooldown =
    nextState === "outside" &&
    lastBreach !== null &&
    now - lastBreach < BREACH_COOLDOWN_MS;

  try {
    await db
      .update(timeEntriesTable)
      .set({
        geofenceState: nextState,
        ...(nextState === "outside" && !inCooldown ? { geofenceLastBreachAt: new Date(now) } : {}),
      })
      .where(eq(timeEntriesTable.id, active.id));
  } catch (err) {
    logger.warn({ err, timeEntryId: active.id }, "[geofence] failed to persist state change");
    return;
  }

  if (nextState !== "outside") return; // returned-to-site doesn't notify
  if (inCooldown) return; // recent breach already alerted; throttle the channel

  // Fire admin alerts. Look up the officer for a friendlier message.
  try {
    const [officer] = await db
      .select({ firstName: usersTable.firstName, lastName: usersTable.lastName })
      .from(usersTable)
      .where(eq(usersTable.id, userId))
      .limit(1);
    const name = officer ? `${officer.firstName} ${officer.lastName}` : "An officer";
    const distanceTxt = distance < 1 ? `${Math.round(distance * 5280)} ft` : `${distance.toFixed(2)} mi`;

    const admins = await db
      .select({ id: usersTable.id })
      .from(usersTable)
      .where(eq(usersTable.role, "admin"));
    const adminIds = admins.map((a) => a.id);

    if (adminIds.length === 0) return;

    sendPushToUsers(adminIds, {
      title: "⚠️ Officer outside geofence",
      body: `${name} is ${distanceTxt} from ${site.name}.`,
      data: { type: "geofence_breach", userId, siteId: site.id, distanceMiles: distance },
    }).catch((err: unknown) => logger.warn({ err, userId, siteId: site.id }, "[geofence] push dispatch failed"));

    sendSmsToUsers(
      adminIds,
      `[${brand.shortName}] ${name} drifted ${distanceTxt} from ${site.name}. ${SMS_GEOFENCE_MAP_PROMPT}`,
    ).catch((err: unknown) => logger.warn({ err, userId, siteId: site.id }, "[geofence] SMS dispatch failed"));
  } catch (err) {
    logger.warn({ err, userId }, "[geofence] failed to dispatch admin alerts");
  }
}
