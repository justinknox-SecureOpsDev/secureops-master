import { Router, type IRouter } from "express";
import { and, eq, isNull, or, sql } from "drizzle-orm";
import { db, sitesTable, clientsTable } from "@workspace/db";
import { requireAdmin, requireAdminOrDispatcher } from "../middlewares/auth";
import { geocodeOnelineAddress } from "../lib/geocode";
import { preparePreUpdateBody, maybeAutoGeocode } from "../lib/siteGeocode";
import { getGeofenceRadiusMiles } from "../lib/geofence";

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

router.get("/sites", requireAdminOrDispatcher, async (req, res): Promise<void> => {
  const { clientId } = req.query as { clientId?: string };
  const base = db
    .select({
      id: sitesTable.id,
      clientId: sitesTable.clientId,
      clientName: clientsTable.name,
      name: sitesTable.name,
      address: sitesTable.address,
      locationLat: sitesTable.locationLat,
      locationLng: sitesTable.locationLng,
      notes: sitesTable.notes,
      geofenceRadiusMiles: sitesTable.geofenceRadiusMiles,
      createdAt: sitesTable.createdAt,
    })
    .from(sitesTable)
    .leftJoin(clientsTable, eq(sitesTable.clientId, clientsTable.id));
  const rows = clientId ? await base.where(eq(sitesTable.clientId, clientId)) : await base;
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
      address: sitesTable.address,
      locationLat: sitesTable.locationLat,
      locationLng: sitesTable.locationLng,
      notes: sitesTable.notes,
      geofenceRadiusMiles: sitesTable.geofenceRadiusMiles,
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
  const { name, address, locationLat, locationLng, notes, geofenceRadiusMiles } = req.body;
  let updates: Record<string, unknown> = {};
  if (name !== undefined) updates.name = name;
  if (address !== undefined) updates.address = address;
  if (locationLat !== undefined) updates.locationLat = locationLat != null ? String(locationLat) : null;
  if (locationLng !== undefined) updates.locationLng = locationLng != null ? String(locationLng) : null;
  if (notes !== undefined) updates.notes = notes;
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

  const [site] = await db.update(sitesTable).set(updates).where(eq(sitesTable.id, id)).returning();
  if (!site) { res.status(404).json({ error: "Not Found" }); return; }
  // Best-effort auto-geocode: if the row ends up with an address but no
  // coordinates, look them up and write back. Never blocks the response
  // on failure — same pattern as the applicant home-address geocoder.
  const final = await maybeAutoGeocode(site as Record<string, unknown>, req.log);
  res.json(final);
});

router.delete("/sites/:id", requireAdmin, async (req, res): Promise<void> => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  await db.delete(sitesTable).where(eq(sitesTable.id, id));
  res.sendStatus(204);
});

export default router;
