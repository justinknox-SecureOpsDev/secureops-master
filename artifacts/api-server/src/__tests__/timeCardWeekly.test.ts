// GET /time-entries/time-card — weekly time-card view.
//
// This route mirrors payroll's hour math (sum raw hoursWorked, round 2dp at
// the end, business-TZ Monday-start weeks, rejected excluded, open entries
// listed but uncounted). These tests pin that behavior so a future payroll
// or timezone change can't silently make the time card disagree with the
// Payroll Board.
const PRIOR_PAYROLL_TZ = process.env.PAYROLL_TIMEZONE;
process.env.PAYROLL_TIMEZONE = "America/Chicago";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { sql } from "drizzle-orm";
import {
  db,
  usersTable,
  clientsTable,
  sitesTable,
  shiftsTable,
  timeEntriesTable,
} from "@workspace/db";
import app from "../app";
import { signToken } from "../middlewares/auth";

const TAG = `timecard-test-${randomUUID().slice(0, 8)}`;
const passwordHash = bcrypt.hashSync("test-password", 4);

type Ctx = {
  adminId: string;
  dispatcherId: string;
  officerId: string;
  otherOfficerId: string;
  adminToken: string;
  dispatcherToken: string;
  officerToken: string;
  otherOfficerToken: string;
  clientId: string;
  siteId: string;
  shiftId: string;
};
const ctx = {} as Ctx;

async function makeUser(role: "admin" | "dispatcher" | "employee", suffix: string): Promise<string> {
  const [row] = await db
    .insert(usersTable)
    .values({
      email: `${TAG}-${suffix}@example.test`,
      passwordHash,
      firstName: suffix,
      lastName: TAG,
      role,
      status: "active",
      tokensValidAfter: new Date(0),
    })
    .returning({ id: usersTable.id });
  return row.id;
}

// Fixed test week: Monday 2025-06-02 in America/Chicago (CDT, UTC-5).
// Central Monday 00:00 = 2025-06-02T05:00:00Z.
const WEEK_START = "2025-06-02";

async function insertEntry(opts: {
  employeeId?: string;
  clockIn: Date;
  clockOut?: Date | null;
  hours?: string | null;
  approvalStatus?: "pending" | "approved" | "rejected";
}): Promise<string> {
  const [row] = await db
    .insert(timeEntriesTable)
    .values({
      shiftId: ctx.shiftId,
      siteId: ctx.siteId,
      employeeId: opts.employeeId ?? ctx.officerId,
      clockInTime: opts.clockIn,
      clockOutTime: opts.clockOut === undefined ? new Date(opts.clockIn.getTime() + 4 * 3600_000) : opts.clockOut,
      hoursWorked: opts.hours === undefined ? "4.00" : opts.hours,
      approvalStatus: opts.approvalStatus ?? "pending",
    })
    .returning({ id: timeEntriesTable.id });
  return row.id;
}

