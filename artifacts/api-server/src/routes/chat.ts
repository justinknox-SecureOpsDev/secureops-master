import { Router, type IRouter } from "express";
import { eq, desc, asc, sql, and, or, ne, inArray } from "drizzle-orm";
import {
  db,
  chatRoomsTable,
  chatMessagesTable,
  chatRoomMembershipsTable,
  chatRoomReadsTable,
  usersTable,
  licensesTable,
  sitesTable,
  type ChatRoom,
} from "@workspace/db";
import { requireAuth, requireAdmin } from "../middlewares/auth";
import { broadcastToRoom } from "../lib/wsManager";
import { sendPushToUsers } from "../lib/push";

const router: IRouter = Router();

/**
 * Strictly parse a sorted "userIdA:userIdB" directKey.
 */
function parseDirectKey(directKey: string | null | undefined): readonly [string, string] | null {
  if (!directKey) return null;
  const parts = directKey.split(":");
  if (parts.length !== 2) return null;
  const [a, b] = parts;
  if (!a || !b) return null;
  return [a, b] as const;
}

function directKeyFor(a: string, b: string): string {
  return [a, b].sort().join(":");
}

/**
 * Resolve the set of user IDs allowed to read/post in a room. Single
 * source of truth for REST auth + WebSocket broadcast fan-out.
 *
 * Returns `null` to mean "every authenticated user" (announcements only).
 * Returns a Set otherwise. Admins are added to every non-direct set so
 * admin oversight is consistent (DMs stay strictly between participants).
 */
async function resolveRoomMembers(room: ChatRoom): Promise<Set<string> | null> {
  if (room.type === "direct") {
    const parts = parseDirectKey(room.directKey);
    return new Set(parts ?? []);
  }
  if (room.type === "announcements") {
    return null;
  }

  const admins = await db
    .select({ id: usersTable.id })
    .from(usersTable)
    .where(eq(usersTable.role, "admin"));
  const ids = new Set<string>(admins.map((a) => a.id));

  if (room.type === "ops") {
    return ids; // admins only
  }

  if (room.type === "license_level" && room.licenseLevel != null) {
    // Officers whose max unexpired license level meets the threshold.
    const today = new Date();
    const rows = await db
      .select({
        userId: licensesTable.employeeId,
        maxLevel: sql<number>`MAX(${licensesTable.level})::int`,
      })
      .from(licensesTable)
      .where(sql`${licensesTable.expiryDate} >= ${today}`)
      .groupBy(licensesTable.employeeId);
    for (const r of rows) {
      if ((r.maxLevel ?? 0) >= room.licenseLevel) ids.add(r.userId);
    }
    return ids;
  }

  if (room.type === "site" && room.siteId) {
    const [site] = await db.select().from(sitesTable).where(eq(sitesTable.id, room.siteId)).limit(1);
    if (!site) return ids;
    // Each shift has its own requiredLicenseLevel; for a site channel we
    // gate on the lowest shift level posted at that site (any officer who
    // could work any shift here should be in the channel). Fall back to 2
    // if the site has no shifts yet.
    const [{ minLevel }] = (await db.execute(sql`
      SELECT COALESCE(MIN(required_license_level), 2)::int AS "minLevel"
      FROM shifts WHERE site_id = ${room.siteId}
    `)).rows as { minLevel: number }[];
    const today = new Date();
    const rows = await db
      .select({
        userId: licensesTable.employeeId,
        maxLevel: sql<number>`MAX(${licensesTable.level})::int`,
      })
      .from(licensesTable)
      .where(sql`${licensesTable.expiryDate} >= ${today}`)
      .groupBy(licensesTable.employeeId);
    for (const r of rows) {
      if ((r.maxLevel ?? 0) >= (minLevel ?? 2)) ids.add(r.userId);
    }
    return ids;
  }

  if (room.type === "city" || room.type === "elite") {
    const explicit = await db
      .select({ userId: chatRoomMembershipsTable.userId })
      .from(chatRoomMembershipsTable)
      .where(and(
        eq(chatRoomMembershipsTable.roomId, room.id),
        inArray(chatRoomMembershipsTable.status, ["active", "invited"]),
      ));
    for (const r of explicit) ids.add(r.userId);
    return ids;
  }

  // Unknown / legacy types (e.g. old `shift` rooms) → admins only,
  // fail-closed so leftover data never leaks.
  return ids;
}

