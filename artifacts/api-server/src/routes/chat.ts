import { Router, type IRouter } from "express";
import { eq, desc, asc, sql, and, or, ne } from "drizzle-orm";
import { db, chatRoomsTable, chatMessagesTable, usersTable, shiftAssignmentsTable, type ChatRoom } from "@workspace/db";
import { requireAuth } from "../middlewares/auth";
import { broadcastToRoom } from "../lib/wsManager";

const router: IRouter = Router();

/**
 * Strictly parse a sorted "userIdA:userIdB" directKey. Returns the two
 * participant IDs only when the key contains exactly two non-empty
 * segments; otherwise returns null so callers fail closed on malformed
 * data (e.g. legacy rows or manual DB edits).
 */
function parseDirectKey(directKey: string | null | undefined): readonly [string, string] | null {
  if (!directKey) return null;
  const parts = directKey.split(":");
  if (parts.length !== 2) return null;
  const [a, b] = parts;
  if (!a || !b) return null;
  return [a, b] as const;
}

/**
 * Resolve the set of user IDs allowed to read/post in a room. Used as the
 * single source of truth for both REST authorization and WebSocket
 * broadcast fan-out so the two paths can never drift.
 *
 *   - `direct`: only the two participants encoded in `directKey`.
 *   - `shift`: every admin + every officer with a `shift_assignments` row
 *              for that shift (regardless of assignment status).
 *   - `general`: every authenticated user (returns `null` to signal
 *                "no allow-list, broadcast to all sockets").
 *   - any other / unknown type: empty Set (fail-closed).
 *
 * Returning `null` means "public — every authenticated user". Returning
 * a Set means "restricted — only these user IDs".
 */
async function resolveRoomMembers(room: ChatRoom): Promise<Set<string> | null> {
  if (room.type === "direct") {
    const participants = parseDirectKey(room.directKey);
    return new Set(participants ?? []);
  }
  if (room.type === "general") {
    return null;
  }
  if (room.type === "shift") {
    if (!room.shiftId) return new Set<string>();
    const [admins, assignees] = await Promise.all([
      db.select({ id: usersTable.id }).from(usersTable).where(eq(usersTable.role, "admin")),
      db
        .select({ id: shiftAssignmentsTable.employeeId })
        .from(shiftAssignmentsTable)
        .where(eq(shiftAssignmentsTable.shiftId, room.shiftId)),
    ]);
    const ids = new Set<string>();
    for (const a of admins) ids.add(a.id);
    for (const a of assignees) ids.add(a.id);
    return ids;
  }
  return new Set<string>();
}

/**
 * REST authorization check. Admins are always allowed in non-direct rooms
 * (operational override — admins manage every room and need read access
 * to investigate incidents). Direct rooms still strictly require
 * participant identity, even for admins, since DMs are private.
 */
async function isAuthorizedForRoom(
  userId: string,
  userRole: string | undefined,
  room: ChatRoom,
): Promise<boolean> {
  if (room.type === "direct") {
    const participants = parseDirectKey(room.directKey);
    if (!participants) return false;
    return userId === participants[0] || userId === participants[1];
  }
  if (userRole === "admin") return true;
  const members = await resolveRoomMembers(room);
  if (members === null) return true;
  return members.has(userId);
}

let generalRoomEnsured = false;
async function ensureGeneralRoom() {
  if (generalRoomEnsured) return;
  const [existing] = await db.select().from(chatRoomsTable).where(eq(chatRoomsTable.type, "general")).limit(1);
  if (!existing) {
    await db.insert(chatRoomsTable).values({ name: "General", type: "general" }).onConflictDoNothing();
  }
  generalRoomEnsured = true;
}

function directKeyFor(a: string, b: string): string {
  return [a, b].sort().join(":");
}

// GET /chat/rooms — channels + DMs the current user participates in
router.get("/chat/rooms", requireAuth, async (req, res): Promise<void> => {
  await ensureGeneralRoom();
  const me = req.user!.userId;

  const rooms = await db
    .select()
    .from(chatRoomsTable)
    .where(or(
      ne(chatRoomsTable.type, "direct"),
      sql`${chatRoomsTable.directKey} LIKE ${"%" + me + "%"}`,
    ))
    .orderBy(asc(chatRoomsTable.createdAt));

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

// POST /chat/rooms — create a channel
router.post("/chat/rooms", requireAuth, async (req, res): Promise<void> => {
  const { name, type, shiftId } = req.body as { name: string; type?: string; shiftId?: string };
  if (!name) { res.status(400).json({ error: "Bad Request", message: "name required" }); return; }
  const [room] = await db.insert(chatRoomsTable).values({ name, type: type || "general", shiftId }).returning();
  res.status(201).json(room);
});

// GET /chat/users — list other users for DM picker
router.get("/chat/users", requireAuth, async (req, res): Promise<void> => {
  const me = req.user!.userId;
  const rows = await db
    .select({ id: usersTable.id, firstName: usersTable.firstName, lastName: usersTable.lastName, role: usersTable.role })
    .from(usersTable)
    .where(ne(usersTable.id, me))
    .orderBy(asc(usersTable.firstName));
  res.json(rows);
});

// POST /chat/direct — get or create a 1:1 DM room
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

// GET /chat/rooms/:id/messages
router.get("/chat/rooms/:id/messages", requireAuth, async (req, res): Promise<void> => {
  const id = req.params.id as string;
  const limit = parseInt(req.query["limit"] as string || "50", 10);
  const before = req.query["before"] as string | undefined;

  // Membership check — load the room first so we can enforce authorization
  // before returning any history. Avoids leaking DM contents to non-members.
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

  // Restrict the live broadcast to the room's authorized recipients
  // (DMs → the two participants, shift rooms → admins + assigned officers,
  // general → all authenticated sockets). Same resolver as the REST
  // membership check, so the two paths can never drift.
  const members = await resolveRoomMembers(room);
  broadcastToRoom(id, broadcastPayload, members === null ? {} : { allowedUserIds: members });
  res.status(201).json(broadcastPayload.message);
});

export default router;
