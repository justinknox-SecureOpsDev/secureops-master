import { Router, type IRouter } from "express";
import { and, eq, ne, desc, sql } from "drizzle-orm";
import {
  db,
  radioChannelsTable,
  radioTransmissionsTable,
  sitesTable,
  usersTable,
} from "@workspace/db";
import { requireAdmin, requireStaff } from "../middlewares/auth";
import {
  listChannelsForUser,
  canAccessChannel,
  userHoldsChannelLock,
  preemptChannelLock,
  broadcastChannelsChanged,
} from "../lib/radioGateway";
import {
  isLiveKitConfigured,
  mintSubscribeToken,
  mintPublishToken,
} from "../lib/livekit";
import { requireFeature } from "../lib/features";

const router: IRouter = Router();
router.use(["/radio", "/admin/radio"], requireFeature("radio"));

const VALID_SCOPES = new Set(["global", "all_officers", "admins", "site"]);

/**
 * Clear `alwaysOn` on every channel except `keepId`.
 *
 * Exactly one channel may be always-on: it is the single channel a clocked-in
 * officer's phone holds open in the background, so two of them would double
 * the standing LiveKit connections (and the battery/data cost) that the flag
 * exists to bound. Enforced here on write rather than by a partial unique
 * index so an admin flipping the switch on a second channel simply moves it
 * instead of getting an error.
 */
async function clearOtherAlwaysOn(
  tx: { update: typeof db.update },
  keepId: string,
): Promise<void> {
  await tx
    .update(radioChannelsTable)
    .set({ alwaysOn: false })
    .where(and(eq(radioChannelsTable.alwaysOn, true), ne(radioChannelsTable.id, keepId)));
}

/** Human-readable name for a LiveKit participant (cosmetic; identity = userId). */
async function resolveDisplayName(userId: string): Promise<string> {
  const [u] = await db
    .select({ firstName: usersTable.firstName, lastName: usersTable.lastName })
    .from(usersTable)
    .where(eq(usersTable.id, userId))
    .limit(1);
  const name = u ? `${u.firstName} ${u.lastName}`.trim() : "";
  return name || "Officer";
}

// GET /radio/channels — channels the caller is authorised to see.
router.get("/radio/channels", requireStaff, async (req, res): Promise<void> => {
  const rows = await listChannelsForUser(req.user!.userId, req.user!.role);
  res.json(rows.filter((r) => !r.archivedAt));
});

// POST /radio/channels/:id/livekit-token — listen-only (subscribe) LiveKit
// token for an authorised channel member. Audio rides a LiveKit room; this
// reuses the same canAccessChannel gate as the WS control plane.
router.post("/radio/channels/:id/livekit-token", requireStaff, async (req, res): Promise<void> => {
  if (!isLiveKitConfigured()) {
    res.status(503).json({ error: "Service Unavailable", message: "Live radio audio is not configured" });
    return;
  }
  const id = String(req.params.id);
  const [channel] = await db.select().from(radioChannelsTable).where(eq(radioChannelsTable.id, id)).limit(1);
  if (!channel) { res.status(404).json({ error: "Not Found", message: "channel not found" }); return; }
  if (!(await canAccessChannel(req.user!.userId, req.user!.role, channel))) {
    res.status(403).json({ error: "Forbidden", message: "not authorised for this channel" });
    return;
  }
  const displayName = await resolveDisplayName(req.user!.userId);
  const result = await mintSubscribeToken({ channelId: id, userId: req.user!.userId, displayName });
  res.json(result);
});

