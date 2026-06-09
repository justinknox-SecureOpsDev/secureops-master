import { Router, type IRouter } from "express";
import { eq, isNull, and, sql, desc, gte, asc } from "drizzle-orm";
import { db, usersTable, timeEntriesTable, shiftsTable, sitesTable, incidentsTable, locationPingsTable } from "@workspace/db";
import { requireAuth, requireAdminOrDispatcher } from "../middlewares/auth";
import { emergencyLimiter, locationLimiter } from "../middlewares/rateLimit";
import { sendPushToUsers } from "../lib/push";
import { sendSmsToUsers } from "../lib/sms";
import { sendEmail, renderEmergencyAlertEmail } from "../lib/email";
import { evaluateGeofence, getGeofenceRadiusMiles } from "../lib/geofence";

const router: IRouter = Router();

// POST /me/location — update authenticated user's last known location.
// Called periodically by the mobile app while the officer is clocked in.
function validCoord(lat: unknown, lng: unknown): { lat: number; lng: number } | null {
  if (typeof lat !== "number" || typeof lng !== "number") return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return { lat, lng };
}

router.post("/me/location", requireAuth, locationLimiter, async (req, res): Promise<void> => {
  const { lat, lng } = (req.body ?? {}) as { lat?: number; lng?: number };
  const coord = validCoord(lat, lng);
  if (!coord) {
    res.status(400).json({ error: "Bad Request", message: "Valid lat (-90..90) and lng (-180..180) required" });
    return;
  }
  const userId = req.user!.userId;
  await db.update(usersTable).set({
    lastLat: String(coord.lat),
    lastLng: String(coord.lng),
    lastLocationAt: new Date(),
  }).where(eq(usersTable.id, userId));

  // Persist a breadcrumb row so admins can reconstruct an officer's
  // movement during a shift or incident review. Look up an active time
  // entry (if any) so the ping is linked to the shift it belongs to;
  // off-shift pings are still stored (with a null timeEntryId) so the
  // "last 24h" trail toggle has data to render.
  const [active] = await db
    .select({ id: timeEntriesTable.id })
    .from(timeEntriesTable)
    .where(and(eq(timeEntriesTable.employeeId, userId), isNull(timeEntriesTable.clockOutTime)))
    .limit(1);
  await db.insert(locationPingsTable).values({
    userId,
    timeEntryId: active?.id ?? null,
    lat: String(coord.lat),
    lng: String(coord.lng),
  }).catch((err: unknown) => {
    req.log.warn({ err }, "location ping insert failed");
  });

  // Fire-and-forget geofence evaluation. We do not block the location
  // response on push/SMS dispatch — the mobile app pings every minute and
  // shouldn't pay the latency tax for a downstream alert pipeline.
  evaluateGeofence(req.user!.userId, coord.lat, coord.lng).catch((err: unknown) => {
    req.log.warn({ err }, "geofence evaluation failed");
  });
  res.json({ ok: true });
});

// GET /admin/active-officers — list currently clocked-in officers with last known location.
router.get("/admin/active-officers", requireAdminOrDispatcher, async (req, res): Promise<void> => {
  const rows = await db
    .select({
      userId: usersTable.id,
      firstName: usersTable.firstName,
      lastName: usersTable.lastName,
      lastLat: usersTable.lastLat,
      lastLng: usersTable.lastLng,
      lastLocationAt: usersTable.lastLocationAt,
      timeEntryId: timeEntriesTable.id,
      clockInTime: timeEntriesTable.clockInTime,
      clockInLat: timeEntriesTable.clockInLat,
      clockInLng: timeEntriesTable.clockInLng,
      shiftId: shiftsTable.id,
      shiftTitle: shiftsTable.title,
      siteName: sitesTable.name,
      siteAddress: sitesTable.address,
    })
    .from(timeEntriesTable)
    .innerJoin(usersTable, eq(timeEntriesTable.employeeId, usersTable.id))
    .leftJoin(shiftsTable, eq(timeEntriesTable.shiftId, shiftsTable.id))
    .leftJoin(sitesTable, eq(shiftsTable.siteId, sitesTable.id))
    .where(isNull(timeEntriesTable.clockOutTime))
    .orderBy(desc(timeEntriesTable.clockInTime));

  res.json(rows);
});

