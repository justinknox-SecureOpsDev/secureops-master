import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { sql, eq, and, desc } from "drizzle-orm";
import {
  db,
  usersTable,
  clientsTable,
  sitesTable,
  shiftsTable,
  timeEntriesTable,
  invoicesTable,
  auditLogsTable,
  siteManagersTable,
} from "@workspace/db";
import app from "../app";
import { signToken } from "../middlewares/auth";
import { weekStartIsoBusiness } from "../lib/invoiceSync";

const TAG = `tecorrect-test-${randomUUID().slice(0, 8)}`;
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
  onSiteManagerId: string; // manages ctx.siteId
  offSiteManagerId: string; // manages nothing
  onSiteManagerToken: string;
  offSiteManagerToken: string;
};
const ctx = {} as Ctx;

async function makeUser(role: "admin" | "employee" | "site_manager", suffix: string): Promise<string> {
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
// collides with real/seed data and the corrected times stay in the same week.
const BASE_CLOCK_IN = new Date("2025-03-04T14:00:00.000Z"); // a Tuesday
const BASE_CLOCK_OUT = new Date("2025-03-04T18:00:00.000Z"); // +4h

async function insertEntry(opts: {
  clockIn?: Date;
  clockOut?: Date | null;
  hours?: string | null;
  approvalStatus?: "pending" | "approved" | "rejected";
  /** Detach from both site and shift, so the entry resolves to no site at all. */
  siteless?: boolean;
}): Promise<string> {
  const [row] = await db
    .insert(timeEntriesTable)
    .values({
      shiftId: opts.siteless ? null : ctx.shiftId,
      siteId: opts.siteless ? null : ctx.siteId,
      employeeId: ctx.officerId,
      clockInTime: opts.clockIn ?? BASE_CLOCK_IN,
      clockOutTime: opts.clockOut === undefined ? BASE_CLOCK_OUT : opts.clockOut,
      hoursWorked: opts.hours === undefined ? "4.00" : opts.hours,
      approvalStatus: opts.approvalStatus ?? "pending",
    })
    .returning({ id: timeEntriesTable.id });
  return row.id;
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
      address: "1 Correction Way",
      defaultBillRate: "50.00",
    })
    .returning({ id: sitesTable.id });
  ctx.siteId = site.id;

  const [shift] = await db
    .insert(shiftsTable)
    .values({
      siteId: ctx.siteId,
      title: `${TAG}-shift`,
      startTime: BASE_CLOCK_IN,
      endTime: BASE_CLOCK_OUT,
      payRate: "20.00",
      billRate: "40.00",
      headcount: 1,
    })
    .returning({ id: shiftsTable.id });
  ctx.shiftId = shift.id;

  // Two site managers: one assigned to the entry's site, one assigned to
  // nothing. The pair pins the per-site boundary on the correction route —
  // holding the role is not the same as having reach.
  ctx.onSiteManagerId = await makeUser("site_manager", "mgr-on");
  ctx.offSiteManagerId = await makeUser("site_manager", "mgr-off");
  ctx.onSiteManagerToken = signToken({ userId: ctx.onSiteManagerId, email: `${TAG}-mgr-on@example.test`, role: "site_manager" });
  ctx.offSiteManagerToken = signToken({ userId: ctx.offSiteManagerId, email: `${TAG}-mgr-off@example.test`, role: "site_manager" });
  await db.insert(siteManagersTable).values([{ siteId: ctx.siteId, userId: ctx.onSiteManagerId }]);
});

