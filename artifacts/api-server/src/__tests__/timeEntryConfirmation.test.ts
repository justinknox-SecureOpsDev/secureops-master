import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { sql, eq } from "drizzle-orm";
import {
  db,
  usersTable,
  clientsTable,
  sitesTable,
  shiftsTable,
  shiftAssignmentsTable,
  timeEntriesTable,
} from "@workspace/db";
import app from "../app";
import { signToken } from "../middlewares/auth";

const TAG = `teconfirm-test-${randomUUID().slice(0, 8)}`;
const passwordHash = bcrypt.hashSync("test-password", 4);

type Ctx = {
  adminId: string;
  officerId: string;
  otherOfficerId: string;
  adminToken: string;
  officerToken: string;
  otherOfficerToken: string;
  clientId: string;
  siteId: string;
  shiftId: string;
};
const ctx = {} as Ctx;

const BASE_CLOCK_IN = new Date("2025-04-08T14:00:00.000Z"); // a Tuesday
const BASE_CLOCK_OUT = new Date("2025-04-08T18:00:00.000Z"); // +4h

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

async function insertAwaitingEntry(opts?: {
  confirmationStatus?: string | null;
  clockOut?: Date | null;
  employeeId?: string;
}): Promise<string> {
  const [row] = await db
    .insert(timeEntriesTable)
    .values({
      shiftId: ctx.shiftId,
      siteId: ctx.siteId,
      employeeId: opts?.employeeId ?? ctx.officerId,
      clockInTime: BASE_CLOCK_IN,
      clockOutTime: opts?.clockOut === undefined ? BASE_CLOCK_OUT : opts.clockOut,
      hoursWorked: "4.00",
      approvalStatus: "pending",
      confirmationStatus:
        opts?.confirmationStatus === undefined ? "awaiting_confirmation" : opts.confirmationStatus,
      originalClockInTime: BASE_CLOCK_IN,
      originalClockOutTime: opts?.clockOut === undefined ? BASE_CLOCK_OUT : opts.clockOut,
    })
    .returning({ id: timeEntriesTable.id });
  return row.id;
}

beforeAll(async () => {
  ctx.adminId = await makeUser("admin", "admin");
  ctx.officerId = await makeUser("employee", "officer");
  ctx.otherOfficerId = await makeUser("employee", "other");
  ctx.adminToken = signToken({ userId: ctx.adminId, email: `${TAG}-admin@example.test`, role: "admin" });
  ctx.officerToken = signToken({ userId: ctx.officerId, email: `${TAG}-officer@example.test`, role: "employee" });
  ctx.otherOfficerToken = signToken({ userId: ctx.otherOfficerId, email: `${TAG}-other@example.test`, role: "employee" });

  const [client] = await db
    .insert(clientsTable)
    .values({ name: `${TAG}-client`, paymentTermsDays: 14 })
    .returning({ id: clientsTable.id });
  ctx.clientId = client.id;

  const [site] = await db
    .insert(sitesTable)
    .values({ clientId: ctx.clientId, name: `${TAG}-site`, address: "1 Confirm Way", defaultBillRate: "50.00" })
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
      headcount: 2,
    })
    .returning({ id: shiftsTable.id });
  ctx.shiftId = shift.id;
});

afterAll(async () => {
  await db.execute(sql`DELETE FROM invoices WHERE client_id = ${ctx.clientId}::uuid`);
  await db.execute(sql`DELETE FROM time_entries WHERE site_id = ${ctx.siteId}::uuid`);
  await db.execute(sql`DELETE FROM shift_assignments WHERE shift_id = ${ctx.shiftId}::uuid`);
  await db.execute(sql`DELETE FROM shifts WHERE site_id = ${ctx.siteId}::uuid`);
  await db.execute(sql`DELETE FROM sites WHERE id = ${ctx.siteId}::uuid`);
  await db.execute(sql`DELETE FROM clients WHERE id = ${ctx.clientId}::uuid`);
  await db.execute(sql`DELETE FROM audit_logs WHERE actor_user_id IN (${ctx.officerId}::uuid, ${ctx.adminId}::uuid)`);
  await db.execute(sql`DELETE FROM users WHERE last_name = ${TAG}`);
});

function authed(token: string) {
  return { Authorization: `Bearer ${token}` };
}

async function getEntry(id: string) {
  const [row] = await db.select().from(timeEntriesTable).where(eq(timeEntriesTable.id, id));
  return row;
}

