import { Router, type IRouter } from "express";
import { eq, desc, sql } from "drizzle-orm";
import {
  db,
  radioChannelsTable,
  radioTransmissionsTable,
  sitesTable,
  usersTable,
  auditLogsTable,
} from "@workspace/db";
import { requireAuth, requireAdmin } from "../middlewares/auth";
import { listChannelsForUser } from "../lib/radioGateway";
import { ObjectStorageService, ObjectNotFoundError } from "../lib/objectStorage";
import { logger } from "../lib/logger";

const router: IRouter = Router();

const VALID_SCOPES = new Set(["global", "all_officers", "admins", "site"]);

// GET /radio/channels — channels the caller is authorised to see.
router.get("/radio/channels", requireAuth, async (req, res): Promise<void> => {
  const rows = await listChannelsForUser(req.user!.userId, req.user!.role);
  res.json(rows.filter((r) => !r.archivedAt));
});

// GET /admin/radio/channels — every channel (admins see archived too).
router.get("/admin/radio/channels", requireAdmin, async (_req, res): Promise<void> => {
  const rows = await db
    .select({
      id: radioChannelsTable.id,
      name: radioChannelsTable.name,
      scope: radioChannelsTable.scope,
      siteId: radioChannelsTable.siteId,
      adminOnly: radioChannelsTable.adminOnly,
      slug: radioChannelsTable.slug,
      archivedAt: radioChannelsTable.archivedAt,
      createdAt: radioChannelsTable.createdAt,
      siteName: sitesTable.name,
    })
    .from(radioChannelsTable)
    .leftJoin(sitesTable, eq(sitesTable.id, radioChannelsTable.siteId))
    .orderBy(radioChannelsTable.name);
  res.json(rows);
});

// POST /admin/radio/channels
router.post("/admin/radio/channels", requireAdmin, async (req, res): Promise<void> => {
  const { name, scope, siteId } = (req.body ?? {}) as {
    name?: string; scope?: string; siteId?: string | null;
  };
  if (!name || typeof name !== "string" || !name.trim()) {
    res.status(400).json({ error: "Bad Request", message: "name is required" });
    return;
  }
  if (!scope || !VALID_SCOPES.has(scope)) {
    res.status(400).json({ error: "Bad Request", message: "scope must be global|all_officers|admins|site" });
    return;
  }
  if (scope === "site" && !siteId) {
    res.status(400).json({ error: "Bad Request", message: "siteId is required when scope=site" });
    return;
  }
  if (siteId) {
    const [site] = await db.select({ id: sitesTable.id }).from(sitesTable).where(eq(sitesTable.id, siteId)).limit(1);
    if (!site) { res.status(404).json({ error: "Not Found", message: "site not found" }); return; }
  }
  const [row] = await db
    .insert(radioChannelsTable)
    .values({
      name: name.trim(),
      scope,
      siteId: scope === "site" ? siteId! : null,
      adminOnly: scope === "admins",
    })
    .returning();
  res.status(201).json(row);
});

// PATCH /admin/radio/channels/:id
router.patch("/admin/radio/channels/:id", requireAdmin, async (req, res): Promise<void> => {
  const id = String(req.params.id);
  const { name, archived } = (req.body ?? {}) as { name?: string; archived?: boolean };
  const patch: Record<string, unknown> = {};
  if (typeof name === "string" && name.trim()) patch.name = name.trim();
  if (typeof archived === "boolean") patch.archivedAt = archived ? new Date() : null;
  if (Object.keys(patch).length === 0) {
    res.status(400).json({ error: "Bad Request", message: "nothing to update" });
    return;
  }
  const [row] = await db
    .update(radioChannelsTable)
    .set(patch)
    .where(eq(radioChannelsTable.id, id))
    .returning();
  if (!row) { res.status(404).json({ error: "Not Found", message: "channel not found" }); return; }
  res.json(row);
});