/**
 * Per-user "can this user read/post" view of resolveRoomMembers.
 * Admins always pass (except DMs).
 */
async function isAuthorizedForRoom(
  userId: string,
  userRole: string | undefined,
  room: ChatRoom,
): Promise<boolean> {
  if (room.type === "direct") {
    const parts = parseDirectKey(room.directKey);
    if (!parts) return false;
    return userId === parts[0] || userId === parts[1];
  }
  if (userRole === "admin" || userRole === "dispatcher") return true;
  const members = await resolveRoomMembers(room);
  if (members === null) return true;
  return members.has(userId);
}

// ============================================================ ROOM LISTING

// GET /chat/rooms — rooms the current user is in (or DMs they're part of)
router.get("/chat/rooms", requireAuth, async (req, res): Promise<void> => {
  const me = req.user!.userId;
  const myRole = req.user!.role;

  const candidates = await db
    .select()
    .from(chatRoomsTable)
    .where(or(
      ne(chatRoomsTable.type, "direct"),
      sql`${chatRoomsTable.directKey} LIKE ${"%" + me + "%"}`,
    ))
    .orderBy(asc(chatRoomsTable.createdAt));

  const authChecks = await Promise.all(
    candidates.map((room) => isAuthorizedForRoom(me, myRole, room)),
  );
  // Hide elite rooms entirely from non-members (invite-only ⇒ not even
  // visible). City rooms stay visible via the "discoverable" endpoint.
  const rooms = candidates.filter((room, i) => authChecks[i] && (room.type !== "elite" || authChecks[i]));

  const enriched = await Promise.all(
    rooms.map(async (room) => {
      const [lastMsg] = await db
        .select({
          content: chatMessagesTable.content,
          createdAt: chatMessagesTable.createdAt,
          userName: sql<string>`${usersTable.firstName} || ' ' || ${usersTable.lastName}`,
        })
        .from(chatMessagesTable)
        .leftJoin(usersTable, eq(chatMessagesTable.userId, usersTable.id))
        .where(eq(chatMessagesTable.roomId, room.id))
        .orderBy(desc(chatMessagesTable.createdAt))
        .limit(1);

      const [{ count }] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(chatMessagesTable)
        .where(eq(chatMessagesTable.roomId, room.id));

      let otherUserId: string | null = null;
      let otherUserName: string | null = null;
      if (room.type === "direct" && room.directKey) {
        const [a, b] = room.directKey.split(":");
        const otherId = a === me ? b : a;
        if (otherId) {
          otherUserId = otherId;
          const [u] = await db.select().from(usersTable).where(eq(usersTable.id, otherId)).limit(1);
          if (u) otherUserName = `${u.firstName} ${u.lastName}`;
        }
      }

      return { ...room, lastMessage: lastMsg || null, messageCount: count, otherUserId, otherUserName };
    })
  );

  res.json(enriched);
});

// GET /chat/rooms/discoverable — city/elite rooms the user can request to
// join (or has a pending request to). Returned alongside membership status
// so the mobile UI can render "Request to join" / "Request pending" badges.
router.get("/chat/rooms/discoverable", requireAuth, async (req, res): Promise<void> => {
  const me = req.user!.userId;

  // Only city rooms are discoverable to non-members. Elite is invite-only
  // and stays hidden until an admin issues an invite (which surfaces it
  // in GET /chat/rooms automatically).
  const cityRooms = await db
    .select()
    .from(chatRoomsTable)
    .where(eq(chatRoomsTable.type, "city"))
    .orderBy(asc(chatRoomsTable.name));

  if (cityRooms.length === 0) { res.json([]); return; }

  const memberships = await db
    .select()
    .from(chatRoomMembershipsTable)
    .where(and(
      eq(chatRoomMembershipsTable.userId, me),
      inArray(chatRoomMembershipsTable.roomId, cityRooms.map((r) => r.id)),
    ));
  const statusByRoom = new Map(memberships.map((m) => [m.roomId, m.status]));

  res.json(cityRooms.map((r) => ({
    ...r,
    membershipStatus: statusByRoom.get(r.id) ?? null, // null = not requested
  })));
});