describe("officer clock-out enters awaiting_confirmation", () => {
  it("owner-initiated clock-out sets awaiting + original-time snapshot", async () => {
    // Assign + open entry via the real clock-in/out flow: insert an open entry
    // directly (clock-in paths are tested elsewhere) and clock out as owner.
    await db.insert(shiftAssignmentsTable).values({
      shiftId: ctx.shiftId,
      employeeId: ctx.officerId,
      status: "accepted",
    });
    const [open] = await db
      .insert(timeEntriesTable)
      .values({
        shiftId: ctx.shiftId,
        siteId: ctx.siteId,
        employeeId: ctx.officerId,
        clockInTime: new Date(Date.now() - 3600_000),
        clockOutTime: null,
        approvalStatus: "pending",
      })
      .returning({ id: timeEntriesTable.id });

    const res = await request(app)
      .post("/api/time-entries/clock-out")
      .set(authed(ctx.officerToken))
      .send({ timeEntryId: open.id, lat: 0, lng: 0 });
    expect(res.status).toBe(200);

    const row = await getEntry(open.id);
    expect(row.confirmationStatus).toBe("awaiting_confirmation");
    expect(row.originalClockInTime).not.toBeNull();
    expect(row.originalClockOutTime).not.toBeNull();
    expect(row.employeeEdited).toBe(false);
    expect(row.confirmedAt).toBeNull();
  });

  it("admin clock-out on someone else's entry does NOT set awaiting", async () => {
    const [open] = await db
      .insert(timeEntriesTable)
      .values({
        shiftId: ctx.shiftId,
        siteId: ctx.siteId,
        employeeId: ctx.officerId,
        clockInTime: new Date(Date.now() - 3600_000),
        clockOutTime: null,
        approvalStatus: "pending",
      })
      .returning({ id: timeEntriesTable.id });

    const res = await request(app)
      .post("/api/time-entries/clock-out")
      .set(authed(ctx.adminToken))
      .send({ timeEntryId: open.id, lat: 0, lng: 0 });
    expect(res.status).toBe(200);

    const row = await getEntry(open.id);
    expect(row.confirmationStatus).toBeNull();
  });
});

