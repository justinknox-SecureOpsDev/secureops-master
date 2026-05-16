import { Router, type IRouter } from "express";
import { and, desc, eq, gte, lte, sql } from "drizzle-orm";
import { db, auditLogsTable } from "@workspace/db";
import { requireAdmin } from "../middlewares/auth";

const router: IRouter = Router();

/**
 * GET /admin/audit-logs
 *
 * Admin-only. Filterable, paginated view of the audit log:
 *   - `action`         exact match (e.g. "payroll.export_csv")
 *   - `actorUserId`    exact match
 *   - `targetTable`    exact match
 *   - `targetId`       exact match
 *   - `from` / `to`    ISO timestamps
 *   - `limit` (≤200, default 100), `offset` (default 0)
 *
 * Returns `{ rows, total }` so the admin grid can paginate. Sorted by
 * `created_at desc` — most recent first.
 */
router.get("/admin/audit-logs", requireAdmin, async (req, res): Promise<void> => {
  const q = req.query as Record<string, string | undefined>;
  const limit = Math.min(200, Math.max(1, parseInt(q.limit || "100", 10) || 100));
  const offset = Math.max(0, parseInt(q.offset || "0", 10) || 0);

  const conditions = [];
  if (q.action) conditions.push(eq(auditLogsTable.action, q.action));
  if (q.actorUserId) conditions.push(eq(auditLogsTable.actorUserId, q.actorUserId));
  if (q.targetTable) conditions.push(eq(auditLogsTable.targetTable, q.targetTable));
  if (q.targetId) conditions.push(eq(auditLogsTable.targetId, q.targetId));
  if (q.from) {
    const d = new Date(q.from);
    if (!Number.isNaN(d.getTime())) conditions.push(gte(auditLogsTable.createdAt, d));
  }
  if (q.to) {
    const d = new Date(q.to);
    if (!Number.isNaN(d.getTime())) conditions.push(lte(auditLogsTable.createdAt, d));
  }
  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(auditLogsTable)
    .where(where as never);

  const rows = await db
    .select()
    .from(auditLogsTable)
    .where(where as never)
    .orderBy(desc(auditLogsTable.createdAt))
    .limit(limit)
    .offset(offset);

  res.json({ rows, total: count, limit, offset });
});

export default router;
