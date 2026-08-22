import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { sql, eq, and, desc, isNull } from "drizzle-orm";
import {
  db,
  usersTable,
  clientsTable,
  sitesTable,
  shiftsTable,
  timeEntriesTable,
  invoicesTable,
  auditLogsTable,
} from "@workspace/db";
import app from "../app";
import { signToken } from "../middlewares/auth";
import { weekStartIsoBusiness } from "../lib/invoiceSync";

const TAG = `teclockout-test-${randomUUID().slice(0, 8)}`;
const passwordHash = bcrypt.hashSync("test-password", 4);

type Ctx = {
  adminId: string;
  employeeId: string;
  officerId: string;
  adminToken: string;
  employeeToken: string;
  clientId: string;
  siteId: string;
  shiftId: string;
};
const ctx = {} as Ctx;

async function makeUser(role: "admin" | "employee", suffix: string): Promise<string> {
  const [row] = await db
    .insert(usersTable)
    .values({
      email: `${TAG}-${suffix}@example.test`,
      passwordHash,
      firstName: role === "admin" ? "Admin" : "Officer",
      lastName: TAG,
      role,
      status: "active",
      tokensValidAfter: new Date(0),
    })
    .returning({ id: usersTable.id });
  return row.id;
}

// A fixed clock-in instant well inside a single ISO week so invoice
// (siteId, weekStart) keying is stable. Far in the past so the row never
// collides with real/seed data.
const BASE_CLOCK_IN = new Date("2025-03-04T14:00:00.000Z"); // a Tuesday

// Insert an OPEN time entry (no clock-out) — the precondition for the
// "fill a missing clock-out" route. hoursWorked starts null because the
// entry was never clocked out.
async function insertOpenEntry(opts?: {
  shiftId?: string | null;
  clockIn?: Date;
  approvalStatus?: "pending" | "approved" | "rejected";
  employeeId?: string;
}): Promise<string> {
  const employeeId = opts?.employeeId ?? ctx.officerId;
  // An officer may only ever have ONE open entry (partial unique index on
  // time_entries), so clear any leftover open row from a previous case before
  // seeding this one.
  await db
    .delete(timeEntriesTable)
    .where(and(eq(timeEntriesTable.employeeId, employeeId), isNull(timeEntriesTable.clockOutTime)));
  const [row] = await db
    .insert(timeEntriesTable)
    .values({
      shiftId: opts?.shiftId === undefined ? ctx.shiftId : opts.shiftId,
      siteId: ctx.siteId,
      employeeId,
      clockInTime: opts?.clockIn ?? BASE_CLOCK_IN,
      clockOutTime: null,
      hoursWorked: null,
      approvalStatus: opts?.approvalStatus ?? "pending",
    })
    .returning({ id: timeEntriesTable.id });
  return row.id;
}

// Insert an already-closed entry (used to prove the 409 guard).
async function insertClosedEntry(): Promise<string> {
  const [row] = await db
    .insert(timeEntriesTable)
    .values({
      shiftId: ctx.shiftId,
      siteId: ctx.siteId,
      employeeId: ctx.officerId,
      clockInTime: BASE_CLOCK_IN,
      clockOutTime: new Date(BASE_CLOCK_IN.getTime() + 4 * 3600_000),
      hoursWorked: "4.00",
      approvalStatus: "pending",
    })
    .returning({ id: timeEntriesTable.id });
  return row.id;
}

// Create a fresh shift so completion-flip tests don't fight over shared state.
async function makeShift(status: string, endOffsetHours = 4): Promise<string> {
  const [shift] = await db
    .insert(shiftsTable)
    .values({
      siteId: ctx.siteId,
      title: `${TAG}-shift-${randomUUID().slice(0, 6)}`,
      startTime: BASE_CLOCK_IN,
      endTime: new Date(BASE_CLOCK_IN.getTime() + endOffsetHours * 3600_000),
      payRate: "20.00",
      billRate: "40.00",
      headcount: 2,
      status,
    })
    .returning({ id: shiftsTable.id });
  return shift.id;
}

