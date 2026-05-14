import { Router, type IRouter } from "express";
import { eq, desc, asc, sql, and } from "drizzle-orm";
import { db, chatRoomsTable, chatMessagesTable, usersTable } from "@workspace/db";
import { requireAuth } from "../middlewares/auth";
import { broadcastToRoom } from "../lib/wsManager";

const router: IRouter = Router();

// Ensure General room exists on first call
let generalRoomEnsured = false;
async function ensureGeneralRoom() {
  if (generalRoomEnsured) return;
  const [existing] = await db.select().from(chatRoomsTable).where(eq(chatRoomsTable.type, "general")).limit(1);
  if (!existing) {
    await db.insert(chatRoomsTable).values({ name: "General", type: "general" }).onConflictDoNothing();
  }
  generalRoomEnsured = true;
}

// GET /chat/rooms — list all chat rooms
router.get("/chat/rooms", requireAuth, async (req, res): Promise<void> => {
  await ensureGeneralRoom();
  const rooms = await db.select().from(chatRoomsTable).orderBy(asc(chatRoomsTable.createdAt));

  // Get last message and unread count for each room
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

      return { ...room, lastMessage: lastMsg || null, messageCount: count };
    })
  );

  res.json(enriched);
});

// POST /chat/rooms — create a new room (admin only for shift rooms)
router.post("/chat/rooms", requireAuth, async (req, res): Promise<void> => {
  const { name, type, shiftId } = req.body as { name: string; type?: string; shiftId?: string };
  if (!name) { res.status(400).json({ error: "Bad Request", message: "name required" }); return; }
  const [room] = await db.insert(chatRoomsTable).values({ name, type: type || "general", shiftId }).returning();
  res.status(201).json(room);
});

// GET /chat/rooms/:id/messages — get messages for a room
router.get("/chat/rooms/:id/messages", requireAuth, async (req, res): Promise<void> => {
  const id = req.params.id as string;
  const limit = parseInt(req.query["limit"] as string || "50", 10);
  const before = req.query["before"] as string | undefined;

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

// POST /chat/rooms/:id/messages — send a message
router.post("/chat/rooms/:id/messages", requireAuth, async (req, res): Promise<void> => {
  const id = req.params.id as string;
  const { content } = req.body as { content: string };
  if (!content?.trim()) { res.status(400).json({ error: "Bad Request", message: "content required" }); return; }

  const [room] = await db.select().from(chatRoomsTable).where(eq(chatRoomsTable.id, id)).limit(1);
  if (!room) { res.status(404).json({ error: "Not Found", message: "Room not found" }); return; }

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

  broadcastToRoom(id, broadcastPayload);
  res.status(201).json(broadcastPayload.message);
});

export default router;