// GET /admin/officers/:id/live — last known location for a single officer,
// plus the active site (with effective geofence radius) when they're clocked
// in. Powers the live-location card on the OfficerProfile page so dispatchers
// don't have to bounce back to the Dispatch map during an active call.
router.get("/admin/officers/:id/live", requireAdminOrDispatcher, async (req, res): Promise<void> => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  if (!id) { res.status(400).json({ error: "Bad Request", message: "id required" }); return; }

  const [user] = await db
    .select({
      userId: usersTable.id,
      firstName: usersTable.firstName,
      lastName: usersTable.lastName,
      lastLat: usersTable.lastLat,
      lastLng: usersTable.lastLng,
      lastLocationAt: usersTable.lastLocationAt,
    })
    .from(usersTable)
    .where(eq(usersTable.id, id))
    .limit(1);
  if (!user) { res.status(404).json({ error: "Not Found", message: "Officer not found" }); return; }

  const [active] = await db
    .select({
      timeEntryId: timeEntriesTable.id,
      clockInTime: timeEntriesTable.clockInTime,
      teSiteId: timeEntriesTable.siteId,
      shiftId: timeEntriesTable.shiftId,
      shiftTitle: shiftsTable.title,
      shiftSiteId: shiftsTable.siteId,
    })
    .from(timeEntriesTable)
    .leftJoin(shiftsTable, eq(shiftsTable.id, timeEntriesTable.shiftId))
    .where(and(eq(timeEntriesTable.employeeId, id), isNull(timeEntriesTable.clockOutTime)))
    .orderBy(desc(timeEntriesTable.clockInTime))
    .limit(1);

  let site: {
    id: string; name: string; address: string | null;
    lat: number; lng: number; geofenceRadiusMiles: number;
  } | null = null;
  if (active) {
    const siteId = active.teSiteId ?? active.shiftSiteId;
    if (siteId) {
      const [s] = await db
        .select({
          id: sitesTable.id,
          name: sitesTable.name,
          address: sitesTable.address,
          lat: sitesTable.locationLat,
          lng: sitesTable.locationLng,
          radiusOverride: sitesTable.geofenceRadiusMiles,
        })
        .from(sitesTable)
        .where(eq(sitesTable.id, siteId))
        .limit(1);
      if (s && s.lat != null && s.lng != null) {
        const lat = parseFloat(s.lat);
        const lng = parseFloat(s.lng);
        const overrideMiles = s.radiusOverride != null ? parseFloat(s.radiusOverride) : NaN;
        const radius = Number.isFinite(overrideMiles) && overrideMiles > 0
          ? overrideMiles
          : getGeofenceRadiusMiles();
        if (Number.isFinite(lat) && Number.isFinite(lng)) {
          site = { id: s.id, name: s.name, address: s.address, lat, lng, geofenceRadiusMiles: radius };
        }
      }
    }
  }

  // Breadcrumb trail. Default window = today (since local midnight UTC) so
  // the live profile shows the path walked on the current shift. Pass
  // `?window=24h` to widen to a rolling 24-hour view (used by the "last
  // 24h" toggle on the OfficerProfile page so dispatch can review where
  // an officer was even after they clocked out).
  const windowParam = Array.isArray(req.query.window) ? req.query.window[0] : req.query.window;
  const since = windowParam === "24h"
    ? new Date(Date.now() - 24 * 60 * 60 * 1000)
    : (() => { const d = new Date(); d.setUTCHours(0, 0, 0, 0); return d; })();
  // Hard cap so a misbehaving client (or an officer with very chatty
  // location pings) can't drag a huge polyline into the admin browser.
  const TRAIL_CAP = 1000;
  const trailRows = await db
    .select({
      lat: locationPingsTable.lat,
      lng: locationPingsTable.lng,
      capturedAt: locationPingsTable.capturedAt,
      timeEntryId: locationPingsTable.timeEntryId,
    })
    .from(locationPingsTable)
    .where(and(eq(locationPingsTable.userId, id), gte(locationPingsTable.capturedAt, since)))
    .orderBy(asc(locationPingsTable.capturedAt))
    .limit(TRAIL_CAP);
  const trail = trailRows
    .map((r) => {
      const lat = parseFloat(r.lat);
      const lng = parseFloat(r.lng);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
      return { lat, lng, capturedAt: r.capturedAt, timeEntryId: r.timeEntryId };
    })
    .filter((p): p is { lat: number; lng: number; capturedAt: Date; timeEntryId: string | null } => p !== null);

  res.json({
    userId: user.userId,
    lastLat: user.lastLat,
    lastLng: user.lastLng,
    lastLocationAt: user.lastLocationAt,
    clockedIn: !!active,
    clockInTime: active?.clockInTime ?? null,
    shiftId: active?.shiftId ?? null,
    shiftTitle: active?.shiftTitle ?? null,
    site,
    trail,
    trailWindow: windowParam === "24h" ? "24h" : "today",
  });
});

