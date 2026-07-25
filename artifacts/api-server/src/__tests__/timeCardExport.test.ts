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

const TAG = `tcexport-test-${randomUUID().slice(0, 8)}`;
const passwordHash = bcrypt.hashSync("test-password", 4);

type Ctx = {
  adminId: string;
  officerId: string;
  otherOfficerId: string;
  adminToken: string;
  officerToken: string;
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

// Fixed instants well inside a single business week (a Tuesday), far in the
// past so rows never collide with real/seed data.
const WEEK_ANCHOR = "2025-03-04"; // Tuesday — resolves to the week of Mon 2025-03-03
const IN_1 = new Date("2025-03-04T14:00:00.000Z");
const OUT_1 = new Date("2025-03-04T18:00:00.000Z"); // 4h approved
const IN_2 = new Date("2025-03-05T14:30:00.000Z");
const OUT_2 = new Date("2025-03-05T17:45:00.000Z"); // 3.25h pending
const IN_3 = new Date("2025-03-06T14:00:00.000Z");
const OUT_3 = new Date("2025-03-06T16:00:00.000Z"); // 2h rejected — excluded from totals

async function insertEntry(opts: {
  clockIn: Date;
  clockOut: Date | null;
  hours: string | null;
  approvalStatus: "pending" | "approved" | "rejected";
}): Promise<string> {
  const [row] = await db
    .insert(timeEntriesTable)
    .values({
      shiftId: ctx.shiftId,
      siteId: ctx.siteId,
      employeeId: ctx.officerId,
      clockInTime: opts.clockIn,
      clockOutTime: opts.clockOut,
      hoursWorked: opts.hours,
      approvalStatus: opts.approvalStatus,
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
      address: "1 Export Way",
      defaultBillRate: "50.00",
    })
    .returning({ id: sitesTable.id });
  ctx.siteId = site.id;

  const [shift] = await db
    .insert(shiftsTable)
    .values({
      siteId: ctx.siteId,
      title: `${TAG}-shift`,
      startTime: IN_1,
      endTime: OUT_1,
      payRate: "20.00",
      billRate: "40.00",
      headcount: 1,
    })
    .returning({ id: shiftsTable.id });
  ctx.shiftId = shift.id;

  await insertEntry({ clockIn: IN_1, clockOut: OUT_1, hours: "4.00", approvalStatus: "approved" });
  await insertEntry({ clockIn: IN_2, clockOut: OUT_2, hours: "3.25", approvalStatus: "pending" });
  await insertEntry({ clockIn: IN_3, clockOut: OUT_3, hours: "2.00", approvalStatus: "rejected" });
});

afterAll(async () => {
  await db.execute(sql`DELETE FROM time_entries WHERE employee_id = ${ctx.officerId}::uuid`);
  await db.execute(sql`DELETE FROM shifts WHERE site_id = ${ctx.siteId}::uuid`);
  await db.execute(sql`DELETE FROM sites WHERE id = ${ctx.siteId}::uuid`);
  await db.execute(sql`DELETE FROM clients WHERE id = ${ctx.clientId}::uuid`);
  await db.execute(sql`DELETE FROM users WHERE last_name = ${TAG}`);
});

function authed(token: string) {
  return { Authorization: `Bearer ${token}` };
}

function csvSummaryValue(csv: string, label: string): string | null {
  const line = csv.split("\n").find((l) => l.startsWith(`${label},`));
  return line ? line.slice(label.length + 1) : null;
}