// POST /radio/channels/:id/livekit-publish-token — short-lived PUBLISH token,
// minted ONLY after the caller has won the in-memory speaker lock (claimed
// over the /api/ws/radio control socket). This keeps the single-speaker
// guarantee server-side: a client can never publish audio without the lock.
router.post("/radio/channels/:id/livekit-publish-token", requireStaff, async (req, res): Promise<void> => {
  if (!isLiveKitConfigured()) {
    res.status(503).json({ error: "Service Unavailable", message: "Live radio audio is not configured" });
    return;
  }
  const id = String(req.params.id);
  const [channel] = await db.select().from(radioChannelsTable).where(eq(radioChannelsTable.id, id)).limit(1);
  if (!channel) { res.status(404).json({ error: "Not Found", message: "channel not found" }); return; }
  if (!(await canAccessChannel(req.user!.userId, req.user!.role, channel))) {
    res.status(403).json({ error: "Forbidden", message: "not authorised for this channel" });
    return;
  }
  if (!userHoldsChannelLock(id, req.user!.userId)) {
    res.status(409).json({ error: "Conflict", message: "you do not hold the speaker lock for this channel" });
    return;
  }
  const displayName = await resolveDisplayName(req.user!.userId);
  const result = await mintPublishToken({ channelId: id, userId: req.user!.userId, displayName });
  res.json(result);
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
      alwaysOn: radioChannelsTable.alwaysOn,
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
  const { name, scope, siteId, alwaysOn } = (req.body ?? {}) as {
    name?: string; scope?: string; siteId?: string | null; alwaysOn?: boolean;
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
  // One transaction so two admins designating different channels at once can
  // never leave the fleet with two always-on channels (or none).
  const row = await db.transaction(async (tx) => {
    const [created] = await tx
      .insert(radioChannelsTable)
      .values({
        name: name.trim(),
        scope,
        siteId: scope === "site" ? siteId! : null,
        adminOnly: scope === "admins",
        alwaysOn: alwaysOn === true,
        // Stamped on any explicit choice, on or off — it records that a human
        // has decided, which switches off boot-time adoption for good.
        alwaysOnSetAt: typeof alwaysOn === "boolean" ? new Date() : null,
      })
      .returning();
    if (created.alwaysOn) await clearOtherAlwaysOn(tx, created.id);
    return created;
  });
  broadcastChannelsChanged();
  res.status(201).json(row);
});

// PATCH /admin/radio/channels/:id
router.patch("/admin/radio/channels/:id", requireAdmin, async (req, res): Promise<void> => {
  const id = String(req.params.id);
  const { name, archived, scope, siteId, alwaysOn } = (req.body ?? {}) as {
    name?: string; archived?: boolean; scope?: string; siteId?: string | null; alwaysOn?: boolean;
  };
  const patch: Record<string, unknown> = {};
  if (typeof name === "string" && name.trim()) patch.name = name.trim();
  if (typeof archived === "boolean") patch.archivedAt = archived ? new Date() : null;
  if (typeof alwaysOn === "boolean") {
    patch.alwaysOn = alwaysOn;
    // A human decided — boot-time adoption must never override this later.
    patch.alwaysOnSetAt = new Date();
  }
  // Scope/site retargeting mirrors POST validation: a valid scope, a real site
  // when scope=site, adminOnly derived from scope, and siteId nulled for any
  // non-site scope so a stale siteId can't linger after a scope change.
  if (scope !== undefined) {
    if (!VALID_SCOPES.has(scope)) {
      res.status(400).json({ error: "Bad Request", message: "scope must be global|all_officers|admins|site" });
      return;
    }
    if (scope === "site" && !siteId) {
      res.status(400).json({ error: "Bad Request", message: "siteId is required when scope=site" });
      return;
    }
    if (scope === "site") {
      const [site] = await db.select({ id: sitesTable.id }).from(sitesTable).where(eq(sitesTable.id, siteId!)).limit(1);
      if (!site) { res.status(404).json({ error: "Not Found", message: "site not found" }); return; }
    }
    patch.scope = scope;
    patch.siteId = scope === "site" ? siteId! : null;
    patch.adminOnly = scope === "admins";
  }
  if (Object.keys(patch).length === 0) {
    res.status(400).json({ error: "Bad Request", message: "nothing to update" });
    return;
  }
  // Same transaction as create: the designation moves atomically.
  const row = await db.transaction(async (tx) => {
    const [updated] = await tx
      .update(radioChannelsTable)
      .set(patch)
      .where(eq(radioChannelsTable.id, id))
      .returning();
    if (updated?.alwaysOn) await clearOtherAlwaysOn(tx, updated.id);
    return updated;
  });
  if (!row) { res.status(404).json({ error: "Not Found", message: "channel not found" }); return; }
  broadcastChannelsChanged();
  res.json(row);
});

// POST /admin/radio/channels/:id/preempt — admin "take over": force-clear
// whoever currently holds the speaker lock so the channel is free. Does NOT
// grant the admin the floor; they press push-to-talk afterwards like anyone.
router.post("/admin/radio/channels/:id/preempt", requireAdmin, async (req, res): Promise<void> => {
  const id = String(req.params.id);
  const [channel] = await db
    .select({ id: radioChannelsTable.id })
    .from(radioChannelsTable)
    .where(eq(radioChannelsTable.id, id))
    .limit(1);
  if (!channel) { res.status(404).json({ error: "Not Found", message: "channel not found" }); return; }
  const result = await preemptChannelLock(id);
  res.json(result);
});

// DELETE /admin/radio/channels/:id
router.delete("/admin/radio/channels/:id", requireAdmin, async (req, res): Promise<void> => {
  const id = String(req.params.id);
  const rows = await db.delete(radioChannelsTable).where(eq(radioChannelsTable.id, id)).returning({ id: radioChannelsTable.id });
  if (rows.length === 0) { res.status(404).json({ error: "Not Found", message: "channel not found" }); return; }
  broadcastChannelsChanged();
  res.status(204).end();
});

// GET /admin/radio/channels/:id/transmissions — audit trail of past
// transmissions (speaker, time, duration, reason). Audio is never stored;
// these rows are metadata only.
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
    })
    .from(radioTransmissionsTable)
    .leftJoin(usersTable, eq(usersTable.id, radioTransmissionsTable.speakerUserId))
    .where(eq(radioTransmissionsTable.channelId, id))
    .orderBy(desc(radioTransmissionsTable.startedAt))
    .limit(limit);
  res.json(rows);
});

export default router;
