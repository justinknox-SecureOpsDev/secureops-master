import { Router, type IRouter } from "express";
import { and, eq, isNull, sql } from "drizzle-orm";
import { db, sitesTable, clientsTable } from "@workspace/db";
import { requireAdmin } from "../middlewares/auth";
import { geocodeOnelineAddress } from "../lib/geocode";

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
  const rows = await db
    .select({
      id: sitesTable.id,
      name: sitesTable.name,
      address: sitesTable.address,
    })
    .from(sitesTable)
    .where(and(isNull(sitesTable.locationLat), sql`length(trim(coalesce(${sitesTable.address}, ''))) > 0`));

  let resolved = 0;
  const unresolved: Array<{ id: string; name: string }> = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const address = (row.address ?? "").trim();
    if (!address) {
      unresolved.push({ id: row.id, name: row.name });
      continue;
    }
    const match = await geocodeOnelineAddress(address);
    if (match) {
      await db
        .update(sitesTable)
        .set({ locationLat: String(match.lat), locationLng: String(match.lng) })
        .where(and(eq(sitesTable.id, row.id), isNull(sitesTable.locationLat)));
      resolved++;
    } else {
      unresolved.push({ id: row.id, name: row.name });
    }
    // Rate-pace ~5 req/s so we stay polite with the free Census API.
    if (i < rows.length - 1) await new Promise((r) => setTimeout(r, 200));
  }

  res.json({
    candidates: rows.length,
    resolved,
    unresolved: unresolved.length,
    unresolvedSites: unresolved.slice(0, 25),
  });
});

router.get("/sites", requireAdmin, async (req, res): Promise<void> => {
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
      createdAt: sitesTable.createdAt,
    })
    .from(sitesTable)
    .leftJoin(clientsTable, eq(sitesTable.clientId, clientsTable.id));
  const rows = clientId ? await base.where(eq(sitesTable.clientId, clientId)) : await base;
  res.json(rows);
});

router.get("/sites/:id", requireAdmin, async (req, res): Promise<void> => {
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
      createdAt: sitesTable.createdAt,
    })
    .from(sitesTable)
    .leftJoin(clientsTable, eq(sitesTable.clientId, clientsTable.id))
    .where(eq(sitesTable.id, id));
  if (!site) { res.status(404).json({ error: "Not Found" }); return; }
  res.json(site);
});

router.put("/sites/:id", requireAdmin, async (req, res): Promise<void> => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const { name, address, locationLat, locationLng, notes } = req.body;
  const updates: Record<string, unknown> = {};
  if (name !== undefined) updates.name = name;
  if (address !== undefined) updates.address = address;
  if (locationLat !== undefined) updates.locationLat = locationLat != null ? String(locationLat) : null;
  if (locationLng !== undefined) updates.locationLng = locationLng != null ? String(locationLng) : null;
  if (notes !== undefined) updates.notes = notes;
  const [site] = await db.update(sitesTable).set(updates).where(eq(sitesTable.id, id)).returning();
  if (!site) { res.status(404).json({ error: "Not Found" }); return; }
  // Best-effort auto-geocode: if the row ends up with an address but no
  // coordinates, look them up and write back. Never blocks the response
  // on failure — same pattern as the applicant home-address geocoder.
  if (site.address && site.locationLat == null && site.locationLng == null) {
    try {
      const result = await geocodeOnelineAddress(site.address);
      if (result) {
        const [updated] = await db
          .update(sitesTable)
          .set({ locationLat: String(result.lat), locationLng: String(result.lng) })
          .where(eq(sitesTable.id, id))
          .returning();
        if (updated) {
          res.json(updated);
          return;
        }
      }
    } catch (err) {
      req.log.info({ err: (err as Error).message }, "Auto-geocode on site update failed");
    }
  }
  res.json(site);
});

router.delete("/sites/:id", requireAdmin, async (req, res): Promise<void> => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  await db.delete(sitesTable).where(eq(sitesTable.id, id));
  res.sendStatus(204);
});

export default router;
