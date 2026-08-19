import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { sql, eq, and } from "drizzle-orm";
import {
  db,
  usersTable,
  employeesTable,
  clientsTable,
  sitesTable,
  shiftsTable,
  timeEntriesTable,
  payrollEntriesTable,
} from "@workspace/db";
import app from "../app";
import { signToken } from "../middlewares/auth";

const TAG = `archive-test-${randomUUID().slice(0, 8)}`;
const passwordHash = bcrypt.hashSync("test-password", 4);

type Ctx = {
  adminId: string;
  employeeId: string;
  officerId: string; // archivable current-week bucket
  paidOfficerId: string; // bucket already paid — must never archive
  adminToken: string;
  employeeToken: string;
  clientId: string;
  siteId: string;
  periodStart: string;
  archivedEntryId: string; // set by the happy-path test
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
      // Payroll board/list is company-owner gated (Task #733) — the admin
      // fixture here is exercising ordinary admin payroll behavior, so it
      // needs the owner flag exactly as the rollout backfill would grant it.
      isCompanyOwner: role === "admin",
    })
    .returning({ id: usersTable.id });
  return row.id;
}

function previousMondayISO(): string {
  const d = new Date();
  const day = d.getUTCDay();
  const back = day === 0 ? 13 : 6 + day;
  d.setUTCDate(d.getUTCDate() - back);
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString().slice(0, 10);
}

async function makeApprovedEntry(officerId: string, titleSuffix: string, shiftStart: Date, shiftEnd: Date, payRate: string) {
  const [shift] = await db
    .insert(shiftsTable)
    .values({
      title: `${TAG}-${titleSuffix}`,
      siteId: ctx.siteId,
      startTime: shiftStart,
      endTime: shiftEnd,
      requiredLicenseLevel: 2,
      headcount: 1,
      status: "completed",
      payRate,
    })
    .returning({ id: shiftsTable.id });
  await db.insert(timeEntriesTable).values({
    shiftId: shift.id,
    employeeId: officerId,
    siteId: ctx.siteId,
    clockInTime: shiftStart,
    clockOutTime: shiftEnd,
    hoursWorked: "4.00",
    approvalStatus: "approved",
  });
}

beforeAll(async () => {
  ctx.adminId = await makeUser("admin", "admin");
  ctx.employeeId = await makeUser("employee", "emp");
  ctx.officerId = await makeUser("employee", "officer");
  ctx.paidOfficerId = await makeUser("employee", "paid-officer");
  ctx.adminToken = signToken({ userId: ctx.adminId, email: `${TAG}-admin@example.test`, role: "admin" });
  ctx.employeeToken = signToken({ userId: ctx.employeeId, email: `${TAG}-emp@example.test`, role: "employee" });

  await db.insert(employeesTable).values({ userId: ctx.officerId, directDepositConsent: false });
  await db.insert(employeesTable).values({ userId: ctx.paidOfficerId, directDepositConsent: false });

  const [client] = await db
    .insert(clientsTable)
    .values({ name: `${TAG}-client` })
    .returning({ id: clientsTable.id });
  ctx.clientId = client.id;

  const [site] = await db
    .insert(sitesTable)
    .values({ clientId: ctx.clientId, name: `${TAG}-site`, address: "100 Archive Way" })
    .returning({ id: sitesTable.id });
  ctx.siteId = site.id;

  ctx.periodStart = previousMondayISO();
  const periodStartDate = new Date(`${ctx.periodStart}T00:00:00.000Z`);
  const shiftStart = new Date(periodStartDate.getTime() + 2 * 86400_000 + 9 * 3600_000);
  const shiftEnd = new Date(shiftStart.getTime() + 4 * 3600_000);

  // Bucket 1: officer with a plain approved entry — the archive target.
  await makeApprovedEntry(ctx.officerId, "archivable-shift", shiftStart, shiftEnd, "25.00");

  // Bucket 2: another officer, same site/week, but their payroll_entry is
  // already "paid" — archive must skip it.
  await makeApprovedEntry(ctx.paidOfficerId, "paid-shift", shiftStart, shiftEnd, "25.00");
  await db.insert(payrollEntriesTable).values({
    employeeId: ctx.paidOfficerId,
    siteId: ctx.siteId,
    periodStart: ctx.periodStart,
    periodEnd: new Date(periodStartDate.getTime() + 6 * 86400_000).toISOString().slice(0, 10),
    totalHours: "4.00",
    hourlyRate: "25.00",
    grossPay: "100.00",
    netPay: "100.00",
    status: "paid",
  });
});