describe("POST /time-entries/:id/confirm", () => {
  it("rejects anonymous callers with 401", async () => {
    const id = await insertAwaitingEntry();
    const res = await request(app).post(`/api/time-entries/${id}/confirm`).send({});
    expect(res.status).toBe(401);
  });

  it("rejects a different officer with 403 (owner-only)", async () => {
    const id = await insertAwaitingEntry();
    const res = await request(app)
      .post(`/api/time-entries/${id}/confirm`)
      .set(authed(ctx.otherOfficerToken))
      .send({});
    expect(res.status).toBe(403);
  });

  it("rejects even the admin when not the owner (403)", async () => {
    const id = await insertAwaitingEntry();
    const res = await request(app)
      .post(`/api/time-entries/${id}/confirm`)
      .set(authed(ctx.adminToken))
      .send({});
    expect(res.status).toBe(403);
  });

  it("409s when the entry is not awaiting confirmation", async () => {
    const id = await insertAwaitingEntry({ confirmationStatus: null });
    const res = await request(app)
      .post(`/api/time-entries/${id}/confirm`)
      .set(authed(ctx.officerToken))
      .send({});
    expect(res.status).toBe(409);
  });

  it("404s on an unknown entry", async () => {
    const res = await request(app)
      .post(`/api/time-entries/${randomUUID()}/confirm`)
      .set(authed(ctx.officerToken))
      .send({});
    expect(res.status).toBe(404);
  });

  it("confirms as-is: no edit flag, times unchanged, confirmedAt stamped", async () => {
    const id = await insertAwaitingEntry();
    const res = await request(app)
      .post(`/api/time-entries/${id}/confirm`)
      .set(authed(ctx.officerToken))
      .send({});
    expect(res.status).toBe(200);
    const row = await getEntry(id);
    expect(row.confirmationStatus).toBe("confirmed");
    expect(row.confirmedAt).not.toBeNull();
    expect(row.employeeEdited).toBe(false);
    expect(row.clockInTime.getTime()).toBe(BASE_CLOCK_IN.getTime());
    expect(row.clockOutTime!.getTime()).toBe(BASE_CLOCK_OUT.getTime());
    expect(row.lastEditedAt).toBeNull();
  });

  it("requires an editReason when times are changed (400)", async () => {
    const id = await insertAwaitingEntry();
    const res = await request(app)
      .post(`/api/time-entries/${id}/confirm`)
      .set(authed(ctx.officerToken))
      .send({ clockOutTime: new Date(BASE_CLOCK_OUT.getTime() + 30 * 60_000).toISOString() });
    expect(res.status).toBe(400);
  });

  it("rejects clock-out <= clock-in (400)", async () => {
    const id = await insertAwaitingEntry();
    const res = await request(app)
      .post(`/api/time-entries/${id}/confirm`)
      .set(authed(ctx.officerToken))
      .send({
        clockOutTime: new Date(BASE_CLOCK_IN.getTime() - 60_000).toISOString(),
        editReason: "wrong",
      });
    expect(res.status).toBe(400);
  });

  it("rejects future times (400)", async () => {
    const id = await insertAwaitingEntry();
    const res = await request(app)
      .post(`/api/time-entries/${id}/confirm`)
      .set(authed(ctx.officerToken))
      .send({
        clockOutTime: new Date(Date.now() + 60 * 60_000).toISOString(),
        editReason: "future",
      });
    expect(res.status).toBe(400);
  });

  it("rejects malformed timestamps (400)", async () => {
    const id = await insertAwaitingEntry();
    const res = await request(app)
      .post(`/api/time-entries/${id}/confirm`)
      .set(authed(ctx.officerToken))
      .send({ clockInTime: "not-a-date", editReason: "x" });
    expect(res.status).toBe(400);
  });

  it("applies an edit: flags employeeEdited, recomputes hours, keeps originals, stamps provenance", async () => {
    const id = await insertAwaitingEntry();
    const newOut = new Date(BASE_CLOCK_OUT.getTime() + 60 * 60_000); // +1h → 5h total
    const res = await request(app)
      .post(`/api/time-entries/${id}/confirm`)
      .set(authed(ctx.officerToken))
      .send({ clockOutTime: newOut.toISOString(), editReason: "  Relieved late  " });
    expect(res.status).toBe(200);

    const row = await getEntry(id);
    expect(row.confirmationStatus).toBe("confirmed");
    expect(row.employeeEdited).toBe(true);
    expect(row.employeeEditReason).toBe("Relieved late");
    expect(row.clockOutTime!.getTime()).toBe(newOut.getTime());
    expect(Number(row.hoursWorked)).toBeCloseTo(5, 2);
    // Snapshot of what the clock recorded is preserved for approvers.
    expect(row.originalClockOutTime!.getTime()).toBe(BASE_CLOCK_OUT.getTime());
    // Standard edit provenance.
    expect(row.lastEditedByUserId).toBe(ctx.officerId);
    expect(row.lastEditedAt).not.toBeNull();
    expect(row.syncSource).toBe("local");
  });

  it("rejects a clock-out moved beyond the default 2h window (400 with limit)", async () => {
    const id = await insertAwaitingEntry();
    const res = await request(app)
      .post(`/api/time-entries/${id}/confirm`)
      .set(authed(ctx.officerToken))
      .send({
        clockOutTime: new Date(BASE_CLOCK_OUT.getTime() + 2 * 3_600_000 + 60_000).toISOString(),
        editReason: "way late",
      });
    expect(res.status).toBe(400);
    expect(res.body.maxEditWindowHours).toBe(2);
    expect(res.body.message).toContain("2 hours");
    const row = await getEntry(id);
    expect(row.confirmationStatus).toBe("awaiting_confirmation");
    expect(row.employeeEdited).toBe(false);
  });

  it("rejects a clock-in moved beyond the window even when clock-out is fine (400)", async () => {
    const id = await insertAwaitingEntry();
    const res = await request(app)
      .post(`/api/time-entries/${id}/confirm`)
      .set(authed(ctx.officerToken))
      .send({
        clockInTime: new Date(BASE_CLOCK_IN.getTime() - 3 * 3_600_000).toISOString(),
        editReason: "started way earlier",
      });
    expect(res.status).toBe(400);
    expect(res.body.maxEditWindowHours).toBe(2);
  });

  it("allows an edit exactly at the window boundary (2h)", async () => {
    const id = await insertAwaitingEntry();
    const newOut = new Date(BASE_CLOCK_OUT.getTime() + 2 * 3_600_000);
    const res = await request(app)
      .post(`/api/time-entries/${id}/confirm`)
      .set(authed(ctx.officerToken))
      .send({ clockOutTime: newOut.toISOString(), editReason: "relieved 2h late" });
    expect(res.status).toBe(200);
    const row = await getEntry(id);
    expect(row.clockOutTime!.getTime()).toBe(newOut.getTime());
    expect(row.employeeEdited).toBe(true);
  });

  it("honors TIME_CONFIRM_EDIT_WINDOW_HOURS override", async () => {
    const prev = process.env.TIME_CONFIRM_EDIT_WINDOW_HOURS;
    process.env.TIME_CONFIRM_EDIT_WINDOW_HOURS = "0.5";
    try {
      // 45 min move: fine under the 2h default, rejected under a 0.5h cap.
      const id = await insertAwaitingEntry();
      const res = await request(app)
        .post(`/api/time-entries/${id}/confirm`)
        .set(authed(ctx.officerToken))
        .send({
          clockOutTime: new Date(BASE_CLOCK_OUT.getTime() + 45 * 60_000).toISOString(),
          editReason: "left late",
        });
      expect(res.status).toBe(400);
      expect(res.body.maxEditWindowHours).toBe(0.5);
      expect(res.body.message).toContain("30 minutes");

      // 20 min move passes under the tightened cap.
      const id2 = await insertAwaitingEntry();
      const res2 = await request(app)
        .post(`/api/time-entries/${id2}/confirm`)
        .set(authed(ctx.officerToken))
        .send({
          clockOutTime: new Date(BASE_CLOCK_OUT.getTime() + 20 * 60_000).toISOString(),
          editReason: "left a bit late",
        });
      expect(res2.status).toBe(200);
    } finally {
      if (prev === undefined) delete process.env.TIME_CONFIRM_EDIT_WINDOW_HOURS;
      else process.env.TIME_CONFIRM_EDIT_WINDOW_HOURS = prev;
    }
  });

  it("falls back to the 2h default on an invalid override value", async () => {
    const prev = process.env.TIME_CONFIRM_EDIT_WINDOW_HOURS;
    process.env.TIME_CONFIRM_EDIT_WINDOW_HOURS = "banana";
    try {
      const id = await insertAwaitingEntry();
      const res = await request(app)
        .post(`/api/time-entries/${id}/confirm`)
        .set(authed(ctx.officerToken))
        .send({
          clockOutTime: new Date(BASE_CLOCK_OUT.getTime() + 90 * 60_000).toISOString(),
          editReason: "late",
        });
      expect(res.status).toBe(200); // 1.5h is inside the 2h default
    } finally {
      if (prev === undefined) delete process.env.TIME_CONFIRM_EDIT_WINDOW_HOURS;
      else process.env.TIME_CONFIRM_EDIT_WINDOW_HOURS = prev;
    }
  });

  it("second confirm attempt 409s (already confirmed)", async () => {
    const id = await insertAwaitingEntry();
    await request(app).post(`/api/time-entries/${id}/confirm`).set(authed(ctx.officerToken)).send({});
    const res = await request(app)
      .post(`/api/time-entries/${id}/confirm`)
      .set(authed(ctx.officerToken))
      .send({});
    expect(res.status).toBe(409);
  });
});

describe("admin actions force-clear awaiting", () => {
  it("admin approval of an unconfirmed entry clears awaiting", async () => {
    const id = await insertAwaitingEntry();
    const res = await request(app)
      .post(`/api/time-entries/${id}/approve`)
      .set(authed(ctx.adminToken))
      .send({ decision: "approved", hoursWorked: 4 });
    expect(res.status).toBe(200);
    const row = await getEntry(id);
    expect(row.approvalStatus).toBe("approved");
    expect(row.confirmationStatus).toBe("confirmed");
  });

  it("admin time correction (PATCH /times) on an unconfirmed entry clears awaiting", async () => {
    const id = await insertAwaitingEntry();
    const res = await request(app)
      .patch(`/api/time-entries/${id}/times`)
      .set(authed(ctx.adminToken))
      .send({ clockOutTime: new Date(BASE_CLOCK_OUT.getTime() + 30 * 60_000).toISOString() });
    expect(res.status).toBe(200);
    const row = await getEntry(id);
    expect(row.confirmationStatus).toBe("confirmed");
  });
});
