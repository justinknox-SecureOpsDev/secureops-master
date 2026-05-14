import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, clientsTable, sitesTable } from "@workspace/db";
import { requireAdmin } from "../middlewares/auth";

const router: IRouter = Router();

router.get("/clients", requireAdmin, async (_req, res): Promise<void> => {
  const rows = await db.select().from(clientsTable);
  res.json(rows);
});

router.get("/clients/:id", requireAdmin, async (req, res): Promise<void> => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const [client] = await db.select().from(clientsTable).where(eq(clientsTable.id, id));
  if (!client) { res.status(404).json({ error: "Not Found" }); return; }
  const sites = await db.select().from(sitesTable).where(eq(sitesTable.clientId, id));
  res.json({ ...client, sites });
});

router.post("/clients", requireAdmin, async (req, res): Promise<void> => {
  const { name, contactName, contactEmail, contactPhone, billingAddress, paymentTermsDays, notes } = req.body;
  if (!name || paymentTermsDays == null) {
    res.status(400).json({ error: "Bad Request", message: "name and paymentTermsDays are required" });
    return;
  }
  const [client] = await db.insert(clientsTable).values({
    name,
    contactName: contactName || null,
    contactEmail: contactEmail || null,
    contactPhone: contactPhone || null,
    billingAddress: billingAddress || null,
    paymentTermsDays: Number(paymentTermsDays),
    notes: notes || null,
  }).returning();
  res.status(201).json(client);
});

router.put("/clients/:id", requireAdmin, async (req, res): Promise<void> => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const { name, contactName, contactEmail, contactPhone, billingAddress, paymentTermsDays, notes } = req.body;
  const updates: Record<string, unknown> = {};
  if (name !== undefined) updates.name = name;
  if (contactName !== undefined) updates.contactName = contactName;
  if (contactEmail !== undefined) updates.contactEmail = contactEmail;
  if (contactPhone !== undefined) updates.contactPhone = contactPhone;
  if (billingAddress !== undefined) updates.billingAddress = billingAddress;
  if (paymentTermsDays !== undefined) updates.paymentTermsDays = Number(paymentTermsDays);
  if (notes !== undefined) updates.notes = notes;

  const [client] = await db.update(clientsTable).set(updates).where(eq(clientsTable.id, id)).returning();
  if (!client) { res.status(404).json({ error: "Not Found" }); return; }
  res.json(client);
});

router.delete("/clients/:id", requireAdmin, async (req, res): Promise<void> => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  await db.delete(clientsTable).where(eq(clientsTable.id, id));
  res.sendStatus(204);
});

router.post("/clients/:id/sites", requireAdmin, async (req, res): Promise<void> => {
  const clientId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const { name, address, locationLat, locationLng, notes } = req.body;
  if (!name) { res.status(400).json({ error: "Bad Request", message: "name is required" }); return; }
  const [client] = await db.select().from(clientsTable).where(eq(clientsTable.id, clientId));
  if (!client) { res.status(404).json({ error: "Not Found", message: "Client not found" }); return; }
  const [site] = await db.insert(sitesTable).values({
    clientId,
    name,
    address: address || null,
    locationLat: locationLat != null ? String(locationLat) : null,
    locationLng: locationLng != null ? String(locationLng) : null,
    notes: notes || null,
  }).returning();
  res.status(201).json({ ...site, clientName: client.name });
});

export default router;