// POST /chat/rooms/:id/join-request — request to join a city room
router.post("/chat/rooms/:id/join-request", requireAuth, async (req, res): Promise<void> => {
  const me = req.user!.userId;
  const id = req.params.id as string;
  const [room] = await db.select().from(chatRoomsTable).where(eq(chatRoomsTable.id, id)).limit(1);
  if (!room) { res.status(404).json({ error: "Not Found", message: "Room not found" }); return; }
  if (room.type !== "city") {
    res.status(400).json({ error: "Bad Request", message: "Only city rooms accept join requests" });
    return;
  }
  const [existing] = await db
    .select()
    .from(chatRoomMembershipsTable)
    .where(and(eq(chatRoomMembershipsTable.roomId, id), eq(chatRoomMembershipsTable.userId, me)))
    .limit(1);
  if (existing) {
    res.status(200).json(existing);
    return;
  }
  const [created] = await db
    .insert(chatRoomMembershipsTable)
    .values({ roomId: id, userId: me, status: "pending" })
    .returning();
  res.status(201).json(created);
});

// ============================================================ ADMIN: REQUESTS

// GET /admin/chat/membership-requests — pending join requests across all rooms
router.get("/admin/chat/membership-requests", requireAuth, requireAdmin, async (_req, res): Promise<void> => {
  const rows = await db
    .select({
      id: chatRoomMembershipsTable.id,
      roomId: chatRoomMembershipsTable.roomId,
      roomName: chatRoomsTable.name,
      roomType: chatRoomsTable.type,
      userId: chatRoomMembershipsTable.userId,
      userName: sql<string>`${usersTable.firstName} || ' ' || ${usersTable.lastName}`,
      userEmail: usersTable.email,
      status: chatRoomMembershipsTable.status,
      requestedAt: chatRoomMembershipsTable.requestedAt,
    })
    .from(chatRoomMembershipsTable)
    .innerJoin(chatRoomsTable, eq(chatRoomsTable.id, chatRoomMembershipsTable.roomId))
    .innerJoin(usersTable, eq(usersTable.id, chatRoomMembershipsTable.userId))
    .where(eq(chatRoomMembershipsTable.status, "pending"))
    .orderBy(desc(chatRoomMembershipsTable.requestedAt));
  res.json(rows);
});

// POST /admin/chat/membership-requests/:id/approve
router.post("/admin/chat/membership-requests/:id/approve", requireAuth, requireAdmin, async (req, res): Promise<void> => {
  const id = req.params.id as string;
  const [updated] = await db
    .update(chatRoomMembershipsTable)
    .set({ status: "active", decidedAt: new Date(), decidedBy: req.user!.userId })
    .where(eq(chatRoomMembershipsTable.id, id))
    .returning();
  if (!updated) { res.status(404).json({ error: "Not Found", message: "Request not found" }); return; }
  res.json(updated);
});

// POST /admin/chat/membership-requests/:id/deny
router.post("/admin/chat/membership-requests/:id/deny", requireAuth, requireAdmin, async (req, res): Promise<void> => {
  const id = req.params.id as string;
  const deleted = await db
    .delete(chatRoomMembershipsTable)
    .where(eq(chatRoomMembershipsTable.id, id))
    .returning();
  if (deleted.length === 0) { res.status(404).json({ error: "Not Found", message: "Request not found" }); return; }
  res.json({ ok: true });
});

// POST /admin/chat/rooms/:id/invite { userIds: [...] } — invite users to elite
router.post("/admin/chat/rooms/:id/invite", requireAuth, requireAdmin, async (req, res): Promise<void> => {
  const id = req.params.id as string;
  const { userIds } = req.body as { userIds: string[] };
  if (!Array.isArray(userIds) || userIds.length === 0) {
    res.status(400).json({ error: "Bad Request", message: "userIds[] required" });
    return;
  }
  const [room] = await db.select().from(chatRoomsTable).where(eq(chatRoomsTable.id, id)).limit(1);
  if (!room) { res.status(404).json({ error: "Not Found", message: "Room not found" }); return; }
  if (room.type !== "elite" && room.type !== "city") {
    res.status(400).json({ error: "Bad Request", message: "This room does not accept invites" });
    return;
  }
  const inserted: { id: string }[] = [];
  for (const userId of userIds) {
    const [row] = await db
      .insert(chatRoomMembershipsTable)
      .values({ roomId: id, userId, status: "active", decidedAt: new Date(), decidedBy: req.user!.userId })
      .onConflictDoUpdate({
        target: [chatRoomMembershipsTable.roomId, chatRoomMembershipsTable.userId],
        set: { status: "active", decidedAt: new Date(), decidedBy: req.user!.userId },
      })
      .returning({ id: chatRoomMembershipsTable.id });
    if (row) inserted.push(row);
  }
  res.json({ added: inserted.length });
});

