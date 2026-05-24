import { Router, type IRouter } from "express";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db, notificationsTable } from "@workspace/db";
import { requireAuth } from "../middlewares/auth";

const router: IRouter = Router();

/**
 * GET /me/notifications
 *
 * Returns the caller's in-app notification history (most recent first,
 * capped at 200 rows). Every push the server sends via `sendPushToUsers`
 * also writes a row here, so officers can review what they were notified
 * about even after dismissing the OS-level push.
 */
router.get("/me/notifications", requireAuth, async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  const rows = await db
    .select()
    .from(notificationsTable)
    .where(eq(notificationsTable.userId, userId))
    .orderBy(desc(notificationsTable.createdAt))
    .limit(200);

  const [{ count: unread }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(notificationsTable)
    .where(and(eq(notificationsTable.userId, userId), isNull(notificationsTable.readAt)));

  res.json({ notifications: rows, unreadCount: unread });
});

/**
 * GET /me/notifications/unread-count
 *
 * Cheap polling endpoint for the home-screen badge.
 */
router.get("/me/notifications/unread-count", requireAuth, async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(notificationsTable)
    .where(and(eq(notificationsTable.userId, userId), isNull(notificationsTable.readAt)));
  res.json({ unreadCount: count });
});

/**
 * POST /me/notifications/mark-read
 *
 * Body: `{ ids?: string[] }`. When `ids` is provided, marks just those
 * notifications (scoped to the caller). When omitted, marks every
 * unread notification for the caller as read.
 */
router.post("/me/notifications/mark-read", requireAuth, async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  const ids = Array.isArray(req.body?.ids) ? (req.body.ids as unknown[]).filter((v): v is string => typeof v === "string") : null;

  if (ids && ids.length === 0) {
    res.json({ updated: 0 });
    return;
  }

  const result = await db
    .update(notificationsTable)
    .set({ readAt: new Date() })
    .where(
      and(
        eq(notificationsTable.userId, userId),
        isNull(notificationsTable.readAt),
        ids ? inArray(notificationsTable.id, ids) : sql`true`,
      ),
    )
    .returning({ id: notificationsTable.id });

  res.json({ updated: result.length });
});

/**
 * DELETE /me/notifications
 *
 * Body: `{ ids?: string[] }`. When omitted, clears the caller's entire
 * notification history. Scoped to the caller.
 */
router.delete("/me/notifications", requireAuth, async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  const ids = Array.isArray(req.body?.ids) ? (req.body.ids as unknown[]).filter((v): v is string => typeof v === "string") : null;

  if (ids && ids.length === 0) {
    res.json({ deleted: 0 });
    return;
  }

  const result = await db
    .delete(notificationsTable)
    .where(
      and(
        eq(notificationsTable.userId, userId),
        ids ? inArray(notificationsTable.id, ids) : sql`true`,
      ),
    )
    .returning({ id: notificationsTable.id });

  res.json({ deleted: result.length });
});

export default router;