afterAll(async () => {
  await db.execute(sql`DELETE FROM invoices WHERE client_id = ${ctx.clientId}::uuid`);
  await db.execute(sql`DELETE FROM time_entries WHERE employee_id = ${ctx.officerId}::uuid`);
  await db.execute(sql`DELETE FROM site_managers WHERE site_id = ${ctx.siteId}::uuid`);
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

describe("PATCH /time-entries/:id/times — admin timestamp correction", () => {
  describe("auth", () => {
    it("rejects anonymous callers with 401", async () => {
      const id = await insertEntry({});
      const res = await request(app)
        .patch(`/api/time-entries/${id}/times`)
        .send({ clockOutTime: BASE_CLOCK_OUT.toISOString() });
      expect(res.status).toBe(401);
    });

    it("rejects non-admin employees with 403", async () => {
      const id = await insertEntry({});
      const res = await request(app)
        .patch(`/api/time-entries/${id}/times`)
        .set(authed(ctx.employeeToken))
        .send({ clockOutTime: BASE_CLOCK_OUT.toISOString() });
      expect(res.status).toBe(403);
    });
  });

  // Site managers correct clock times from the mobile app, but only for the
  // sites they are assigned to. The role middleware alone proves the role, not
  // the reach — without the per-entry site assertion any manager could rewrite
  // hours at every site in the company, silently and with no error surfaced.
  describe("site manager scoping", () => {
    const CORRECTED_OUT = new Date("2025-03-04T19:30:00.000Z"); // +5.5h from BASE_CLOCK_IN

    it("lets a manager of the entry's site correct the times", async () => {
      const id = await insertEntry({});
      const res = await request(app)
        .patch(`/api/time-entries/${id}/times`)
        .set(authed(ctx.onSiteManagerToken))
        .send({ clockOutTime: CORRECTED_OUT.toISOString() });

      expect(res.status).toBe(200);
      const [row] = await db.select().from(timeEntriesTable).where(eq(timeEntriesTable.id, id));
      expect(row.clockOutTime?.toISOString()).toBe(CORRECTED_OUT.toISOString());
      expect(parseFloat(row.hoursWorked ?? "0")).toBeCloseTo(5.5, 2);
      expect(row.lastEditedByUserId).toBe(ctx.onSiteManagerId);
    });

    it("refuses a manager who does not manage the entry's site, leaving times untouched", async () => {
      const id = await insertEntry({});
      const res = await request(app)
        .patch(`/api/time-entries/${id}/times`)
        .set(authed(ctx.offSiteManagerToken))
        .send({ clockOutTime: CORRECTED_OUT.toISOString() });

      expect(res.status).toBe(403);
      const [row] = await db.select().from(timeEntriesTable).where(eq(timeEntriesTable.id, id));
      expect(row.clockOutTime?.toISOString()).toBe(BASE_CLOCK_OUT.toISOString());
      expect(row.lastEditedByUserId).toBeNull();
    });

    it("refuses a manager on an entry with no resolvable site", async () => {
      const id = await insertEntry({ siteless: true });
      const res = await request(app)
        .patch(`/api/time-entries/${id}/times`)
        .set(authed(ctx.onSiteManagerToken))
        .send({ clockOutTime: CORRECTED_OUT.toISOString() });

      expect(res.status).toBe(403);
    });

    // Site managers must never see any rate. The mutation response is built
    // from the same projection + sanitizer as the list route; returning the
    // raw updated row would hand them payRateOverride and last-editor details.
    it("shows a site manager payRate but never billRate/payRateOverride/last-editor fields", async () => {
      const id = await insertEntry({});
      await db.update(timeEntriesTable).set({ payRateOverride: "33.00" }).where(eq(timeEntriesTable.id, id));

      const res = await request(app)
        .patch(`/api/time-entries/${id}/times`)
        .set(authed(ctx.onSiteManagerToken))
        .send({ clockOutTime: CORRECTED_OUT.toISOString() });

      expect(res.status).toBe(200);
      // payRate is visible to a site manager — only the client bill rate and
      // finance-adjacent internals (the override, last-editor identity) are not.
      expect(res.body).toHaveProperty("payRate");
      expect(res.body.payRate).toBe("20.00");
      expect(res.body).not.toHaveProperty("payRateOverride");
      expect(res.body).not.toHaveProperty("billRate");
      expect(res.body).not.toHaveProperty("lastEditedByEmail");
      // The operational fields the mobile approval screen renders still arrive.
      expect(res.body.hoursWorked).toBe("5.50");
      expect(res.body.employeeName).toBeTruthy();
    });

    it("still returns rates to an admin correcting the same entry", async () => {
      const id = await insertEntry({});
      const res = await request(app)
        .patch(`/api/time-entries/${id}/times`)
        .set(authed(ctx.adminToken))
        .send({ clockOutTime: CORRECTED_OUT.toISOString() });

      expect(res.status).toBe(200);
      expect(res.body.payRate).toBe("20.00");
      expect(res.body.billRate).toBe("40.00");
    });

    it("still lets an admin correct an entry with no resolvable site", async () => {
      const id = await insertEntry({ siteless: true });
      const res = await request(app)
        .patch(`/api/time-entries/${id}/times`)
        .set(authed(ctx.adminToken))
        .send({ clockOutTime: CORRECTED_OUT.toISOString() });

      expect(res.status).toBe(200);
    });
  });

  describe("validation", () => {
    it("rejects an empty body (no clockInTime or clockOutTime) with 400", async () => {
      const id = await insertEntry({});
      const res = await request(app)
        .patch(`/api/time-entries/${id}/times`)
        .set(authed(ctx.adminToken))
        .send({});
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/clockInTime and\/or clockOutTime/i);
    });

    it("rejects clock-out before/equal clock-in with 400", async () => {
      const id = await insertEntry({});
      const res = await request(app)
        .patch(`/api/time-entries/${id}/times`)
        .set(authed(ctx.adminToken))
        .send({
          clockInTime: BASE_CLOCK_IN.toISOString(),
          clockOutTime: new Date(BASE_CLOCK_IN.getTime() - 60_000).toISOString(),
        });
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/clock-out must be after clock-in/i);

      // Entry is unchanged on rejection.
      const [row] = await db.select().from(timeEntriesTable).where(eq(timeEntriesTable.id, id));
      expect(row.hoursWorked).toBe("4.00");
      expect(row.lastEditedAt).toBeNull();
    });

    it("rejects an invalid ISO clockOutTime with 400", async () => {
      const id = await insertEntry({});
      const res = await request(app)
        .patch(`/api/time-entries/${id}/times`)
        .set(authed(ctx.adminToken))
        .send({ clockOutTime: "not-a-date" });
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/valid ISO timestamp/i);
    });

    it("returns 404 for an unknown entry id", async () => {
      const res = await request(app)
        .patch(`/api/time-entries/${randomUUID()}/times`)
        .set(authed(ctx.adminToken))
        .send({ clockOutTime: BASE_CLOCK_OUT.toISOString() });
      expect(res.status).toBe(404);
    });
  });

  describe("happy path", () => {
    it("recomputes hoursWorked from the corrected timestamps", async () => {
      // Start at 4h, correct clock-out to 6h after clock-in.
      const id = await insertEntry({});
      const newClockOut = new Date(BASE_CLOCK_IN.getTime() + 6 * 3600_000);
      const res = await request(app)
        .patch(`/api/time-entries/${id}/times`)
        .set(authed(ctx.adminToken))
        .send({ clockOutTime: newClockOut.toISOString() });

      expect(res.status).toBe(200);
      expect(res.body.hoursWorked).toBe("6.00");

      const [row] = await db.select().from(timeEntriesTable).where(eq(timeEntriesTable.id, id));
      expect(row.hoursWorked).toBe("6.00");
      expect(new Date(row.clockOutTime!).getTime()).toBe(newClockOut.getTime());
    });

    it("recomputes hoursWorked when both timestamps are corrected", async () => {
      const id = await insertEntry({});
      const newIn = new Date("2025-03-04T13:00:00.000Z");
      const newOut = new Date("2025-03-04T16:30:00.000Z"); // 3.5h
      const res = await request(app)
        .patch(`/api/time-entries/${id}/times`)
        .set(authed(ctx.adminToken))
        .send({ clockInTime: newIn.toISOString(), clockOutTime: newOut.toISOString() });

      expect(res.status).toBe(200);
      expect(res.body.hoursWorked).toBe("3.50");
    });

    it("stamps last-edited provenance (who + when)", async () => {
      const id = await insertEntry({});
      const before = Date.now();
      const res = await request(app)
        .patch(`/api/time-entries/${id}/times`)
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
      const id = await insertEntry({});
      const newOut = new Date(BASE_CLOCK_IN.getTime() + 7 * 3600_000); // 7h
      const res = await request(app)
        .patch(`/api/time-entries/${id}/times`)
        .set(authed(ctx.adminToken))
        .send({ clockOutTime: newOut.toISOString() });
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
      expect(meta.before.hoursWorked).toBe("4.00");
      expect(meta.after.hoursWorked).toBe("7.00");
    });
  });

  describe("invoice re-sync", () => {
    beforeEach(async () => {
      // Isolate the invoice for this site+week from other tests' entries.
      await db.delete(invoicesTable).where(eq(invoicesTable.siteId, ctx.siteId));
      await db.delete(timeEntriesTable).where(eq(timeEntriesTable.employeeId, ctx.officerId));
    });

    it("re-syncs the weekly client invoice for an approved entry after correction", async () => {
      // Approved entry, 4h @ shift billRate 40 => invoice subtotal 160.
      const id = await insertEntry({ approvalStatus: "approved" });
      const weekStart = weekStartIsoBusiness(BASE_CLOCK_IN);

      const res = await request(app)
        .patch(`/api/time-entries/${id}/times`)
        .set(authed(ctx.adminToken))
        .send({ clockOutTime: new Date(BASE_CLOCK_IN.getTime() + 8 * 3600_000).toISOString() }); // 8h
      expect(res.status).toBe(200);
      expect(res.body.hoursWorked).toBe("8.00");

      // upsertWeeklyInvoiceForTimeEntry is fire-and-forget; poll for the row.
      const deadline = Date.now() + 3000;
      let invoice: typeof invoicesTable.$inferSelect | undefined;
      while (Date.now() < deadline) {
        [invoice] = await db
          .select()
          .from(invoicesTable)
          .where(and(eq(invoicesTable.siteId, ctx.siteId), eq(invoicesTable.periodStart, weekStart)));
        if (invoice && parseFloat(String(invoice.subtotal)) === 320) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(invoice).toBeDefined();
      // 8h @ billRate 40 = 320.
      expect(parseFloat(String(invoice!.subtotal))).toBe(320);
      const lines = invoice!.lineItems as Array<{ hours: number; amount: number }>;
      expect(lines).toHaveLength(1);
      expect(lines[0].hours).toBe(8);
      expect(lines[0].amount).toBe(320);
    });

    it("does NOT create an invoice when correcting a pending (unapproved) entry", async () => {
      const id = await insertEntry({ approvalStatus: "pending" });
      const weekStart = weekStartIsoBusiness(BASE_CLOCK_IN);

      const res = await request(app)
        .patch(`/api/time-entries/${id}/times`)
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
  });
});