afterAll(async () => {
  const ids = [ctx.adminId, ctx.employeeId, ctx.officerId, ctx.paidOfficerId].filter(Boolean);
  if (ids.length > 0) {
    const arr = sql.raw(`ARRAY['${ids.join("','")}']::uuid[]`);
    await db.execute(sql`DELETE FROM payroll_entries WHERE employee_id = ANY(${arr})`);
    await db.execute(sql`DELETE FROM time_entries WHERE employee_id = ANY(${arr})`);
    await db.execute(sql`DELETE FROM employees WHERE user_id = ANY(${arr})`);
  }
  await db.execute(sql`DELETE FROM shifts WHERE title LIKE ${TAG + "%"}`);
  await db.execute(sql`DELETE FROM sites WHERE name LIKE ${TAG + "%"}`);
  await db.execute(sql`DELETE FROM clients WHERE name LIKE ${TAG + "%"}`);
  await db.execute(sql`DELETE FROM users WHERE last_name = ${TAG}`);
});

function authed(token: string) {
  return { Authorization: `Bearer ${token}` };
}

describe("POST /payroll/board/archive", () => {
  it("archives an eligible bucket and skips a paid one", async () => {
    const res = await request(app)
      .post("/api/payroll/board/archive")
      .set(authed(ctx.adminToken))
      .send({
        reason: "duplicate entries",
        selections: [
          { employeeId: ctx.officerId, siteId: ctx.siteId, periodStart: ctx.periodStart },
          { employeeId: ctx.paidOfficerId, siteId: ctx.siteId, periodStart: ctx.periodStart },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.archivedCount).toBe(1);
    expect(res.body.payrollEntryIds).toHaveLength(1);
    ctx.archivedEntryId = res.body.payrollEntryIds[0];

    type Skip = { employeeId: string; reason: string };
    const skipped: Skip[] = res.body.skipped;
    const paidSkip = skipped.find((s) => s.employeeId === ctx.paidOfficerId);
    expect(paidSkip?.reason).toMatch(/already paid/i);

    // The archived row carries the snapshot + archive trail; net = gross (1099).
    const [row] = await db
      .select({
        status: payrollEntriesTable.status,
        archivedAt: payrollEntriesTable.archivedAt,
        archivedBy: payrollEntriesTable.archivedBy,
        archiveReason: payrollEntriesTable.archiveReason,
        grossPay: payrollEntriesTable.grossPay,
        netPay: payrollEntriesTable.netPay,
        tax: payrollEntriesTable.tax,
      })
      .from(payrollEntriesTable)
      .where(eq(payrollEntriesTable.id, ctx.archivedEntryId));
    expect(row.status).toBe("archived");
    expect(row.archivedAt).not.toBeNull();
    expect(row.archivedBy).toBe(ctx.adminId);
    expect(row.archiveReason).toBe("duplicate entries");
    expect(parseFloat(String(row.grossPay))).toBe(100);
    expect(parseFloat(String(row.netPay))).toBe(100);
    expect(parseFloat(String(row.tax))).toBe(0);
  });

  it("removes the archived bucket from the working board and lists it in the archived view", async () => {
    const board = await request(app)
      .get("/api/payroll/board?statusFilter=all")
      .set(authed(ctx.adminToken));
    expect(board.status).toBe(200);
    const workingBuckets = (board.body.groups as Array<{ buckets: Array<{ employeeId: string }> }>)
      .flatMap((g) => g.buckets);
    expect(workingBuckets.some((b) => b.employeeId === ctx.officerId)).toBe(false);

    const archived = await request(app)
      .get("/api/payroll/board?statusFilter=archived")
      .set(authed(ctx.adminToken));
    expect(archived.status).toBe(200);
    type ArchBucket = { employeeId: string; existingStatus: string; archivedByEmail: string | null; archiveReason: string | null };
    const archBuckets = (archived.body.groups as Array<{ status: string; buckets: ArchBucket[] }>);
    const mine = archBuckets.flatMap((g) => g.buckets).find((b) => b.employeeId === ctx.officerId);
    expect(mine).toBeDefined();
    expect(mine!.existingStatus).toBe("archived");
    expect(mine!.archivedByEmail).toBe(`${TAG}-admin@example.test`);
    expect(mine!.archiveReason).toBe("duplicate entries");
  });

  it("refuses to process an archived bucket", async () => {
    const res = await request(app)
      .post("/api/payroll/board/process")
      .set(authed(ctx.adminToken))
      .send({
        mode: "manual",
        selections: [{ employeeId: ctx.officerId, siteId: ctx.siteId, periodStart: ctx.periodStart }],
      });
    // The archived bucket is filtered out of the board buckets entirely, so
    // the process route sees no matching bucket (409 vanished).
    expect(res.status).toBe(409);
  });

  it("excludes the archived week from the officer's paystubs", async () => {
    const officerToken = signToken({
      userId: ctx.officerId,
      email: `${TAG}-officer@example.test`,
      role: "employee",
    });
    const res = await request(app)
      .get("/api/me/payroll")
      .set(authed(officerToken));
    expect(res.status).toBe(200);
    const rows = res.body.entries ?? res.body.rows ?? res.body;
    const list = Array.isArray(rows) ? rows : [];
    expect(list.some((r: { id?: string }) => r.id === ctx.archivedEntryId)).toBe(false);
  });

  it("blocks non-admin employees (403)", async () => {
    const res = await request(app)
      .post("/api/payroll/board/archive")
      .set(authed(ctx.employeeToken))
      .send({
        selections: [{ employeeId: ctx.officerId, siteId: ctx.siteId, periodStart: ctx.periodStart }],
      });
    expect(res.status).toBe(403);
  });
});

describe("POST /payroll/board/unarchive", () => {
  it("restores the archived row to pending and clears the archive trail", async () => {
    const res = await request(app)
      .post("/api/payroll/board/unarchive")
      .set(authed(ctx.adminToken))
      .send({ ids: [ctx.archivedEntryId] });
    expect(res.status).toBe(200);
    expect(res.body.restoredCount).toBe(1);

    const [row] = await db
      .select({
        status: payrollEntriesTable.status,
        archivedAt: payrollEntriesTable.archivedAt,
        archivedBy: payrollEntriesTable.archivedBy,
        archiveReason: payrollEntriesTable.archiveReason,
      })
      .from(payrollEntriesTable)
      .where(eq(payrollEntriesTable.id, ctx.archivedEntryId));
    expect(row.status).toBe("pending");
    expect(row.archivedAt).toBeNull();
    expect(row.archivedBy).toBeNull();
    expect(row.archiveReason).toBeNull();

    // Back on the working board.
    const board = await request(app)
      .get("/api/payroll/board?statusFilter=all")
      .set(authed(ctx.adminToken));
    const workingBuckets = (board.body.groups as Array<{ buckets: Array<{ employeeId: string }> }>)
      .flatMap((g) => g.buckets);
    expect(workingBuckets.some((b) => b.employeeId === ctx.officerId)).toBe(true);
  });

  it("409s when nothing in the list is archived", async () => {
    const res = await request(app)
      .post("/api/payroll/board/unarchive")
      .set(authed(ctx.adminToken))
      .send({ ids: [ctx.archivedEntryId] }); // already restored above
    expect(res.status).toBe(409);
  });

  it("blocks non-admin employees (403)", async () => {
    const res = await request(app)
      .post("/api/payroll/board/unarchive")
      .set(authed(ctx.employeeToken))
      .send({ ids: [randomUUID()] });
    expect(res.status).toBe(403);
  });
});

describe("POST /payroll/generate vs archived snapshots", () => {
  it("does not overwrite an archived row's snapshot totals", async () => {
    // Re-archive the bucket (it was restored to pending above).
    const arch = await request(app)
      .post("/api/payroll/board/archive")
      .set(authed(ctx.adminToken))
      .send({
        selections: [{ employeeId: ctx.officerId, siteId: ctx.siteId, periodStart: ctx.periodStart }],
      });
    expect(arch.status).toBe(200);
    const entryId: string = arch.body.payrollEntryIds[0];

    // Poison the snapshot with a sentinel value so an overwrite is detectable
    // (generate would recompute the same 100.00 otherwise).
    await db
      .update(payrollEntriesTable)
      .set({ grossPay: "55.55", netPay: "55.55", totalHours: "1.11" })
      .where(eq(payrollEntriesTable.id, entryId));

    const gen = await request(app)
      .post("/api/payroll/generate")
      .set(authed(ctx.adminToken))
      .send({ siteId: ctx.siteId, weekStart: ctx.periodStart });
    expect(gen.status).toBe(201);
    // Neither the archived officer nor the paid officer may appear in the
    // response — their rows were skipped, not rewritten.
    const returned = (gen.body as Array<{ employeeId: string }>).map((r) => r.employeeId);
    expect(returned).not.toContain(ctx.officerId);
    expect(returned).not.toContain(ctx.paidOfficerId);

    const [row] = await db
      .select({
        status: payrollEntriesTable.status,
        grossPay: payrollEntriesTable.grossPay,
        totalHours: payrollEntriesTable.totalHours,
      })
      .from(payrollEntriesTable)
      .where(eq(payrollEntriesTable.id, entryId));
    expect(row.status).toBe("archived");
    expect(String(row.grossPay)).toBe("55.55");
    expect(String(row.totalHours)).toBe("1.11");

    // Paid row untouched too.
    const [paidRow] = await db
      .select({ status: payrollEntriesTable.status, grossPay: payrollEntriesTable.grossPay })
      .from(payrollEntriesTable)
      .where(and(
        eq(payrollEntriesTable.employeeId, ctx.paidOfficerId),
        eq(payrollEntriesTable.periodStart, ctx.periodStart),
      ));
    expect(paidRow.status).toBe("paid");
    expect(String(paidRow.grossPay)).toBe("100.00");
  });
});
