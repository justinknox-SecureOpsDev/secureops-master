import { Router, type IRouter } from "express";
import { eq, and, or, sql } from "drizzle-orm";
import { db, incidentsTable, usersTable, shiftsTable } from "@workspace/db";
import { requireAuth, requireAdminOrDispatcher } from "../middlewares/auth";
import { buildIncidentReportPdf } from "../lib/incidentPdf";
import { broadcastToRoom } from "../lib/wsManager";

const router: IRouter = Router();

/**
 * Push a lightweight "something changed in incidents" pulse to every
 * connected admin and dispatcher. The Dispatch page subscribes to this
 * (with polling as a fallback) so a brand-new emergency or status edit
 * shows up without waiting on the 30s timer.
 */
async function broadcastIncidentChange(payload: { type: "incident:changed"; incidentId: string; severity?: string }): Promise<void> {
  const recipients = await db
    .select({ id: usersTable.id })
    .from(usersTable)
    .where(or(eq(usersTable.role, "admin"), eq(usersTable.role, "dispatcher")));
  const ids = new Set(recipients.map((r) => r.id));
  if (ids.size === 0) return;
  broadcastToRoom("incidents", payload, { allowedUserIds: ids });
}

router.get("/incidents", requireAuth, async (req, res): Promise<void> => {
  const { employeeId, shiftId, severity, status } = req.query as Record<string, string | undefined>;
  const conditions = [];
  const isPrivileged = req.user!.role === "admin" || req.user!.role === "dispatcher";
  if (!isPrivileged) {
    conditions.push(eq(incidentsTable.employeeId, req.user!.userId));
  } else if (employeeId) {
    conditions.push(eq(incidentsTable.employeeId, employeeId));
  }
  if (shiftId) conditions.push(eq(incidentsTable.shiftId, shiftId));
  if (severity) conditions.push(eq(incidentsTable.severity, severity));
  if (status) conditions.push(eq(incidentsTable.status, status));

  const rows = await db
    .select({
      id: incidentsTable.id,
      shiftId: incidentsTable.shiftId,
      employeeId: incidentsTable.employeeId,
      title: incidentsTable.title,
      description: incidentsTable.description,
      severity: incidentsTable.severity,
      status: incidentsTable.status,
      locationDescription: incidentsTable.locationDescription,
      lat: incidentsTable.lat,
      lng: incidentsTable.lng,
      occurredAt: incidentsTable.occurredAt,
      resolvedAt: incidentsTable.resolvedAt,
      adminNotes: incidentsTable.adminNotes,
      attachments: incidentsTable.attachments,
      createdAt: incidentsTable.createdAt,
      employeeName: sql<string>`${usersTable.firstName} || ' ' || ${usersTable.lastName}`,
      shiftTitle: shiftsTable.title,
    })
    .from(incidentsTable)
    .leftJoin(usersTable, eq(incidentsTable.employeeId, usersTable.id))
    .leftJoin(shiftsTable, eq(incidentsTable.shiftId, shiftsTable.id))
    .where(conditions.length > 0 ? and(...conditions) : undefined);

  res.json(rows);
});

router.post("/incidents", requireAuth, async (req, res): Promise<void> => {
  const { shiftId, title, description, severity, locationDescription, lat, lng, occurredAt, attachments } = req.body;
  if (!title || !description || !severity || !occurredAt) {
    res.status(400).json({ error: "Bad Request", message: "title, description, severity, occurredAt required" });
    return;
  }
  // Only accept attachment paths that were uploaded via this user's bound
  // upload prefix (`/objects/uploads/u/<userId>/...`). The presigned-URL
  // endpoint stamps the authenticated user's id into the path, so this
  // prevents an officer from referencing object paths they don't own.
  const ownedPrefix = `/objects/uploads/u/${req.user!.userId}/`;
  const cleanAttachments: string[] = Array.isArray(attachments)
    ? attachments.filter((p): p is string => typeof p === "string" && p.startsWith(ownedPrefix))
    : [];
  const [incident] = await db.insert(incidentsTable).values({
    shiftId: shiftId || null,
    employeeId: req.user!.userId,
    title,
    description,
    severity,
    status: "open",
    locationDescription: locationDescription || null,
    lat: lat ? String(lat) : null,
    lng: lng ? String(lng) : null,
    occurredAt: new Date(occurredAt),
    attachments: cleanAttachments,
  }).returning();

  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, req.user!.userId));
  await broadcastIncidentChange({ type: "incident:changed", incidentId: incident.id, severity: incident.severity });
  res.status(201).json({
    ...incident,
    employeeName: user ? `${user.firstName} ${user.lastName}` : null,
    shiftTitle: null,
  });
});