describe("GET /time-entries/time-card/export", () => {
  it("CSV totals equal the JSON route's totals for the same week", async () => {
    const jsonRes = await request(app)
      .get("/api/time-entries/time-card")
      .query({ employeeId: ctx.officerId, weekStart: WEEK_ANCHOR })
      .set(authed(ctx.adminToken));
    expect(jsonRes.status).toBe(200);
    const json = jsonRes.body as { totalHours: number; approvedHours: number; pendingHours: number };
    // Sanity: our fixture entries actually landed in this week.
    expect(json.totalHours).toBeGreaterThan(0);

    const csvRes = await request(app)
      .get("/api/time-entries/time-card/export")
      .query({ employeeId: ctx.officerId, weekStart: WEEK_ANCHOR, format: "csv" })
      .set(authed(ctx.adminToken));
    expect(csvRes.status).toBe(200);
    expect(csvRes.headers["content-type"]).toContain("text/csv");
    expect(csvRes.headers["content-disposition"]).toContain("attachment");
    expect(csvRes.headers["content-disposition"]).toContain(".csv");

    const csv = csvRes.text;
    expect(csvSummaryValue(csv, "Week total hours")).toBe(json.totalHours.toFixed(2));
    expect(csvSummaryValue(csv, "Approved hours")).toBe(json.approvedHours.toFixed(2));
    expect(csvSummaryValue(csv, "Pending hours")).toBe(json.pendingHours.toFixed(2));

    // Rejected entries appear as rows but are excluded from totals:
    // approved(4.00) + pending(3.25) = 7.25, rejected(2.00) not counted.
    expect(json.totalHours).toBe(7.25);
    expect(json.approvedHours).toBe(4);
    expect(json.pendingHours).toBe(3.25);
    expect(csv).toContain("Rejected");
  });

  it("400s on a bad format", async () => {
    const res = await request(app)
      .get("/api/time-entries/time-card/export")
      .query({ weekStart: WEEK_ANCHOR, format: "xlsx" })
      .set(authed(ctx.officerToken));
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/format must be pdf or csv/i);
  });

  it("400s when format is missing", async () => {
    const res = await request(app)
      .get("/api/time-entries/time-card/export")
      .query({ weekStart: WEEK_ANCHOR })
      .set(authed(ctx.officerToken));
    expect(res.status).toBe(400);
  });

  it("400s on a malformed weekStart", async () => {
    const res = await request(app)
      .get("/api/time-entries/time-card/export")
      .query({ weekStart: "03/04/2025", format: "csv" })
      .set(authed(ctx.officerToken));
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/weekStart/i);
  });

  it("officer gets 403 exporting another employee's card", async () => {
    const res = await request(app)
      .get("/api/time-entries/time-card/export")
      .query({ employeeId: ctx.otherOfficerId, weekStart: WEEK_ANCHOR, format: "csv" })
      .set(authed(ctx.officerToken));
    expect(res.status).toBe(403);
  });

  it("officer gets 200 exporting their own card (explicit employeeId and default self)", async () => {
    const explicit = await request(app)
      .get("/api/time-entries/time-card/export")
      .query({ employeeId: ctx.officerId, weekStart: WEEK_ANCHOR, format: "csv" })
      .set(authed(ctx.officerToken));
    expect(explicit.status).toBe(200);
    expect(csvSummaryValue(explicit.text, "Week total hours")).toBe("7.25");

    const self = await request(app)
      .get("/api/time-entries/time-card/export")
      .query({ weekStart: WEEK_ANCHOR, format: "csv" })
      .set(authed(ctx.officerToken));
    expect(self.status).toBe(200);
    expect(self.text).toBe(explicit.text);
  });

  it("admin can export any employee's card as PDF", async () => {
    const res = await request(app)
      .get("/api/time-entries/time-card/export")
      .query({ employeeId: ctx.officerId, weekStart: WEEK_ANCHOR, format: "pdf" })
      .set(authed(ctx.adminToken))
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on("data", (c: Buffer) => chunks.push(c));
        r.on("end", () => cb(null, Buffer.concat(chunks)));
      });
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("application/pdf");
    expect((res.body as Buffer).subarray(0, 5).toString()).toBe("%PDF-");
  });

  it("404s on an unknown employee", async () => {
    const res = await request(app)
      .get("/api/time-entries/time-card/export")
      .query({ employeeId: randomUUID(), weekStart: WEEK_ANCHOR, format: "csv" })
      .set(authed(ctx.adminToken));
    expect(res.status).toBe(404);
  });

  it("401s without a token", async () => {
    const res = await request(app)
      .get("/api/time-entries/time-card/export")
      .query({ weekStart: WEEK_ANCHOR, format: "csv" });
    expect(res.status).toBe(401);
  });
});
