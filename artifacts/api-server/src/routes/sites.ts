import { Router, type IRouter } from "express";
import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { db, sitesTable, clientsTable, usersTable, siteManagersTable } from "@workspace/db";
import { requireAdmin, requireAdminOrDispatcher, requireSchedulingStaff } from "../middlewares/auth";
import { geocodeOnelineAddress } from "../lib/geocode";
import { preparePreUpdateBody, maybeAutoGeocode } from "../lib/siteGeocode";
import { getGeofenceRadiusMiles } from "../lib/geofence";
import { siteBlockersForOne, refuseIfBlocked } from "../lib/siteDeletion";
import { canManageSite, getManagedSiteIds } from "../lib/siteManagerAuthz";
import { resyncSiteAutoSyncedDrafts } from "../lib/invoiceSync";
import {
  AUTO_CLOCKOUT_DELAY_MAX_MINUTES,
  AUTO_CLOCKOUT_DELAY_MIN_MINUTES,
  DEFAULT_AUTO_CLOCKOUT_DELAY_MINUTES,
} from "../lib/scheduledJobs";

// Resolve the effective geofence radius for a site row: per-site override
// (when set and positive) wins, otherwise the global env default. Mirrors
// the resolution evaluateGeofence() uses on every location ping so the
// dispatch map / site detail UI render the same boundary the backend
// alerts on.
function effectiveGeofenceRadius(override: string | null | undefined): number {
  const n = override != null ? Number(override) : NaN;
  return Number.isFinite(n) && n > 0 ? n : getGeofenceRadiusMiles();
}

const router: IRouter = Router();

// Admin-only address-to-coords helper used by the Site form's "Geocode" button
// and any other admin UI that needs to fill lat/lng from a typed address.
// Routed BEFORE /sites/:id but on a distinct verb so there's no collision.
router.post("/sites/geocode", requireAdmin, async (req, res): Promise<void> => {
  const address = typeof req.body?.address === "string" ? req.body.address : "";
  if (!address.trim()) {
    res.status(400).json({ error: "Bad Request", message: "address is required" });
    return;
  }
  const result = await geocodeOnelineAddress(address);
  if (!result) {
    res.status(422).json({
      error: "No Match",
      message: "Couldn't find that address. Check spelling, or add city/state/ZIP and try again.",
    });
    return;
  }
  res.json({ lat: result.lat, lng: result.lng });
});

// Bulk backfill: walk every site that has an address but no lat/lng and try
// to resolve it via the existing oneline Census geocoder. Re-runnable — only
// touches rows that are still missing coords — and paced with a small delay
// between calls so we don't hammer the public Census endpoint.
router.post("/sites/geocode-missing", requireAdmin, async (req, res): Promise<void> => {
  // Opt-in: when `refreshChanged` is true, also re-resolve sites whose
  // current address text differs from the snapshot saved alongside the
  // last successful geocode (so coordinates are likely stale after an
  // admin edited the address).
  const refreshChanged = req.body?.refreshChanged === true;

  const hasAddress = sql`length(trim(coalesce(${sitesTable.address}, ''))) > 0`;
  const addressDrifted = sql`coalesce(${sitesTable.lastGeocodedAddress}, '') <> coalesce(${sitesTable.address}, '')`;
  const where = refreshChanged
    ? and(hasAddress, or(isNull(sitesTable.locationLat), addressDrifted))
    : and(isNull(sitesTable.locationLat), hasAddress);

  const rows = await db
    .select({
      id: sitesTable.id,
      name: sitesTable.name,
      address: sitesTable.address,
      locationLat: sitesTable.locationLat,
    })
    .from(sitesTable)
    .where(where);

  let resolved = 0;
  let refreshed = 0;
  const unresolved: Array<{ id: string; name: string }> = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const address = (row.address ?? "").trim();
    if (!address) {
      unresolved.push({ id: row.id, name: row.name });
      continue;
    }
    const wasMissing = row.locationLat == null;
    const match = await geocodeOnelineAddress(address);
    if (match) {
      // In missing-only mode we keep the original race-safe guard
      // (skip the row if someone else filled coords in the meantime).
      // In refresh-changed mode we want to overwrite stale coords, so
      // the guard would defeat the whole point — drop it and key on id.
      const guard = refreshChanged
        ? eq(sitesTable.id, row.id)
        : and(eq(sitesTable.id, row.id), isNull(sitesTable.locationLat));
      await db
        .update(sitesTable)
        .set({
          locationLat: String(match.lat),
          locationLng: String(match.lng),
          lastGeocodedAddress: address,
        })
        .where(guard);
      resolved++;
      if (!wasMissing) refreshed++;
    } else {
      unresolved.push({ id: row.id, name: row.name });
    }
    // Rate-pace ~5 req/s so we stay polite with the free Census API.
    if (i < rows.length - 1) await new Promise((r) => setTimeout(r, 200));
  }

  res.json({
    candidates: rows.length,
    resolved,
    refreshed,
    unresolved: unresolved.length,
    unresolvedSites: unresolved.slice(0, 25),
    mode: refreshChanged ? "refresh_changed" : "missing_only",
  });
});