beforeAll(async () => {
  ctx.adminId = await makeUser("admin", "admin");
  ctx.dispatcherId = await makeUser("dispatcher", "dispatch");
  ctx.officerId = await makeUser("employee", "officer");
  ctx.otherOfficerId = await makeUser("employee", "other");
  ctx.adminToken = signToken({ userId: ctx.adminId, email: `${TAG}-admin@example.test`, role: "admin" });
  ctx.dispatcherToken = signToken({ userId: ctx.dispatcherId, email: `${TAG}-dispatch@example.test`, role: "dispatcher" });
  ctx.officerToken = signToken({ userId: ctx.officerId, email: `${TAG}-officer@example.test`, role: "employee" });
  ctx.otherOfficerToken = signToken({ userId: ctx.otherOfficerId, email: `${TAG}-other@example.test`, role: "employee" });

  const [client] = await db
    .insert(clientsTable)
    .values({ name: `${TAG}-client`, paymentTermsDays: 14 })
    .returning({ id: clientsTable.id });
  ctx.clientId = client.id;

  const [site] = await db
    .insert(sitesTable)
    .values({ clientId: ctx.clientId, name: `${TAG}-site`, address: "1 Timecard Way", defaultBillRate: "50.00" })
    .returning({ id: sitesTable.id });
  ctx.siteId = site.id;

  const [shift] = await db
    .insert(shiftsTable)
    .values({
      siteId: ctx.siteId,
      title: `${TAG}-shift`,
      startTime: new Date("2025-06-03T14:00:00.000Z"),
      endTime: new Date("2025-06-03T18:00:00.000Z"),
      payRate: "20.00",
      billRate: "40.00",
      headcount: 1,
    })
    .returning({ id: shiftsTable.id });
  ctx.shiftId = shift.id;

  // --- Entries in the 2025-06-02 week for ctx.officerId ---
  // A: Tue Jun 3, 9:00am CT — 4h approved.
  await insertEntry({
    clockIn: new Date("2025-06-03T14:00:00.000Z"),
    hours: "4.00",
    approvalStatus: "approved",
  });
  // B: LATE-EVENING CENTRAL entry — Mon Jun 2, 11:30pm CT. In UTC that is
  // Tue Jun 3 04:30Z; business-TZ bucketing must place it on Monday.
  await insertEntry({
    clockIn: new Date("2025-06-03T04:30:00.000Z"),
    clockOut: new Date("2025-06-03T07:00:00.000Z"),
    hours: "2.50",
    approvalStatus: "pending",
  });
  // C: rejected 8h on Wed — listed but excluded from all totals.
  await insertEntry({
    clockIn: new Date("2025-06-04T14:00:00.000Z"),
    hours: "8.00",
    approvalStatus: "rejected",
  });
  // D: open entry on Thu (no clock-out) — listed as open, never counted.
  await insertEntry({
    clockIn: new Date("2025-06-05T14:00:00.000Z"),
    clockOut: null,
    hours: null,
  });
  // E: just BEFORE the week (Sun Jun 1, 11:00pm CT = Mon Jun 2 04:00Z) —
  // UTC date is already Monday but the business week hasn't started; must
  // NOT appear in the 2025-06-02 card.
  await insertEntry({
    clockIn: new Date("2025-06-02T04:00:00.000Z"),
    hours: "3.00",
    approvalStatus: "approved",
  });
});

afterAll(async () => {
  if (PRIOR_PAYROLL_TZ === undefined) delete process.env.PAYROLL_TIMEZONE;
  else process.env.PAYROLL_TIMEZONE = PRIOR_PAYROLL_TZ;
  await db.execute(sql`DELETE FROM time_entries WHERE site_id = ${ctx.siteId}::uuid`);
  await db.execute(sql`DELETE FROM shifts WHERE site_id = ${ctx.siteId}::uuid`);
  await db.execute(sql`DELETE FROM sites WHERE id = ${ctx.siteId}::uuid`);
  await db.execute(sql`DELETE FROM clients WHERE id = ${ctx.clientId}::uuid`);
  await db.execute(sql`DELETE FROM users WHERE last_name = ${TAG}`);
});

function authed(token: string) {
  return { Authorization: `Bearer ${token}` };
}

async function getCard(token: string, params: Record<string, string> = {}) {
  return request(app).get("/api/time-entries/time-card").set(authed(token)).query(params);
}