// DELETE /admin/chat/rooms/:id/members/:userId — kick a user
router.delete("/admin/chat/rooms/:id/members/:userId", requireAuth, requireAdmin, async (req, res): Promise<void> => {
  const { id, userId } = req.params as { id: string; userId: string };
  await db
    .delete(chatRoomMembershipsTable)
    .where(and(eq(chatRoomMembershipsTable.roomId, id), eq(chatRoomMembershipsTable.userId, userId)));
  res.json({ ok: true });
});

// ============================================================ CHANNELS / DMs

// POST /chat/rooms — admin-created custom channel
router.post("/chat/rooms", requireAuth, requireAdmin, async (req, res): Promise<void> => {
  const { name, type } = req.body as { name: string; type?: string };
  if (!name) { res.status(400).json({ error: "Bad Request", message: "name required" }); return; }
  const [room] = await db.insert(chatRoomsTable).values({
    name,
    type: type || "announcements",
    joinPolicy: "auto",
  }).returning();
  res.status(201).json(room);
});

// GET /chat/users — DM picker
router.get("/chat/users", requireAuth, async (req, res): Promise<void> => {
  const me = req.user!.userId;
  const rows = await db
    .select({ id: usersTable.id, firstName: usersTable.firstName, lastName: usersTable.lastName, role: usersTable.role })
    .from(usersTable)
    .where(ne(usersTable.id, me))
    .orderBy(asc(usersTable.firstName));
  res.json(rows);
});

// POST /chat/direct — get or create a 1:1 DM
router.post("/chat/direct", requireAuth, async (req, res): Promise<void> => {
  const me = req.user!.userId;
  const { otherUserId } = req.body as { otherUserId: string };
  if (!otherUserId || otherUserId === me) {
    res.status(400).json({ error: "Bad Request", message: "otherUserId required" });
    return;
  }
  const [other] = await db.select().from(usersTable).where(eq(usersTable.id, otherUserId)).limit(1);
  if (!other) { res.status(404).json({ error: "Not Found", message: "User not found" }); return; }

  const key = directKeyFor(me, otherUserId);
  const [existing] = await db.select().from(chatRoomsTable).where(eq(chatRoomsTable.directKey, key)).limit(1);
  if (existing) { res.json(existing); return; }

  const [meUser] = await db.select().from(usersTable).where(eq(usersTable.id, me)).limit(1);
  const name = `${meUser?.firstName ?? "User"} & ${other.firstName}`;
  const [room] = await db.insert(chatRoomsTable).values({
    name, type: "direct", directKey: key,
  }).returning();
  res.status(201).json(room);
});

// ============================================================ UNREAD STATE

