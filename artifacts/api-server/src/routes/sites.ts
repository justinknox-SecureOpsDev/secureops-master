import { Router, type IRouter } from "express";
import { eq, sql } from "drizzle-orm";
import { db, sitesTable, clientsTable } from "@workspace/db";
import { requireAdmin } from "../middlewares/auth";

const router: IRouter = Router();

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
  res.json(site);
});

router.delete("/sites/:id", requireAdmin, async (req, res): Promise<void> => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  await db.delete(sitesTable).where(eq(sitesTable.id, id));
  res.sendStatus(204);
});

export default router;