beforeAll(async () => {
  ctx.adminId = await makeUser("admin", "admin");
  ctx.employeeId = await makeUser("employee", "emp");
  ctx.officerId = await makeUser("employee", "officer");
  ctx.adminToken = signToken({ userId: ctx.adminId, email: `${TAG}-admin@example.test`, role: "admin" });
  ctx.employeeToken = signToken({ userId: ctx.employeeId, email: `${TAG}-emp@example.test`, role: "employee" });

  const [client] = await db
    .insert(clientsTable)
    .values({ name: `${TAG}-client`, paymentTermsDays: 14 })
    .returning({ id: clientsTable.id });
  ctx.clientId = client.id;

  const [site] = await db
    .insert(sitesTable)
    .values({
      clientId: ctx.clientId,
      name: `${TAG}-site`,
      address: "1 Clockout Way",
      defaultBillRate: "50.00",
    })
    .returning({ id: sitesTable.id });
  ctx.siteId = site.id;

  ctx.shiftId = await makeShift("upcoming");
});

afterAll(async () => {
  await db.execute(sql`DELETE FROM invoices WHERE client_id = ${ctx.clientId}::uuid`);
  await db.execute(sql`DELETE FROM time_entries WHERE employee_id = ${ctx.officerId}::uuid`);
  await db.execute(sql`DELETE FROM shifts WHERE site_id = ${ctx.siteId}::uuid`);
  await db.execute(sql`DELETE FROM sites WHERE id = ${ctx.siteId}::uuid`);
  await db.execute(sql`DELETE FROM clients WHERE id = ${ctx.clientId}::uuid`);
  await db.execute(sql`DELETE FROM audit_logs WHERE actor_user_id = ${ctx.adminId}::uuid`);
  await db.execute(sql`DELETE FROM users WHERE last_name = ${TAG}`);
});

function authed(token: string) {
  return { Authorization: `Bearer ${token}` };
}

// The audit row is written fire-and-forget on res 'finish', so poll briefly.
async function waitForAuditRow(entryId: string, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = await db
      .select()
      .from(auditLogsTable)
      .where(and(eq(auditLogsTable.actorUserId, ctx.adminId), eq(auditLogsTable.action, "time_entries.write")))
      .orderBy(desc(auditLogsTable.createdAt));
    const hit = rows.find((r) => {
      const meta = r.metadata as { entryId?: string } | null;
      return meta?.entryId === entryId;
    });
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 50));
  }
  return null;
}

