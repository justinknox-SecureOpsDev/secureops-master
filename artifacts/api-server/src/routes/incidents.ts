import { Router, type IRouter } from "express";
import { eq, and, sql } from "drizzle-orm";
import { db, incidentsTable, usersTable, shiftsTable } from "@workspace/db";
import { requireAuth, requireAdmin } from "../middlewares/auth";

const router: IRouter = Router();

router.get("/incidents", requireAuth, async (req, res): Promise<void> => {
  const { employeeId, shiftId, severity, status } = req.query as Record<string, string | undefined>;
  const conditions = [];
  if (req.user!.role !== "admin") {
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
  if (req.user!.role !== "admin" && row.employeeId !== req.user!.userId) {
    res.status(403).json({ error: "Forbidden" }); return;
  }
  res.json(row);
});

router.put("/incidents/:id", requireAdmin, async (req, res): Promise<void> => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const { status, adminNotes, resolvedAt } = req.body;
  const updates: Record<string, unknown> = {};
  if (status) updates.status = status;
  if (adminNotes !== undefined) updates.adminNotes = adminNotes;
  if (resolvedAt) updates.resolvedAt = new Date(resolvedAt);

  const [incident] = await db.update(incidentsTable).set(updates).where(eq(incidentsTable.id, id)).returning();
  if (!incident) { res.status(404).json({ error: "Not Found" }); return; }
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, incident.employeeId));
  res.json({ ...incident, employeeName: user ? `${user.firstName} ${user.lastName}` : null, shiftTitle: null });
});

export default router;
