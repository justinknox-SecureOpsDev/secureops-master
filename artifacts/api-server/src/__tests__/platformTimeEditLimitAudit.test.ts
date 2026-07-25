/**
 * Audit-trail test for the officer time-edit limit.
 *
 * The time-edit limit (platform_customer_config.time_confirm_edit_window_hours)
 * is a payroll-affecting control — it caps how far officers can adjust their
 * own recorded hours. Changing it must leave a clear old→new paper trail in the
 * audit log so reviewers can see who loosened or tightened officer self-edits.
 *
 * PUT /admin/platform/customer-config is recorded by the global
 * auditLogMiddleware as `admin.action`; this test asserts the handler stashes
 * the specific before/after values on audit_logs.metadata when (and only when)
 * the limit actually changes.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { and, eq, gt, sql } from "drizzle-orm";
import { db, usersTable, auditLogsTable, platformCustomerConfigTable } from "@workspace/db";
import app from "../app";
import { signToken } from "../middlewares/auth";
import { brand } from "../lib/brandConfig";

const TAG = `time-edit-audit-${randomUUID().slice(0, 8)}`;

// requireSuperAdmin (routes/platform.ts) reads SUPER_ADMIN_EMAILS at module
// load, falling back to the seeded brand-admin email. Resolve the SAME set
// here so our test token is admitted by the live gate.
const superEmail = (process.env["SUPER_ADMIN_EMAILS"] ?? brand.demoAdminEmail)
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean)[0]!;

let superId = "";
let superToken = "";
let createdUser = false;
let startedAt: Date;

async function latestCustomerConfigAudit(): Promise<typeof auditLogsTable.$inferSelect | undefined> {
  const rows = await db
    .select()
    .from(auditLogsTable)
    .where(
      and(
        eq(auditLogsTable.actorUserId, superId),
        eq(auditLogsTable.path, "/admin/platform/customer-config"),
        gt(auditLogsTable.createdAt, startedAt),
      ),
    );
  return rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
}

async function waitForAuditRow(): Promise<typeof auditLogsTable.$inferSelect> {
  // The middleware persists on res.on("finish") — fire-and-forget, so poll.
  for (let i = 0; i < 40; i++) {
    const row = await latestCustomerConfigAudit();
    if (row) return row;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("audit row for customer-config PUT never appeared");
}

async function putConfig(body: Record<string, unknown>) {
  return request(app)
    .put("/api/admin/platform/customer-config")
    .set({ Authorization: `Bearer ${superToken}` })
    .send(body);
}

const BASE_BODY = {
  customerName: TAG,
  planTier: null,
  monthlyPriceCents: null,
  officerCount: null,
  billingNotes: null,
  planStartDate: null,
  processingFeeEnabled: null,
  processingFeeRate: null,
};

beforeAll(async () => {
  // Reuse the configured super-admin user if it exists; otherwise create one.
  const [existing] = await db
    .select({ id: usersTable.id })
    .from(usersTable)
    .where(eq(usersTable.email, superEmail))
    .limit(1);
  if (existing) {
    superId = existing.id;
  } else {
    const [row] = await db
      .insert(usersTable)
      .values({
        email: superEmail,
        passwordHash: bcrypt.hashSync("test-password", 4),
        firstName: "Super",
        lastName: TAG,
        role: "admin",
        status: "active",
        tokensValidAfter: new Date(0),
      })
      .returning({ id: usersTable.id });
    superId = row.id;
    createdUser = true;
  }
  superToken = signToken({ userId: superId, email: superEmail, role: "admin" });

  // Reset the singleton to a known starting point.
  await db
    .insert(platformCustomerConfigTable)
    .values({ id: "singleton", timeConfirmEditWindowHours: "2" })
    .onConflictDoUpdate({
      target: platformCustomerConfigTable.id,
      set: { timeConfirmEditWindowHours: "2" },
    });

  startedAt = new Date();
});

afterAll(async () => {
  await db.execute(sql`DELETE FROM audit_logs WHERE actor_user_id = ${superId} AND created_at > ${startedAt}`);
  if (createdUser) {
    await db.execute(sql`DELETE FROM users WHERE id = ${superId}`);
  }
});

describe("time-edit limit change audit trail", () => {
  it("records old and new values when the limit changes", async () => {
    const res = await putConfig({ ...BASE_BODY, timeConfirmEditWindowHours: "4" });
    expect(res.status).toBe(200);
    expect(res.body?.config?.timeConfirmEditWindowHours).toBe("4");

    const audit = await waitForAuditRow();
    expect(audit.action).toBe("admin.action");
    expect(audit.actorEmail).toBe(superEmail);
    const meta = audit.metadata as Record<string, unknown> | null;
    expect(meta).toBeTruthy();
    expect(meta?.["settingsChange"]).toBe("customer_config");
    const changes = meta?.["changes"] as Array<Record<string, unknown>>;
    const limitChange = changes.find((c) => c["field"] === "timeConfirmEditWindowHours");
    expect(limitChange).toBeTruthy();
    expect(limitChange?.["old"]).toBe("2");
    expect(limitChange?.["new"]).toBe("4");
  });

  it("does not attach the change metadata when the limit is unchanged", async () => {
    // Set to a known value first.
    await putConfig({ ...BASE_BODY, timeConfirmEditWindowHours: "6" });
    startedAt = new Date();

    // Re-save the SAME value — no change to the limit.
    const res = await putConfig({ ...BASE_BODY, timeConfirmEditWindowHours: "6" });
    expect(res.status).toBe(200);

    const audit = await waitForAuditRow();
    const meta = audit.metadata as Record<string, unknown> | null;
    // Either no metadata, or a generic settings-change payload that contains no
    // timeConfirmEditWindowHours entry (the limit did not change).
    const changes = (meta?.["changes"] as Array<Record<string, unknown>> | undefined) ?? [];
    expect(changes.some((c) => c["field"] === "timeConfirmEditWindowHours")).toBe(false);
  });
});