router.get("/sites", requireSchedulingStaff, async (req, res): Promise<void> => {
  const { clientId, includeInactive } = req.query as { clientId?: string; includeInactive?: string };
  // Site managers only ever act on the sites they manage (shift create/edit
  // pickers, approvals) — scope the list server-side so the UI can't offer a
  // site that would just 403 on submit. Admin/dispatcher keep the full list.
  let managedScope: string[] | null = null;
  if (req.user!.role === "site_manager") {
    managedScope = await getManagedSiteIds(req.user!.userId);
    if (managedScope.length === 0) {
      res.json([]);
      return;
    }
  }
  const base = db
    .select({
      id: sitesTable.id,
      clientId: sitesTable.clientId,
      clientName: clientsTable.name,
      name: sitesTable.name,
      status: sitesTable.status,
      address: sitesTable.address,
      locationLat: sitesTable.locationLat,
      locationLng: sitesTable.locationLng,
      notes: sitesTable.notes,
      geofenceRadiusMiles: sitesTable.geofenceRadiusMiles,
      autoClockOutEnabled: sitesTable.autoClockOutEnabled,
      autoClockOutDelayMinutes: sitesTable.autoClockOutDelayMinutes,
      autoClockOutPayGrace: sitesTable.autoClockOutPayGrace,
      autoClockInEnabled: sitesTable.autoClockInEnabled,
      processingFeeEnabled: sitesTable.processingFeeEnabled,
      processingFeeRate: sitesTable.processingFeeRate,
      createdAt: sitesTable.createdAt,
    })
    .from(sitesTable)
    .leftJoin(clientsTable, eq(sitesTable.clientId, clientsTable.id));
  // Inactive (retired) sites are hidden from every operational picker by
  // default — shift dialogs, dispatch map, invoice generation. Management
  // views that need the full list (e.g. to reactivate) pass includeInactive=true.
  const conds = [
    ...(includeInactive === "true" ? [] : [eq(sitesTable.status, "active")]),
    ...(clientId ? [eq(sitesTable.clientId, clientId)] : []),
    ...(managedScope ? [inArray(sitesTable.id, managedScope)] : []),
  ];
  const rows = conds.length > 0 ? await base.where(and(...conds)) : await base;
  // Decorate every row with the resolved effective radius so the dispatch
  // map can draw the right circle per site without re-implementing the
  // override/global fallback rule client-side.
  const decorated = rows.map((r) => ({
    ...r,
    effectiveGeofenceRadiusMiles: effectiveGeofenceRadius(r.geofenceRadiusMiles),
  }));
  res.json(decorated);
});