describe("GET /time-entries/time-card", () => {
  describe("authz", () => {
    it("rejects anonymous callers with 401", async () => {
      const res = await request(app).get("/api/time-entries/time-card");
      expect(res.status).toBe(401);
    });

    it("officer requesting another employee's card gets 403", async () => {
      const res = await getCard(ctx.otherOfficerToken, { employeeId: ctx.officerId, weekStart: WEEK_START });
      expect(res.status).toBe(403);
    });

    it("officer may pass their OWN employeeId explicitly", async () => {
      const res = await getCard(ctx.officerToken, { employeeId: ctx.officerId, weekStart: WEEK_START });
      expect(res.status).toBe(200);
      expect(res.body.employeeId).toBe(ctx.officerId);
    });

    it("admin may view any employee's card", async () => {
      const res = await getCard(ctx.adminToken, { employeeId: ctx.officerId, weekStart: WEEK_START });
      expect(res.status).toBe(200);
      expect(res.body.employeeId).toBe(ctx.officerId);
    });

    it("dispatcher may view any employee's card", async () => {
      const res = await getCard(ctx.dispatcherToken, { employeeId: ctx.officerId, weekStart: WEEK_START });
      expect(res.status).toBe(200);
      expect(res.body.employeeId).toBe(ctx.officerId);
    });

    it("admin gets 404 for an unknown employeeId", async () => {
      const res = await getCard(ctx.adminToken, { employeeId: randomUUID(), weekStart: WEEK_START });
      expect(res.status).toBe(404);
    });
  });

  describe("input validation", () => {
    it("rejects a malformed weekStart with 400", async () => {
      const res = await getCard(ctx.officerToken, { weekStart: "06/02/2025" });
      expect(res.status).toBe(400);
    });

    it("snaps a mid-week weekStart date back to that week's Monday", async () => {
      const res = await getCard(ctx.adminToken, { employeeId: ctx.officerId, weekStart: "2025-06-04" });
      expect(res.status).toBe(200);
      expect(res.body.weekStart).toBe("2025-06-02");
      expect(res.body.weekEnd).toBe("2025-06-08");
    });
  });

  describe("business-TZ bucketing and payroll-parity totals", () => {
    it("buckets a late-evening Central entry on its business day, not its UTC date", async () => {
      const res = await getCard(ctx.adminToken, { employeeId: ctx.officerId, weekStart: WEEK_START });
      expect(res.status).toBe(200);
      const monday = res.body.days.find((d: any) => d.date === "2025-06-02");
      expect(monday).toBeTruthy();
      // Entry B (11:30pm CT Monday = 04:30Z Tuesday) must land on Monday.
      expect(monday.entries).toHaveLength(1);
      expect(monday.entries[0].hoursWorked).toBe(2.5);
      expect(monday.totalHours).toBe(2.5);
      // And Tuesday holds only entry A.
      const tuesday = res.body.days.find((d: any) => d.date === "2025-06-03");
      expect(tuesday.entries).toHaveLength(1);
      expect(tuesday.entries[0].hoursWorked).toBe(4);
    });

    it("excludes an entry clocked in before the business week even when its UTC date is Monday", async () => {
      const res = await getCard(ctx.adminToken, { employeeId: ctx.officerId, weekStart: WEEK_START });
      const allIds = res.body.days.flatMap((d: any) => d.entries.map((e: any) => e.hoursWorked));
      // Entry E (3.00h, Sunday 11pm CT) must not appear anywhere in this week.
      expect(allIds).not.toContain(3);
      // ...but it does appear in the previous week's card, on Sunday.
      const prev = await getCard(ctx.adminToken, { employeeId: ctx.officerId, weekStart: "2025-05-26" });
      const sunday = prev.body.days.find((d: any) => d.date === "2025-06-01");
      expect(sunday.entries).toHaveLength(1);
      expect(sunday.entries[0].hoursWorked).toBe(3);
      expect(prev.body.totalHours).toBe(3);
    });

    it("lists rejected entries but excludes them from every total", async () => {
      const res = await getCard(ctx.adminToken, { employeeId: ctx.officerId, weekStart: WEEK_START });
      const wednesday = res.body.days.find((d: any) => d.date === "2025-06-04");
      expect(wednesday.entries).toHaveLength(1);
      expect(wednesday.entries[0].approvalStatus).toBe("rejected");
      expect(wednesday.entries[0].hoursWorked).toBe(8);
      expect(wednesday.totalHours).toBe(0);
    });

    it("lists open entries (no clock-out) as open with null hours, uncounted", async () => {
      const res = await getCard(ctx.adminToken, { employeeId: ctx.officerId, weekStart: WEEK_START });
      const thursday = res.body.days.find((d: any) => d.date === "2025-06-05");
      expect(thursday.entries).toHaveLength(1);
      expect(thursday.entries[0].open).toBe(true);
      expect(thursday.entries[0].hoursWorked).toBeNull();
      expect(thursday.totalHours).toBe(0);
    });

    it("week totals mirror payroll: sum raw then round 2dp; approved/pending split", async () => {
      const res = await getCard(ctx.adminToken, { employeeId: ctx.officerId, weekStart: WEEK_START });
      // A (4.00 approved) + B (2.50 pending); C rejected + D open excluded.
      expect(res.body.totalHours).toBe(6.5);
      expect(res.body.approvedHours).toBe(4);
      expect(res.body.pendingHours).toBe(2.5);
      expect(res.body.timezone).toBe("America/Chicago");
    });

    it("rounds the summed total once at the end (payroll parity), not per entry", async () => {
      // Three 1.33h entries: raw sum 3.99 — per-entry 2dp rounding would also
      // give 3.99 here, so use .005 halves: 1.13 + 1.13 + 1.13 stays exact,
      // but 0.33+0.33+0.33=0.99 vs 1/3h values can't be stored (2dp column).
      // The strongest storable check: many small values whose float sum drifts
      // (0.10 x 7 = 0.7000000000000001) must come back exactly 0.7.
      const weekStart = "2024-04-01"; // isolated past week
      for (let i = 0; i < 7; i++) {
        await insertEntry({
          employeeId: ctx.otherOfficerId,
          clockIn: new Date(`2024-04-0${(i % 5) + 1}T14:0${i}:00.000Z`),
          hours: "0.10",
          approvalStatus: "approved",
        });
      }
      const res = await getCard(ctx.adminToken, { employeeId: ctx.otherOfficerId, weekStart });
      expect(res.body.totalHours).toBe(0.7);
      expect(res.body.approvedHours).toBe(0.7);
    });
  });

  describe("week navigation across DST", () => {
    it("spring-forward week (Mar 2026): prev/next Mondays are exactly 7 calendar days apart", async () => {
      // US DST starts Sunday 2026-03-08 (Central week Mon Mar 2 – Sun Mar 8).
      const res = await getCard(ctx.adminToken, { employeeId: ctx.officerId, weekStart: "2026-03-02" });
      expect(res.status).toBe(200);
      expect(res.body.weekStart).toBe("2026-03-02");
      expect(res.body.weekEnd).toBe("2026-03-08");
      expect(res.body.prevWeekStart).toBe("2026-02-23");
      expect(res.body.nextWeekStart).toBe("2026-03-09");
      expect(res.body.days.map((d: any) => d.date)).toEqual([
        "2026-03-02", "2026-03-03", "2026-03-04", "2026-03-05", "2026-03-06", "2026-03-07", "2026-03-08",
      ]);
    });

    it("fall-back week (Nov 2026): navigation stays on Mondays despite the 25-hour Sunday", async () => {
      // US DST ends Sunday 2026-11-01 (Central week Mon Oct 26 – Sun Nov 1).
      const res = await getCard(ctx.adminToken, { employeeId: ctx.officerId, weekStart: "2026-10-26" });
      expect(res.status).toBe(200);
      expect(res.body.weekStart).toBe("2026-10-26");
      expect(res.body.weekEnd).toBe("2026-11-01");
      expect(res.body.prevWeekStart).toBe("2026-10-19");
      expect(res.body.nextWeekStart).toBe("2026-11-02");
    });

    it("navigating next from the spring-forward week and back returns to the same Monday", async () => {
      const fwd = await getCard(ctx.adminToken, { employeeId: ctx.officerId, weekStart: "2026-03-09" });
      expect(fwd.body.prevWeekStart).toBe("2026-03-02");
      const back = await getCard(ctx.adminToken, { employeeId: ctx.officerId, weekStart: fwd.body.prevWeekStart });
      expect(back.body.weekStart).toBe("2026-03-02");
    });
  });
});