// POST /emergency — officer triggers panic alert. Creates a critical incident
// and pushes to every admin. Returns the incident + the recommended phone number.
router.post("/emergency", requireAuth, emergencyLimiter, async (req, res): Promise<void> => {
  const me = req.user!.userId;
  const { lat, lng, message } = (req.body ?? {}) as { lat?: number; lng?: number; message?: string };

  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, me)).limit(1);
  if (!user) { res.status(404).json({ error: "Not Found", message: "User not found" }); return; }

  // Find active time entry (if any) so we can attach the shift to the incident.
  const [active] = await db
    .select()
    .from(timeEntriesTable)
    .where(and(eq(timeEntriesTable.employeeId, me), isNull(timeEntriesTable.clockOutTime)))
    .limit(1);

  const fresh = validCoord(lat, lng);
  const fallbackLat = active?.clockInLat ? parseFloat(active.clockInLat) : null;
  const fallbackLng = active?.clockInLng ? parseFloat(active.clockInLng) : null;
  const useLat = fresh ? fresh.lat : (Number.isFinite(fallbackLat as number) ? (fallbackLat as number) : null);
  const useLng = fresh ? fresh.lng : (Number.isFinite(fallbackLng as number) ? (fallbackLng as number) : null);

  if (fresh) {
    await db.update(usersTable).set({
      lastLat: String(fresh.lat),
      lastLng: String(fresh.lng),
      lastLocationAt: new Date(),
    }).where(eq(usersTable.id, me));
  }

  const haveCoords = useLat !== null && useLng !== null;
  const [incident] = await db.insert(incidentsTable).values({
    shiftId: active?.shiftId ?? null,
    employeeId: me,
    title: `EMERGENCY — ${user.firstName} ${user.lastName}`,
    description: message?.trim() || "Officer triggered the emergency panic button. Verify safety immediately.",
    severity: "critical",
    status: "open",
    locationDescription: haveCoords ? `${useLat!.toFixed(6)}, ${useLng!.toFixed(6)}` : null,
    lat: haveCoords ? String(useLat) : null,
    lng: haveCoords ? String(useLng) : null,
    occurredAt: new Date(),
  }).returning();

  const admins = await db.select({ id: usersTable.id, email: usersTable.email }).from(usersTable).where(eq(usersTable.role, "admin"));
  const adminIds = admins.map((a) => a.id);
  const adminEmails = admins.map((a) => a.email).filter((e): e is string => !!e);

  // Fire-and-forget push to all admins. We log dispatch failures so
  // systemic regressions (e.g. Expo creds rotated) are visible without
  // crashing the request path.
  sendPushToUsers(adminIds, {
    title: "🚨 EMERGENCY ALERT",
    body: `${user.firstName} ${user.lastName} triggered a panic alert. Tap to view location.`,
    data: { type: "emergency", incidentId: incident.id, lat: useLat, lng: useLng },
  }).catch((err: unknown) => req.log.warn({ err, incidentId: incident.id }, "emergency push dispatch failed"));

  // Belt-and-braces SMS to admins for emergencies — push can be silenced
  // or delayed by the OS; SMS bypasses Do Not Disturb on most devices.
  // No-ops when Twilio isn't connected.
  const locTxt = haveCoords ? ` (loc ${useLat!.toFixed(5)},${useLng!.toFixed(5)})` : "";
  sendSmsToUsers(
    adminIds,
    `[WCSG EMERGENCY] ${user.firstName} ${user.lastName} pressed the panic button${locTxt}. Open the app immediately.`,
  ).catch((err: unknown) => req.log.warn({ err, incidentId: incident.id }, "emergency SMS dispatch failed"));

  // Email to all admins — third channel alongside in-app push + SMS so the
  // alert lands even for admins who only watch their inbox. No-op when SMTP
  // isn't configured.
  if (adminEmails.length) {
    const base = process.env.APP_BASE_URL
      || (process.env.REPLIT_DOMAINS ? `https://${process.env.REPLIT_DOMAINS.split(",")[0]}` : "");
    const tmpl = renderEmergencyAlertEmail({
      officerName: `${user.firstName} ${user.lastName}`,
      occurredAtIso: incident.occurredAt.toISOString(),
      locationText: haveCoords ? `${useLat!.toFixed(6)}, ${useLng!.toFixed(6)}` : undefined,
      message: message?.trim() || undefined,
      reviewUrl: base ? `${base}/admin-portal/incidents/${incident.id}` : undefined,
    });
    Promise.all(
      adminEmails.map((to) =>
        sendEmail({ to, subject: tmpl.subject, text: tmpl.text, html: tmpl.html })
          .catch((err: unknown) => {
            req.log.warn({ err, to, incidentId: incident.id }, "emergency per-admin email failed");
            return false;
          }),
      ),
    ).catch((err: unknown) => req.log.warn({ err, incidentId: incident.id }, "emergency email dispatch failed"));
  }

  // Notify any connected websocket clients in admin push channels via the chat broadcast pipe is overkill;
  // keep it to the push notification + incident record. Map view + incidents list will refresh on next poll.

  // WCSG operates in Texas (US) — default to 911. Override via EMERGENCY_CALL_NUMBER for other regions.
  const phone = process.env["EMERGENCY_CALL_NUMBER"] || "911";

  res.status(201).json({ incident, callNumber: phone, adminCount: adminIds.length });
});

export default router;