router.get("/sites/:id", requireAdminOrDispatcher, async (req, res): Promise<void> => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const [site] = await db
    .select({
      id: sitesTable.id,
      clientId: sitesTable.clientId,
      clientName: clientsTable.name,
      name: sitesTable.name,
      status: sitesTable.status,
      address: sitesTable.address,
      locationLat: sitesTable.locationLat,
      locationLng: sitesTable.locationLng,
      notes: sitesTable.notes,
      geofenceRadiusMiles: sitesTable.geofenceRadiusMiles,
      autoClockOutEnabled: sitesTable.autoClockOutEnabled,
      autoClockOutDelayMinutes: sitesTable.autoClockOutDelayMinutes,
      autoClockOutPayGrace: sitesTable.autoClockOutPayGrace,
      autoClockInEnabled: sitesTable.autoClockInEnabled,
      processingFeeEnabled: sitesTable.processingFeeEnabled,
      processingFeeRate: sitesTable.processingFeeRate,
      createdAt: sitesTable.createdAt,
    })
    .from(sitesTable)
    .leftJoin(clientsTable, eq(sitesTable.clientId, clientsTable.id))
    .where(eq(sitesTable.id, id));
  if (!site) { res.status(404).json({ error: "Not Found" }); return; }
  res.json({
    ...site,
    effectiveGeofenceRadiusMiles: effectiveGeofenceRadius(site.geofenceRadiusMiles),
  });
});

