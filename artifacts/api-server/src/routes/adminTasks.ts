import { Router, type IRouter } from "express";
import { eq, sql } from "drizzle-orm";
import { db, adminTasksTable, usersTable } from "@workspace/db";
import { CreateAdminTaskBody, UpdateAdminTaskBody } from "@workspace/api-zod";
import { requireAdmin } from "../middlewares/auth";

const router: IRouter = Router();

// Shared team-wide admin to-do / reminder list (dashboard panel). Every admin
// sees every task; createdBy is attribution, not ownership — any admin may
// edit, complete, or delete any task. Writes land in the audit log via the
// privileged-path middleware like all /admin/* mutations.

type TaskRow = {
  id: string;
  title: string;
  notes: string | null;
  dueAt: Date | null;
  completedAt: Date | null;
  createdBy: string;
  createdByName: string | null;
  createdAt: Date;
};

function toDto(r: TaskRow) {
  return {
    id: r.id,
    title: r.title,
    notes: r.notes,
    dueAt: r.dueAt ? r.dueAt.toISOString() : null,
    completedAt: r.completedAt ? r.completedAt.toISOString() : null,
    createdBy: r.createdBy,
    createdByName: r.createdByName,
    createdAt: r.createdAt.toISOString(),
  };
}

const creatorName = sql<string | null>`NULLIF(TRIM(CONCAT(${usersTable.firstName}, ' ', ${usersTable.lastName})), '')`;

const baseSelect = {
  id: adminTasksTable.id,
  title: adminTasksTable.title,
  notes: adminTasksTable.notes,
  dueAt: adminTasksTable.dueAt,
  completedAt: adminTasksTable.completedAt,
  createdBy: adminTasksTable.createdBy,
  createdByName: creatorName,
  createdAt: adminTasksTable.createdAt,
};

async function fetchTask(id: string): Promise<TaskRow | undefined> {
  const [row] = await db
    .select(baseSelect)
    .from(adminTasksTable)
    .leftJoin(usersTable, eq(usersTable.id, adminTasksTable.createdBy))
    .where(eq(adminTasksTable.id, id))
    .limit(1);
  return row;
}

router.get("/admin/tasks", requireAdmin, async (req, res): Promise<void> => {
  // NOTE: generated zod uses coerce.boolean(), which turns the string "false"
  // into true — parse the flag by hand instead.
  const includeCompleted = req.query.includeCompleted !== "false";

  const rows = await db
    .select(baseSelect)
    .from(adminTasksTable)
    .leftJoin(usersTable, eq(usersTable.id, adminTasksTable.createdBy))
    .where(includeCompleted ? undefined : sql`${adminTasksTable.completedAt} IS NULL`)
    .orderBy(
      // Open tasks first…
      sql`(${adminTasksTable.completedAt} IS NOT NULL)`,
      // …by due date (undated last); completed rows all NULL here so they tie…
      sql`CASE WHEN ${adminTasksTable.completedAt} IS NULL THEN ${adminTasksTable.dueAt} END ASC NULLS LAST`,
      // …and completed rows sort newest-finished first.
      sql`${adminTasksTable.completedAt} DESC NULLS LAST`,
      sql`${adminTasksTable.createdAt} DESC`,
    );
  res.json(rows.map(toDto));
});

router.post("/admin/tasks", requireAdmin, async (req, res): Promise<void> => {
  const parsed = CreateAdminTaskBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Bad Request", message: parsed.error.message });
    return;
  }
  const d = parsed.data;
  const [inserted] = await db
    .insert(adminTasksTable)
    .values({
      title: d.title.trim(),
      notes: d.notes ?? null,
      dueAt: d.dueAt ?? null,
      createdBy: req.user!.userId,
    })
    .returning({ id: adminTasksTable.id });
  const row = await fetchTask(inserted!.id);
  res.status(201).json(toDto(row!));
});

router.patch("/admin/tasks/:id", requireAdmin, async (req, res): Promise<void> => {
  const id = String(req.params.id);
  const parsed = UpdateAdminTaskBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Bad Request", message: parsed.error.message });
    return;
  }
  const existing = await fetchTask(id);
  if (!existing) {
    res.status(404).json({ error: "Not Found", message: "Task not found" });
    return;
  }

  const d = parsed.data;
  const patch: Partial<typeof adminTasksTable.$inferInsert> = {};
  if (d.title !== undefined) patch.title = d.title.trim();
  if (d.notes !== undefined) patch.notes = d.notes; // null clears
  if (d.dueAt !== undefined) patch.dueAt = d.dueAt; // null clears
  if (d.completed !== undefined) {
    // Re-completing an already-completed task keeps the original timestamp.
    patch.completedAt = d.completed ? (existing.completedAt ?? new Date()) : null;
  }

  if (Object.keys(patch).length > 0) {
    await db.update(adminTasksTable).set(patch).where(eq(adminTasksTable.id, id));
  }
  const row = await fetchTask(id);
  res.json(toDto(row!));
});

router.delete("/admin/tasks/:id", requireAdmin, async (req, res): Promise<void> => {
  const [deleted] = await db
    .delete(adminTasksTable)
    .where(eq(adminTasksTable.id, String(req.params.id)))
    .returning({ id: adminTasksTable.id });
  if (!deleted) {
    res.status(404).json({ error: "Not Found", message: "Task not found" });
    return;
  }
  res.status(204).end();
});

export default router;