// GET /chat/unread-counts — per-room unread counts for the caller.
// Derived as messages newer than the caller's last-read watermark that were
// not sent by the caller. Each row carries the roomId plus, for direct rooms,
// the other participant's userId so the Personnel grid can map straight from
// an officer's userId to their badge without first resolving the DM room id.
// Rooms with zero unread simply don't appear (clients treat a missing entry
// as zero).
//
// By default only direct rooms are returned (the Personnel grid only cares
// about DMs). Pass `?scope=all` to also include every non-direct room the
// caller can access — used by the Chat sidebar, which badges every room. The
// `scope=all` path enforces the same per-room ACL as `/chat/rooms`.
router.get("/chat/unread-counts", requireAuth, async (req, res): Promise<void> => {
  const me = req.user!.userId;
  const myRole = req.user!.role;
  const scopeAll = req.query["scope"] === "all";

  // Restrict the aggregate to the room ids the caller may see. For the
  // direct-only default we lean on the cheap `direct_key LIKE` filter; for
  // `scope=all` we resolve the full accessible room set (same logic as
  // `/chat/rooms`) so non-direct ACLs (city/elite membership) are honored.
  let roomFilter = sql`r.type = 'direct' AND r.direct_key LIKE ${"%" + me + "%"}`;
  if (scopeAll) {
    const candidates = await db
      .select()
      .from(chatRoomsTable)
      .where(or(
        ne(chatRoomsTable.type, "direct"),
        sql`${chatRoomsTable.directKey} LIKE ${"%" + me + "%"}`,
      ));
    const authChecks = await Promise.all(
      candidates.map((room) => isAuthorizedForRoom(me, myRole, room)),
    );
    const accessibleIds = candidates.filter((_, i) => authChecks[i]).map((r) => r.id);
    if (accessibleIds.length === 0) { res.json([]); return; }
    roomFilter = sql`r.id IN (${sql.join(accessibleIds.map((id) => sql`${id}`), sql`, `)})`;
  }

  const result = await db.execute(sql`
    SELECT r.id AS "roomId",
           r.direct_key AS "directKey",
           COUNT(m.id)::int AS "unreadCount"
    FROM chat_rooms r
    LEFT JOIN chat_room_reads rd
      ON rd.room_id = r.id AND rd.user_id = ${me}
    LEFT JOIN chat_messages m
      ON m.room_id = r.id
      AND m.user_id <> ${me}
      AND m.created_at > COALESCE(rd.last_read_at, '1970-01-01'::timestamptz)
    WHERE ${roomFilter}
    GROUP BY r.id, r.direct_key
    HAVING COUNT(m.id) > 0
  `);
  const counts = (result.rows as { roomId: string; directKey: string | null; unreadCount: number }[]).map((row) => {
    let otherUserId = "";
    if (row.directKey) {
      const parts = row.directKey.split(":");
      otherUserId = (parts[0] === me ? parts[1] : parts[0]) ?? "";
    }
    return { roomId: row.roomId, otherUserId, unreadCount: row.unreadCount };
  });
  res.json(counts);
});

// POST /chat/rooms/:id/read — bump the caller's last-read watermark to now.
// Idempotent upsert keyed on (room, user). Enforces the same room ACL as
// reading messages so a caller can't mark rooms they can't access.
router.post("/chat/rooms/:id/read", requireAuth, async (req, res): Promise<void> => {
  const id = req.params.id as string;
  const me = req.user!.userId;
  const [room] = await db.select().from(chatRoomsTable).where(eq(chatRoomsTable.id, id)).limit(1);
  if (!room) { res.status(404).json({ error: "Not Found", message: "Room not found" }); return; }
  if (!(await isAuthorizedForRoom(me, req.user!.role, room))) {
    res.status(403).json({ error: "Forbidden", message: "You are not a member of this room" });
    return;
  }
  const now = new Date();
  await db
    .insert(chatRoomReadsTable)
    .values({ roomId: id, userId: me, lastReadAt: now })
    .onConflictDoUpdate({
      target: [chatRoomReadsTable.roomId, chatRoomReadsTable.userId],
      set: { lastReadAt: now },
    });
  res.json({ ok: true });
});

// ============================================================ MESSAGES

// GET /chat/rooms/:id/messages
router.get("/chat/rooms/:id/messages", requireAuth, async (req, res): Promise<void> => {
  const id = req.params.id as string;
  const limit = parseInt(req.query["limit"] as string || "50", 10);
  const before = req.query["before"] as string | undefined;

  const [room] = await db.select().from(chatRoomsTable).where(eq(chatRoomsTable.id, id)).limit(1);
  if (!room) { res.status(404).json({ error: "Not Found", message: "Room not found" }); return; }
  if (!(await isAuthorizedForRoom(req.user!.userId, req.user!.role, room))) {
    res.status(403).json({ error: "Forbidden", message: "You are not a member of this room" });
    return;
  }

  const conditions = [eq(chatMessagesTable.roomId, id)];
  if (before) conditions.push(sql`${chatMessagesTable.createdAt} < ${new Date(before)}`);

  const messages = await db
    .select({
      id: chatMessagesTable.id,
      roomId: chatMessagesTable.roomId,
      userId: chatMessagesTable.userId,
      content: chatMessagesTable.content,
      createdAt: chatMessagesTable.createdAt,
      userName: sql<string>`${usersTable.firstName} || ' ' || ${usersTable.lastName}`,
      userRole: usersTable.role,
    })
    .from(chatMessagesTable)
    .leftJoin(usersTable, eq(chatMessagesTable.userId, usersTable.id))
    .where(and(...conditions))
    .orderBy(desc(chatMessagesTable.createdAt))
    .limit(limit);

  res.json(messages.reverse());
});