router.get("/incidents/:id", requireAuth, async (req, res): Promise<void> => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const [row] = await db
    .select({
      id: incidentsTable.id,
      shiftId: incidentsTable.shiftId,
      employeeId: incidentsTable.employeeId,
      title: incidentsTable.title,
      description: incidentsTable.description,
      severity: incidentsTable.severity,
      status: incidentsTable.status,
      locationDescription: incidentsTable.locationDescription,
      lat: incidentsTable.lat,
      lng: incidentsTable.lng,
      occurredAt: incidentsTable.occurredAt,
      resolvedAt: incidentsTable.resolvedAt,
      adminNotes: incidentsTable.adminNotes,
      attachments: incidentsTable.attachments,
      createdAt: incidentsTable.createdAt,
      employeeName: sql<string>`${usersTable.firstName} || ' ' || ${usersTable.lastName}`,
      shiftTitle: shiftsTable.title,
    })
    .from(incidentsTable)
    .leftJoin(usersTable, eq(incidentsTable.employeeId, usersTable.id))
    .leftJoin(shiftsTable, eq(incidentsTable.shiftId, shiftsTable.id))
    .where(eq(incidentsTable.id, id));

  if (!row) { res.status(404).json({ error: "Not Found" }); return; }
  if (req.user!.role !== "admin" && req.user!.role !== "dispatcher" && row.employeeId !== req.user!.userId) {
    res.status(403).json({ error: "Forbidden" }); return;
  }
  res.json(row);
});

router.get("/incidents/:id/pdf", requireAuth, async (req, res): Promise<void> => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  // Same authorization model as GET /incidents/:id: admin reads anything,
  // employees only their own.
  const [own] = await db.select({ employeeId: incidentsTable.employeeId })
    .from(incidentsTable).where(eq(incidentsTable.id, id));
  if (!own) { res.status(404).json({ error: "Not Found" }); return; }
  if (req.user!.role !== "admin" && own.employeeId !== req.user!.userId) {
    res.status(403).json({ error: "Forbidden" }); return;
  }
  const payload = await buildIncidentReportPdf(id);
  if (!payload) { res.status(404).json({ error: "Not Found" }); return; }
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${payload.filename}"`);
  res.setHeader("Cache-Control", "private, no-store");
  payload.stream.pipe(res);
});

router.put("/incidents/:id", requireAdminOrDispatcher, async (req, res): Promise<void> => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const { status, adminNotes, resolvedAt } = req.body;
  const updates: Record<string, unknown> = {};
  if (status) updates.status = status;
  if (adminNotes !== undefined) updates.adminNotes = adminNotes;
  if (resolvedAt) updates.resolvedAt = new Date(resolvedAt);

  const [incident] = await db.update(incidentsTable).set(updates).where(eq(incidentsTable.id, id)).returning();
  if (!incident) { res.status(404).json({ error: "Not Found" }); return; }
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, incident.employeeId));
  await broadcastIncidentChange({ type: "incident:changed", incidentId: incident.id, severity: incident.severity });
  res.json({ ...incident, employeeName: user ? `${user.firstName} ${user.lastName}` : null, shiftTitle: null });
});

export default router;