describe("PATCH /time-entries/:id/clock-out — admin fill missing clock-out", () => {
  describe("auth", () => {
    it("rejects anonymous callers with 401", async () => {
      const id = await insertOpenEntry();
      const res = await request(app)
        .patch(`/api/time-entries/${id}/clock-out`)
        .send({ clockOutTime: new Date(BASE_CLOCK_IN.getTime() + 4 * 3600_000).toISOString() });
      expect(res.status).toBe(401);
    });

    it("rejects non-admin employees with 403", async () => {
      const id = await insertOpenEntry();
      const res = await request(app)
        .patch(`/api/time-entries/${id}/clock-out`)
        .set(authed(ctx.employeeToken))
        .send({ clockOutTime: new Date(BASE_CLOCK_IN.getTime() + 4 * 3600_000).toISOString() });
      expect(res.status).toBe(403);
    });
  });

  describe("validation", () => {
    it("returns 404 for an unknown entry id", async () => {
      const res = await request(app)
        .patch(`/api/time-entries/${randomUUID()}/clock-out`)
        .set(authed(ctx.adminToken))
        .send({ clockOutTime: new Date(BASE_CLOCK_IN.getTime() + 4 * 3600_000).toISOString() });
      expect(res.status).toBe(404);
    });

    it("rejects an entry that already has a clock-out with 409", async () => {
      const id = await insertClosedEntry();
      const res = await request(app)
        .patch(`/api/time-entries/${id}/clock-out`)
        .set(authed(ctx.adminToken))
        .send({ clockOutTime: new Date(BASE_CLOCK_IN.getTime() + 6 * 3600_000).toISOString() });
      expect(res.status).toBe(409);
      expect(res.body.message).toMatch(/already has a clock-out/i);

      // Entry is untouched on rejection.
      const [row] = await db.select().from(timeEntriesTable).where(eq(timeEntriesTable.id, id));
      expect(row.hoursWorked).toBe("4.00");
      expect(row.lastEditedAt).toBeNull();
    });

    it("rejects an empty body (no clockOutTime, no useShiftEnd) with 400", async () => {
      const id = await insertOpenEntry();
      const res = await request(app)
        .patch(`/api/time-entries/${id}/clock-out`)
        .set(authed(ctx.adminToken))
        .send({});
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/clockOutTime or useShiftEnd/i);
    });

    it("rejects an invalid ISO clockOutTime with 400", async () => {
      const id = await insertOpenEntry();
      const res = await request(app)
        .patch(`/api/time-entries/${id}/clock-out`)
        .set(authed(ctx.adminToken))
        .send({ clockOutTime: "not-a-date" });
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/valid ISO timestamp/i);
    });

    it("rejects a clock-out before/equal clock-in with 400 and leaves the entry open", async () => {
      const id = await insertOpenEntry();
      const res = await request(app)
        .patch(`/api/time-entries/${id}/clock-out`)
        .set(authed(ctx.adminToken))
        .send({ clockOutTime: new Date(BASE_CLOCK_IN.getTime() - 60_000).toISOString() });
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/clock-out must be after clock-in/i);

      const [row] = await db.select().from(timeEntriesTable).where(eq(timeEntriesTable.id, id));
      expect(row.clockOutTime).toBeNull();
      expect(row.hoursWorked).toBeNull();
      expect(row.lastEditedAt).toBeNull();
    });

    it("rejects useShiftEnd on an entry not linked to a shift with 400", async () => {
      const id = await insertOpenEntry({ shiftId: null });
      const res = await request(app)
        .patch(`/api/time-entries/${id}/clock-out`)
        .set(authed(ctx.adminToken))
        .send({ useShiftEnd: true });
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/isn't linked to a shift/i);
    });
  });

  describe("happy path", () => {
    it("fills the clock-out and recomputes hoursWorked from an explicit timestamp", async () => {
      const id = await insertOpenEntry();
      const clockOut = new Date(BASE_CLOCK_IN.getTime() + 6 * 3600_000); // 6h
      const res = await request(app)
        .patch(`/api/time-entries/${id}/clock-out`)
        .set(authed(ctx.adminToken))
        .send({ clockOutTime: clockOut.toISOString() });

      expect(res.status).toBe(200);
      expect(res.body.hoursWorked).toBe("6.00");

      const [row] = await db.select().from(timeEntriesTable).where(eq(timeEntriesTable.id, id));
      expect(row.hoursWorked).toBe("6.00");
      expect(new Date(row.clockOutTime!).getTime()).toBe(clockOut.getTime());
    });

    it("snaps the clock-out to the linked shift's scheduled end with useShiftEnd", async () => {
      // Dedicated 5h shift so the snapped end is unambiguous.
      const shiftId = await makeShift("upcoming", 5);
      const id = await insertOpenEntry({ shiftId });
      const res = await request(app)
        .patch(`/api/time-entries/${id}/clock-out`)
        .set(authed(ctx.adminToken))
        .send({ useShiftEnd: true });

      expect(res.status).toBe(200);
      expect(res.body.hoursWorked).toBe("5.00");

      const [shift] = await db.select().from(shiftsTable).where(eq(shiftsTable.id, shiftId));
      const [row] = await db.select().from(timeEntriesTable).where(eq(timeEntriesTable.id, id));
      expect(new Date(row.clockOutTime!).getTime()).toBe(shift.endTime.getTime());
    });

    it("falls back to now() with useShiftEnd when clock-in is at/after the shift's scheduled end", async () => {
      // Clock-in 3h ago, shift "ended" 1h before that clock-in (a late
      // walk-up clocked in on top of an already-ended shift) — there is no
      // valid shift-end to snap to, so this must close at time-of-action
      // instead of 400ing and leaving the admin with the same unusable
      // stuck record. Uses a recent clockIn (not the fixed BASE_CLOCK_IN
      // fixture) so hoursWorked from "now" stays within the numeric(6,2)
      // column's range.
      const recentClockIn = new Date(Date.now() - 3 * 3600_000);
      const [shift] = await db
        .insert(shiftsTable)
        .values({
          siteId: ctx.siteId,
          title: `${TAG}-shift-lateclockin`,
          startTime: new Date(recentClockIn.getTime() - 5 * 3600_000),
          endTime: new Date(recentClockIn.getTime() - 1 * 3600_000),
          payRate: "20.00",
          billRate: "40.00",
          headcount: 2,
          status: "upcoming",
        })
        .returning({ id: shiftsTable.id, endTime: shiftsTable.endTime });
      const id = await insertOpenEntry({ shiftId: shift.id, clockIn: recentClockIn });
      const before = Date.now();

      const res = await request(app)
        .patch(`/api/time-entries/${id}/clock-out`)
        .set(authed(ctx.adminToken))
        .send({ useShiftEnd: true });

      expect(res.status).toBe(200);
      const [row] = await db.select().from(timeEntriesTable).where(eq(timeEntriesTable.id, id));
      expect(new Date(row.clockOutTime!).getTime()).not.toBe(shift.endTime.getTime());
      expect(new Date(row.clockOutTime!).getTime()).toBeGreaterThanOrEqual(before - 1000);
      expect(new Date(row.clockOutTime!).getTime()).toBeGreaterThan(recentClockIn.getTime());
      expect(row.notes).toMatch(/no valid shift-end time/i);
    });

    it("stamps last-edited provenance (who + when)", async () => {
      const id = await insertOpenEntry();
      const before = Date.now();
      const res = await request(app)
        .patch(`/api/time-entries/${id}/clock-out`)
        .set(authed(ctx.adminToken))
        .send({ clockOutTime: new Date(BASE_CLOCK_IN.getTime() + 5 * 3600_000).toISOString() });
      expect(res.status).toBe(200);

      const [row] = await db.select().from(timeEntriesTable).where(eq(timeEntriesTable.id, id));
      expect(row.lastEditedByUserId).toBe(ctx.adminId);
      expect(row.lastEditedByEmail).toBe(`${TAG}-admin@example.test`);
      expect(row.lastEditedAt).not.toBeNull();
      expect(new Date(row.lastEditedAt!).getTime()).toBeGreaterThanOrEqual(before - 1000);
    });

    it("records before/after audit metadata keyed by entry id", async () => {
      const id = await insertOpenEntry();
      const clockOut = new Date(BASE_CLOCK_IN.getTime() + 7 * 3600_000); // 7h
      const res = await request(app)
        .patch(`/api/time-entries/${id}/clock-out`)
        .set(authed(ctx.adminToken))
        .send({ clockOutTime: clockOut.toISOString() });
      expect(res.status).toBe(200);

      const audit = await waitForAuditRow(id);
      expect(audit).not.toBeNull();
      const meta = audit!.metadata as {
        entryId: string;
        changedFields: string[];
        before: { hoursWorked: string | null; clockOutTime: string | null };
        after: { hoursWorked: string | null; clockOutTime: string | null };
      };
      expect(meta.entryId).toBe(id);
      expect(meta.changedFields).toContain("hoursWorked");
      expect(meta.changedFields).toContain("clockOutTime");
      expect(meta.before.clockOutTime).toBeNull();
      expect(meta.before.hoursWorked).toBeNull();
      expect(meta.after.hoursWorked).toBe("7.00");
    });
  });

  describe("shift completion flip", () => {
    it("flips an active shift to completed when the last open entry is closed", async () => {
      const shiftId = await makeShift("active");
      const id = await insertOpenEntry({ shiftId });
      const res = await request(app)
        .patch(`/api/time-entries/${id}/clock-out`)
        .set(authed(ctx.adminToken))
        .send({ clockOutTime: new Date(BASE_CLOCK_IN.getTime() + 4 * 3600_000).toISOString() });
      expect(res.status).toBe(200);

      const [shift] = await db.select().from(shiftsTable).where(eq(shiftsTable.id, shiftId));
      expect(shift.status).toBe("completed");
    });

    it("leaves the shift active while another officer's entry is still open", async () => {
      const shiftId = await makeShift("active");
      const openId = await insertOpenEntry({ shiftId });
      // A DIFFERENT officer — one open entry per officer is a hard DB rule.
      const stillOpenId = await insertOpenEntry({ shiftId, employeeId: ctx.employeeId });

      const res = await request(app)
        .patch(`/api/time-entries/${openId}/clock-out`)
        .set(authed(ctx.adminToken))
        .send({ clockOutTime: new Date(BASE_CLOCK_IN.getTime() + 4 * 3600_000).toISOString() });
      expect(res.status).toBe(200);

      const [shift] = await db.select().from(shiftsTable).where(eq(shiftsTable.id, shiftId));
      expect(shift.status).toBe("active");

      // Now close the second entry and confirm the flip finally happens.
      const res2 = await request(app)
        .patch(`/api/time-entries/${stillOpenId}/clock-out`)
        .set(authed(ctx.adminToken))
        .send({ clockOutTime: new Date(BASE_CLOCK_IN.getTime() + 4 * 3600_000).toISOString() });
      expect(res2.status).toBe(200);
      const [shift2] = await db.select().from(shiftsTable).where(eq(shiftsTable.id, shiftId));
      expect(shift2.status).toBe("completed");
    });
  });

  // A pending entry is never billable, so filling its clock-out must NOT touch
  // the weekly client invoice. But an admin CAN force an open entry to
  // approved via the generic CRUD grid; filling that entry's clock-out MUST
  // re-sync the invoice so the billed hours track the correction (mirrors the
  // /times + /approve routes).
  describe("invoice sync", () => {
    beforeEach(async () => {
      await db.delete(invoicesTable).where(eq(invoicesTable.siteId, ctx.siteId));
      await db.delete(timeEntriesTable).where(eq(timeEntriesTable.employeeId, ctx.officerId));
    });

    it("does NOT create an invoice when filling a clock-out on a pending entry", async () => {
      const id = await insertOpenEntry({ approvalStatus: "pending" });
      const weekStart = weekStartIsoBusiness(BASE_CLOCK_IN);

      const res = await request(app)
        .patch(`/api/time-entries/${id}/clock-out`)
        .set(authed(ctx.adminToken))
        .send({ clockOutTime: new Date(BASE_CLOCK_IN.getTime() + 5 * 3600_000).toISOString() });
      expect(res.status).toBe(200);

      // Give any (incorrect) async sync a chance to fire, then assert none exists.
      await new Promise((r) => setTimeout(r, 300));
      const rows = await db
        .select()
        .from(invoicesTable)
        .where(and(eq(invoicesTable.siteId, ctx.siteId), eq(invoicesTable.periodStart, weekStart)));
      expect(rows).toHaveLength(0);
    });

    it("creates/updates the weekly invoice when filling a clock-out on an approved entry", async () => {
      // An admin force-approved this entry while it was still open (possible via
      // the generic CRUD grid). Filling the clock-out should bill the hours.
      const id = await insertOpenEntry({ approvalStatus: "approved" });
      const weekStart = weekStartIsoBusiness(BASE_CLOCK_IN);

      const res = await request(app)
        .patch(`/api/time-entries/${id}/clock-out`)
        .set(authed(ctx.adminToken))
        .send({ clockOutTime: new Date(BASE_CLOCK_IN.getTime() + 5 * 3600_000).toISOString() });
      expect(res.status).toBe(200);
      expect(res.body.hoursWorked).toBe("5.00");

      // Best-effort async sync — poll briefly for the draft invoice to appear.
      const deadline = Date.now() + 2000;
      let rows: (typeof invoicesTable.$inferSelect)[] = [];
      while (Date.now() < deadline) {
        rows = await db
          .select()
          .from(invoicesTable)
          .where(and(eq(invoicesTable.siteId, ctx.siteId), eq(invoicesTable.periodStart, weekStart)));
        if (rows.length > 0) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(rows).toHaveLength(1);
      // 5h × $40 shift billRate = $200.00 billed for the week.
      expect(Number(rows[0].totalAmount)).toBe(200);
    });
  });
});