// POST /chat/rooms/:id/messages
router.post("/chat/rooms/:id/messages", requireAuth, async (req, res): Promise<void> => {
  const id = req.params.id as string;
  const { content } = req.body as { content: string };
  if (!content?.trim()) { res.status(400).json({ error: "Bad Request", message: "content required" }); return; }

  const [room] = await db.select().from(chatRoomsTable).where(eq(chatRoomsTable.id, id)).limit(1);
  if (!room) { res.status(404).json({ error: "Not Found", message: "Room not found" }); return; }
  if (!(await isAuthorizedForRoom(req.user!.userId, req.user!.role, room))) {
    res.status(403).json({ error: "Forbidden", message: "You are not a member of this room" });
    return;
  }

  // Announcements channel: only admins + dispatchers post; everyone reads.
  // Dispatchers run the broadcast composer on the unified Dispatch screen.
  if (room.type === "announcements" && req.user!.role !== "admin" && req.user!.role !== "dispatcher") {
    res.status(403).json({ error: "Forbidden", message: "Only admins or dispatchers can post in announcements" });
    return;
  }

  const [message] = await db.insert(chatMessagesTable).values({
    roomId: id,
    userId: req.user!.userId,
    content: content.trim(),
  }).returning();

  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, req.user!.userId)).limit(1);

  const broadcastPayload = {
    type: "chat_message",
    message: {
      ...message,
      userName: user ? `${user.firstName} ${user.lastName}` : "Unknown",
      userRole: user?.role,
    },
  };

  const members = await resolveRoomMembers(room);
  broadcastToRoom(id, broadcastPayload, members === null ? {} : { allowedUserIds: members });

  // Push notification to members who are not currently connected via WS.
  // Skip announcements (members=null means broadcast to all — too broad for push).
  if (members !== null && members.size > 0) {
    const { getConnectedUserIds } = await import("../lib/wsManager");
    const connectedIds = getConnectedUserIds();
    const pushRecipients = Array.from(members).filter(
      (uid) => uid !== req.user!.userId && !connectedIds.has(uid),
    );
    if (pushRecipients.length > 0) {
      const senderName = user ? `${user.firstName} ${user.lastName}` : "Someone";
      const isDirect = room.type === "direct";
      const preview = content.trim().slice(0, 100);
      void sendPushToUsers(pushRecipients, {
        title: isDirect ? senderName : `#${room.name}`,
        body: isDirect ? preview : `${senderName}: ${preview}`,
        data: { roomId: id, type: "chat_message" },
      });
    }
  }

  res.status(201).json(broadcastPayload.message);
});

// DELETE /chat/messages/:id — admins delete anything; users delete only
// their own messages. Broadcasts a `chat_message_deleted` event to every
// authorized member so each open chat view can drop the bubble in real time.
router.delete("/chat/messages/:id", requireAuth, async (req, res): Promise<void> => {
  const id = req.params.id as string;
  const [message] = await db
    .select()
    .from(chatMessagesTable)
    .where(eq(chatMessagesTable.id, id))
    .limit(1);
  if (!message) {
    res.status(404).json({ error: "Not Found", message: "Message not found" });
    return;
  }

  const isOwner = message.userId === req.user!.userId;
  const isAdmin = req.user!.role === "admin";
  if (!isOwner && !isAdmin) {
    res.status(403).json({ error: "Forbidden", message: "You can only delete your own messages" });
    return;
  }

  const [room] = await db
    .select()
    .from(chatRoomsTable)
    .where(eq(chatRoomsTable.id, message.roomId))
    .limit(1);

  await db.delete(chatMessagesTable).where(eq(chatMessagesTable.id, id));

  if (room) {
    const members = await resolveRoomMembers(room);
    broadcastToRoom(
      room.id,
      { type: "chat_message_deleted", messageId: id, roomId: room.id },
      members === null ? {} : { allowedUserIds: members },
    );
  }

  res.json({ ok: true, id });
});

export default router;