router.put("/sites/:id", requireAdmin, async (req, res): Promise<void> => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const { name, status, address, locationLat, locationLng, notes, geofenceRadiusMiles, autoClockOutEnabled, autoClockOutDelayMinutes, autoClockOutPayGrace, autoClockInEnabled, processingFeeEnabled, processingFeeRate } = req.body;
  let updates: Record<string, unknown> = {};
  if (name !== undefined) updates.name = name;
  if (status !== undefined) {
    if (status !== "active" && status !== "inactive") {
      res.status(400).json({ error: "Bad Request", message: "status must be 'active' or 'inactive'" });
      return;
    }
    updates.status = status;
  }
  if (address !== undefined) updates.address = address;
  if (locationLat !== undefined) updates.locationLat = locationLat != null ? String(locationLat) : null;
  if (locationLng !== undefined) updates.locationLng = locationLng != null ? String(locationLng) : null;
  if (notes !== undefined) updates.notes = notes;
  if (autoClockOutEnabled !== undefined) {
    updates.autoClockOutEnabled = autoClockOutEnabled === true || autoClockOutEnabled === "true";
  }
  if (autoClockOutDelayMinutes !== undefined) {
    // null / "" → clear the override so the site falls back to the global
    // 10-minute default. Otherwise a whole number of minutes inside the same
    // range the scheduled job clamps to, so what an admin saves is what the
    // job actually applies (no silently-ignored value).
    if (autoClockOutDelayMinutes === null || autoClockOutDelayMinutes === "") {
      updates.autoClockOutDelayMinutes = null;
    } else {
      const n = Number(autoClockOutDelayMinutes);
      if (!Number.isInteger(n) || n < AUTO_CLOCKOUT_DELAY_MIN_MINUTES || n > AUTO_CLOCKOUT_DELAY_MAX_MINUTES) {
        res.status(400).json({
          error: "Bad Request",
          message: `autoClockOutDelayMinutes must be a whole number of minutes between ${AUTO_CLOCKOUT_DELAY_MIN_MINUTES} and ${AUTO_CLOCKOUT_DELAY_MAX_MINUTES} (or null to use the ${DEFAULT_AUTO_CLOCKOUT_DELAY_MINUTES}-minute default).`,
        });
        return;
      }
      updates.autoClockOutDelayMinutes = n;
    }
  }
  if (autoClockOutPayGrace !== undefined) {
    updates.autoClockOutPayGrace = autoClockOutPayGrace === true || autoClockOutPayGrace === "true";
  }
  if (autoClockInEnabled !== undefined) {
    updates.autoClockInEnabled = autoClockInEnabled === true || autoClockInEnabled === "true";
  }
  if (processingFeeEnabled !== undefined) {
    updates.processingFeeEnabled = processingFeeEnabled === true || processingFeeEnabled === "true";
  }
  if (processingFeeRate !== undefined) {
    if (processingFeeRate === null || processingFeeRate === "") {
      updates.processingFeeRate = "8.25";
    } else {
      const n = Number(processingFeeRate);
      if (!Number.isFinite(n) || n <= 0 || n > 100) {
        res.status(400).json({ error: "Bad Request", message: "processingFeeRate must be a percentage greater than 0 and at most 100." });
        return;
      }
      updates.processingFeeRate = String(n);
    }
  }
  if (geofenceRadiusMiles !== undefined) {
    // null / "" → clear override (use global default). Otherwise must be
    // a positive finite number; 0 and negatives are rejected with 400 so
    // admins see the problem immediately instead of silently dropping the
    // field. (Clearing explicitly via null is the supported "use default"
    // path — 0 would mean "no one is ever inside", which is never useful.)
    if (geofenceRadiusMiles === null || geofenceRadiusMiles === "") {
      updates.geofenceRadiusMiles = null;
    } else {
      const n = Number(geofenceRadiusMiles);
      if (!Number.isFinite(n) || n <= 0) {
        res.status(400).json({
          error: "Bad Request",
          message: "geofenceRadiusMiles must be a positive number (or null to clear).",
        });
        return;
      }
      updates.geofenceRadiusMiles = String(n);
    }
  }

  // Snapshot current row so we can detect an address change and invalidate
  // stale coords if the admin didn't also supply fresh lat/lng.
  const [before] = await db.select().from(sitesTable).where(eq(sitesTable.id, id));
  if (!before) { res.status(404).json({ error: "Not Found" }); return; }
  updates = preparePreUpdateBody(before as any, updates);

  // Snapshot whether fee settings are changing so we can re-sync open
  // auto-synced draft invoices after save (see resyncSiteAutoSyncedDrafts).
  const feeSettingChanged =
    (processingFeeEnabled !== undefined &&
      (processingFeeEnabled === true || processingFeeEnabled === "true") !== !!before.processingFeeEnabled) ||
    (processingFeeRate !== undefined && String(processingFeeRate ?? "8.25") !== String(before.processingFeeRate ?? "8.25"));

  const [site] = await db.update(sitesTable).set(updates).where(eq(sitesTable.id, id)).returning();
  if (!site) { res.status(404).json({ error: "Not Found" }); return; }
  // Best-effort auto-geocode: if the row ends up with an address but no
  // coordinates, look them up and write back. Never blocks the response
  // on failure — same pattern as the applicant home-address geocoder.
  const final = await maybeAutoGeocode(site as Record<string, unknown>, req.log);
  res.json(final);
  // Best-effort: when fee settings changed, re-sync open auto-synced draft
  // invoices for this site so operators see the updated fee immediately
  // without having to manually regenerate each draft. Runs after the
  // response is sent so latency is not affected.
  if (feeSettingChanged) {
    resyncSiteAutoSyncedDrafts(id).catch((err) => {
      req.log?.warn({ err, siteId: id }, "[sites] background resync of auto-synced drafts failed");
    });
  }
});

router.delete("/sites/:id", requireAdmin, async (req, res): Promise<void> => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

  // Guard against silent operational-data loss. See lib/siteDeletion.ts.
  if (refuseIfBlocked(res, await siteBlockersForOne(id), "site")) return;

  await db.delete(sitesTable).where(eq(sitesTable.id, id));
  res.sendStatus(204);
});

// ---------------------------------------------------------------------------
// Site Managers (many-to-many). Admins assign one or more Site Managers to a
// site here; the assignment is the single source of truth for the site-scoped
// powers in lib/siteManagerAuthz.ts and for routing site-manager notifications.
// ---------------------------------------------------------------------------

