import { Router, type IRouter } from "express";
import { eq, inArray } from "drizzle-orm";
import { db, clientsTable, sitesTable } from "@workspace/db";
import { requireAdmin, requireAdminOrSiteManager } from "../middlewares/auth";
import { geocodeOnelineAddress } from "../lib/geocode";
import { clientDeletionBlockers, refuseIfBlocked } from "../lib/siteDeletion";
import { getManagedSiteIds } from "../lib/siteManagerAuthz";

const router: IRouter = Router();

// A `site_manager` only needs to IDENTIFY the client a managed site belongs to
// (the client `name`) when scheduling. Strip finance (billing address / payment
// terms), contact PII (contact name/email/phone), and free-text notes — none of
// which a site manager has a remit to see. Harmless ids/timestamps pass through.
function projectClientForSiteManager<T extends Record<string, unknown>>(row: T): Partial<T> {
  const {
    billingAddress,
    paymentTermsDays,
    contactName,
    contactEmail,
    contactPhone,
    notes,
    ...rest
  } = row as Record<string, unknown>;
  return rest as Partial<T>;
}

// Site managers need the client list to render the client of the sites they
// manage when scheduling — but ONLY for those clients, and with finance + contact
// PII stripped (see projectClientForSiteManager). Returning every client would
// leak cross-site client PII for clients whose sites the manager has no remit
// over. Admins see the full list.
router.get("/clients", requireAdminOrSiteManager, async (req, res): Promise<void> => {
  if (req.user!.role === "site_manager") {
    const managedSiteIds = await getManagedSiteIds(req.user!.userId);
    if (managedSiteIds.length === 0) { res.json([]); return; }
    const managedSites = await db
      .select({ clientId: sitesTable.clientId })
      .from(sitesTable)
      .where(inArray(sitesTable.id, managedSiteIds));
    const clientIds = Array.from(
      new Set(managedSites.map((s) => s.clientId).filter((c): c is string => !!c)),
    );
    if (clientIds.length === 0) { res.json([]); return; }
    const rows = await db.select().from(clientsTable).where(inArray(clientsTable.id, clientIds));
    res.json(rows.map((r) => projectClientForSiteManager(r)));
    return;
  }
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
  // Deleting a client CASCADE-deletes its sites, which would silently null/cascade
  // their operational data. Refuse while any of that exists. See lib/siteDeletion.ts.
  if (refuseIfBlocked(res, await clientDeletionBlockers(id), "client")) return;
  await db.delete(clientsTable).where(eq(clientsTable.id, id));
  res.sendStatus(204);
});

router.post("/clients/:id/sites", requireAdmin, async (req, res): Promise<void> => {
  const clientId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const { name, address, locationLat, locationLng, notes } = req.body;
  if (!name) { res.status(400).json({ error: "Bad Request", message: "name is required" }); return; }
  const [client] = await db.select().from(clientsTable).where(eq(clientsTable.id, clientId));
  if (!client) { res.status(404).json({ error: "Not Found", message: "Client not found" }); return; }
  let lat: string | null = locationLat != null ? String(locationLat) : null;
  let lng: string | null = locationLng != null ? String(locationLng) : null;
  // Best-effort auto-geocode when admin saved an address but no coords.
  // Mirrors the applicant geocoder: never blocks the save, just logs on failure.
  if (address && lat == null && lng == null) {
    try {
      const result = await geocodeOnelineAddress(address);
      if (result) {
        lat = String(result.lat);
        lng = String(result.lng);
      }
    } catch (err) {
      req.log.info({ err: (err as Error).message }, "Auto-geocode on site create failed");
    }
  }
  const [site] = await db.insert(sitesTable).values({
    clientId,
    name,
    address: address || null,
    locationLat: lat,
    locationLng: lng,
    notes: notes || null,
  }).returning();
  res.status(201).json({ ...site, clientName: client.name });
});

export default router;