// DELETE /admin/radio/channels/:id
router.delete("/admin/radio/channels/:id", requireAdmin, async (req, res): Promise<void> => {
  const id = String(req.params.id);
  const rows = await db.delete(radioChannelsTable).where(eq(radioChannelsTable.id, id)).returning({ id: radioChannelsTable.id });
  if (rows.length === 0) { res.status(404).json({ error: "Not Found", message: "channel not found" }); return; }
  res.status(204).end();
});

// GET /admin/radio/channels/:id/transmissions
router.get("/admin/radio/channels/:id/transmissions", requireAdmin, async (req, res): Promise<void> => {
  const id = String(req.params.id);
  const limit = Math.max(1, Math.min(500, parseInt(String(req.query.limit ?? "100"), 10) || 100));
  const rows = await db
    .select({
      id: radioTransmissionsTable.id,
      channelId: radioTransmissionsTable.channelId,
      speakerUserId: radioTransmissionsTable.speakerUserId,
      speakerName: sql<string>`${usersTable.firstName} || ' ' || ${usersTable.lastName}`,
      startedAt: radioTransmissionsTable.startedAt,
      endedAt: radioTransmissionsTable.endedAt,
      durationMs: radioTransmissionsTable.durationMs,
      endedReason: radioTransmissionsTable.endedReason,
      hasRecording: sql<boolean>`${radioTransmissionsTable.audioObjectKey} IS NOT NULL`,
      audioBytes: radioTransmissionsTable.audioBytes,
      audioMime: radioTransmissionsTable.audioMime,
    })
    .from(radioTransmissionsTable)
    .leftJoin(usersTable, eq(usersTable.id, radioTransmissionsTable.speakerUserId))
    .where(eq(radioTransmissionsTable.channelId, id))
    .orderBy(desc(radioTransmissionsTable.startedAt))
    .limit(limit);
  res.json(rows);
});

// GET /admin/radio/transmissions/:id/audio — stream the recorded clip.
// Admin-only. Proxies the bytes from private object storage with the
// stored mime type so an <audio> tag can play it directly.
router.get("/admin/radio/transmissions/:id/audio", requireAdmin, async (req, res): Promise<void> => {
  const id = String(req.params.id);
  const [row] = await db
    .select({
      id: radioTransmissionsTable.id,
      channelId: radioTransmissionsTable.channelId,
      speakerUserId: radioTransmissionsTable.speakerUserId,
      audioObjectKey: radioTransmissionsTable.audioObjectKey,
      audioMime: radioTransmissionsTable.audioMime,
      audioBytes: radioTransmissionsTable.audioBytes,
    })
    .from(radioTransmissionsTable)
    .where(eq(radioTransmissionsTable.id, id))
    .limit(1);
  if (!row || !row.audioObjectKey) {
    res.status(404).json({ error: "Not Found", message: "no recording for this transmission" });
    return;
  }
  try {
    const storage = new ObjectStorageService();
    const { buffer, contentType } = await storage.downloadObjectBuffer(row.audioObjectKey);
    res.setHeader("Content-Type", row.audioMime || contentType || "audio/webm");
    res.setHeader("Content-Length", String(buffer.length));
    res.setHeader("Cache-Control", "private, max-age=300");
    res.status(200).end(buffer);
    // Fire-and-forget audit so admins reviewing officer voice are traceable.
    db.insert(auditLogsTable).values({
      actorUserId: req.user!.userId,
      actorEmail: req.user!.email ?? null,
      actorRole: req.user!.role ?? null,
      action: "radio.playback",
      targetTable: "radio_transmissions",
      targetId: row.id,
      method: "GET",
      path: req.originalUrl,
      statusCode: 200,
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
      before: null,
      after: null,
      metadata: { channelId: row.channelId, speakerUserId: row.speakerUserId },
    }).catch((err) => logger.warn({ err }, "[radio] failed to audit playback"));
  } catch (err) {
    if (err instanceof ObjectNotFoundError) {
      res.status(404).json({ error: "Not Found", message: "recording is no longer available" });
      return;
    }
    logger.error({ err, transmissionId: id }, "[radio] failed to stream recording");
    res.status(500).json({ error: "Server Error", message: "failed to stream recording" });
  }
});

export default router;