// Minimal projection for site-manager assignment lists/pickers. We deliberately
// expose ONLY id/name/email here — never phone, status, or employee/PII fields.
const managerProjection = {
  id: usersTable.id,
  firstName: usersTable.firstName,
  lastName: usersTable.lastName,
  email: usersTable.email,
};

// GET /sites/:id/managers — list the managers assigned to a site.
// Readable by an admin OR a site manager who is assigned to THIS site (so a
// manager can see their co-managers). Any other role / unrelated manager: 403.
router.get("/sites/:id/managers", requireSchedulingStaff, async (req, res): Promise<void> => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const role = req.user!.role;
  if (role === "site_manager" && !(await canManageSite({ userId: req.user!.userId, role }, id))) {
    res.status(403).json({ error: "Forbidden", message: "Not a manager of this site" });
    return;
  }
  if (role === "dispatcher") {
    res.status(403).json({ error: "Forbidden", message: "Admin or site manager access required" });
    return;
  }
  const rows = await db
    .select(managerProjection)
    .from(siteManagersTable)
    .innerJoin(usersTable, eq(siteManagersTable.userId, usersTable.id))
    .where(eq(siteManagersTable.siteId, id))
    .orderBy(usersTable.lastName, usersTable.firstName, usersTable.id);
  res.json(rows);
});

// PUT /sites/:id/managers — replace the full set of managers for a site.
// Admin-only. Every userId must be an ACTIVE user with role=site_manager;
// otherwise 400 (we never silently drop invalid IDs). Replace-all via a
// transaction (delete existing rows, insert the new set).
router.put("/sites/:id/managers", requireAdmin, async (req, res): Promise<void> => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const [site] = await db.select({ id: sitesTable.id }).from(sitesTable).where(eq(sitesTable.id, id));
  if (!site) { res.status(404).json({ error: "Not Found" }); return; }

  const raw = (req.body?.userIds ?? []) as unknown;
  if (!Array.isArray(raw) || raw.some((u) => typeof u !== "string")) {
    res.status(400).json({ error: "Bad Request", message: "userIds must be an array of user IDs" });
    return;
  }
  const userIds = Array.from(new Set(raw as string[]));

  // Every target must be an ACTIVE user holding the Site Manager role — we
  // never grant site scope to a non-manager or a deactivated account.
  if (userIds.length > 0) {
    const valid = await db
      .select({ id: usersTable.id })
      .from(usersTable)
      .where(
        and(
          inArray(usersTable.id, userIds),
          eq(usersTable.role, "site_manager"),
          eq(usersTable.status, "active"),
        ),
      );
    if (valid.length !== userIds.length) {
      res.status(400).json({
        error: "Bad Request",
        message: "Every manager must be an active user with the Site Manager role.",
      });
      return;
    }
  }

  await db.transaction(async (tx) => {
    await tx.delete(siteManagersTable).where(eq(siteManagersTable.siteId, id));
    if (userIds.length > 0) {
      await tx.insert(siteManagersTable).values(userIds.map((userId) => ({ siteId: id, userId, assignedBy: req.user!.userId })));
    }
  });

  const rows = await db
    .select(managerProjection)
    .from(siteManagersTable)
    .innerJoin(usersTable, eq(siteManagersTable.userId, usersTable.id))
    .where(eq(siteManagersTable.siteId, id))
    .orderBy(usersTable.lastName, usersTable.firstName, usersTable.id);
  res.json(rows);
});

// GET /site-manager-candidates — admin-only picker source: every active user
// with the Site Manager role. Minimal projection (id/name/email only).
router.get("/site-manager-candidates", requireAdmin, async (_req, res): Promise<void> => {
  const rows = await db
    .select(managerProjection)
    .from(usersTable)
    .where(and(eq(usersTable.role, "site_manager"), eq(usersTable.status, "active")))
    .orderBy(usersTable.lastName, usersTable.firstName, usersTable.id);
  res.json(rows);
});

export default router;
