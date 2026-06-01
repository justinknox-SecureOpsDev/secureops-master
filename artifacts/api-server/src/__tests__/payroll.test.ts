import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { sql, eq, inArray } from "drizzle-orm";
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

// Tagged so we can scope cleanup precisely and not trample seed data.
const TAG = `payroll-test-${randomUUID().slice(0, 8)}`;
const passwordHash = bcrypt.hashSync("test-password", 4);

type Ctx = {
  adminId: string;
  bankedEmployeeId: string;   // has bank info + direct-deposit consent
  unbankedEmployeeId: string; // intentionally missing bank info => warnings
  adminToken: string;
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

// Monday of the previous ISO week, UTC. Picking a closed past week
// keeps any future scheduling logic from mutating our fixture data.
function previousMondayISO(): string {
  const d = new Date();
  const day = d.getUTCDay();           // 0=Sun…6=Sat
  const back = day === 0 ? 13 : 6 + day; // jump back to *last* Mon
  d.setUTCDate(d.getUTCDate() - back);
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString().slice(0, 10);
}

beforeAll(async () => {
  ctx.adminId = await makeUser("admin", "admin");
  ctx.bankedEmployeeId = await makeUser("employee", "banked");
  ctx.unbankedEmployeeId = await makeUser("employee", "unbanked");
  ctx.adminToken = signToken({
    userId: ctx.adminId,
    email: `${TAG}-admin@example.test`,
    role: "admin",
  });

  // Banked employee: full bank info + direct-deposit consent on file.
  // /payroll/pay-run/preview should yield zero warnings for this row.
  await db.insert(employeesTable).values({
    userId: ctx.bankedEmployeeId,
    bankAccountName: "Officer Banked",
    bankAccountNumber: "1234567890",
    bankBsb: "021000021",
    directDepositConsent: true,
    hourlyRate: "25.00",
  });
  // Unbanked employee: deliberately missing bank fields so the preview
  // emits "Missing …" warnings AND the export-csv route refuses to
  // include this row in the payable batch.
  await db.insert(employeesTable).values({
    userId: ctx.unbankedEmployeeId,
    directDepositConsent: false,
    hourlyRate: "25.00",
  });

  const [client] = await db
    .insert(clientsTable)
    .values({ name: `${TAG}-client`, paymentTermsDays: 14 })
    .returning({ id: clientsTable.id });
  ctx.clientId = client.id;

  const [site] = await db
    .insert(sitesTable)
    .values({ clientId: ctx.clientId, name: `${TAG}-site`, address: "100 Pay Way" })
    .returning({ id: sitesTable.id });
  ctx.siteId = site.id;

  // One past-week shift with a known payRate. Time entries reference
  // this shift so /payroll/generate can compute totals deterministically.
  const periodStartISO = previousMondayISO();
  const periodStart = new Date(`${periodStartISO}T00:00:00.000Z`);
  const shiftStart = new Date(periodStart.getTime() + 2 * 24 * 60 * 60 * 1000 + 9 * 60 * 60 * 1000);
  const shiftEnd = new Date(shiftStart.getTime() + 8 * 60 * 60 * 1000);
  const [shift] = await db
    .insert(shiftsTable)
    .values({
      title: `${TAG}-shift`,
      siteId: ctx.siteId,
      startTime: shiftStart,
      endTime: shiftEnd,
      requiredLicenseLevel: 2,
      headcount: 2,
      status: "completed",
      payRate: "25.00",
      billRate: "45.00",
    })
    .returning({ id: shiftsTable.id });
  ctx.shiftId = shift.id;

  // Closed + approved time entries for both employees, 8 hours each.
  // /payroll/generate filters strictly on approvalStatus='approved' and
  // a clockInTime inside [weekStart, weekStart+7).
  for (const empId of [ctx.bankedEmployeeId, ctx.unbankedEmployeeId]) {
    await db.insert(timeEntriesTable).values({
      shiftId: ctx.shiftId,
      employeeId: empId,
      siteId: ctx.siteId,
      clockInTime: shiftStart,
      clockOutTime: shiftEnd,
      hoursWorked: "8.00",
      approvalStatus: "approved",
    });
  }
});

afterAll(async () => {
  const ids = [ctx.adminId, ctx.bankedEmployeeId, ctx.unbankedEmployeeId].filter(Boolean);
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

describe("Pay Run lifecycle (pending → processed → paid)", () => {
  it("walks the full lifecycle and is idempotent on re-runs", async () => {
    const weekStart = previousMondayISO();

    // ----- Step 0: generate payroll entries from approved time -----
    const gen = await request(app)
      .post("/api/payroll/generate")
      .set(authed(ctx.adminToken))
      .send({ siteId: ctx.siteId, weekStart });
    expect(gen.status).toBe(201);
    expect(Array.isArray(gen.body)).toBe(true);
    expect(gen.body.length).toBeGreaterThanOrEqual(2);

    const byEmployee = new Map<string, { id: string; status: string }>(
      gen.body.map((r: { id: string; employeeId: string; status: string }) => [
        r.employeeId,
        { id: r.id, status: r.status },
      ]),
    );
    const bankedEntryId = byEmployee.get(ctx.bankedEmployeeId)?.id;
    const unbankedEntryId = byEmployee.get(ctx.unbankedEmployeeId)?.id;
    expect(bankedEntryId, "banked employee got a payroll row").toBeTruthy();
    expect(unbankedEntryId, "unbanked employee got a payroll row").toBeTruthy();
    const ids = [bankedEntryId!, unbankedEntryId!];

    // ----- Step 1: preview surfaces warnings + counts -----
    const preview = await request(app)
      .post("/api/payroll/pay-run/preview")
      .set(authed(ctx.adminToken))
      .send({ ids });
    expect(preview.status).toBe(200);
    expect(preview.body.counts.total).toBe(2);
    expect(preview.body.counts.payable).toBe(1);        // banked only
    expect(preview.body.counts.withWarnings).toBe(1);   // unbanked
    expect(preview.body.counts.alreadyPaid).toBe(0);

    type PreviewRow = { id: string; warnings: string[] };
    const bankedPreview = preview.body.rows.find((r: PreviewRow) => r.id === bankedEntryId);
    const unbankedPreview = preview.body.rows.find((r: PreviewRow) => r.id === unbankedEntryId);
    expect(bankedPreview.warnings).toEqual([]);
    expect(unbankedPreview.warnings.length).toBeGreaterThan(0);
    expect(unbankedPreview.warnings.some((w: string) => /bank account number/i.test(w))).toBe(true);
    expect(unbankedPreview.warnings.some((w: string) => /direct-deposit/i.test(w))).toBe(true);

    // ----- Step 2: export CSV flips banked row pending → processed -----
    const batchRef = `${TAG}-BATCH`;
    const csv1 = await request(app)
      .post("/api/payroll/pay-run/export-csv")
      .set(authed(ctx.adminToken))
      .send({ ids, batchReference: batchRef });
    expect(csv1.status).toBe(200);
    expect(csv1.headers["content-type"]).toMatch(/text\/csv/);
    expect(csv1.headers["x-pay-run-batch"]).toBe(batchRef);
    expect(csv1.headers["x-pay-run-count"]).toBe("1"); // only banked is payable
    expect(csv1.headers["x-pay-run-skipped"]).toBe("1"); // unbanked skipped
    expect(csv1.text).toMatch(/Employee Name,Account Name,Routing Number/);
    expect(csv1.text).toMatch(/Officer Banked/);
    // Bookkeeping flipped on the payable row only.
    const afterExport = await db
      .select({
        id: payrollEntriesTable.id,
        status: payrollEntriesTable.status,
        paidMethod: payrollEntriesTable.paidMethod,
        paymentReference: payrollEntriesTable.paymentReference,
        paidBy: payrollEntriesTable.paidBy,
      })
      .from(payrollEntriesTable)
      .where(inArray(payrollEntriesTable.id, ids));
    const bankedRow = afterExport.find((r) => r.id === bankedEntryId)!;
    const unbankedRow = afterExport.find((r) => r.id === unbankedEntryId)!;
    expect(bankedRow.status).toBe("processed");
    expect(bankedRow.paidMethod).toBe("ach_csv");
    expect(bankedRow.paymentReference).toBe(batchRef);
    expect(bankedRow.paidBy).toBe(ctx.adminId);
    expect(unbankedRow.status).toBe("pending"); // untouched

    // ----- Step 3: re-export is idempotent (no second processing) -----
    // Re-exporting the same ids finds nothing payable: the banked row is
    // already `processed` (excluded so we never emit a duplicate payment
    // line) and the unbanked row still carries warnings. The route refuses
    // with 400, and crucially the banked row's batchReference / status must
    // remain exactly as the first export left them.
    const csv2 = await request(app)
      .post("/api/payroll/pay-run/export-csv")
      .set(authed(ctx.adminToken))
      .send({ ids, batchReference: `${TAG}-SECOND` });
    expect(csv2.status).toBe(400);
    const [stillProcessed] = await db
      .select({
        status: payrollEntriesTable.status,
        paymentReference: payrollEntriesTable.paymentReference,
      })
      .from(payrollEntriesTable)
      .where(eq(payrollEntriesTable.id, bankedEntryId!));
    expect(stillProcessed.status).toBe("processed");
    expect(stillProcessed.paymentReference).toBe(batchRef); // not overwritten

    // ----- Step 4: mark-paid flips processed → paid -----
    const markPaid = await request(app)
      .post("/api/payroll/pay-run/mark-paid")
      .set(authed(ctx.adminToken))
      .send({ ids: [bankedEntryId], paymentReference: "BANK-CONFIRM-001", method: "ach_csv" });
    expect(markPaid.status).toBe(200);
    expect(markPaid.body.marked).toBe(1);
    expect(markPaid.body.skipped).toBe(0);
    expect(markPaid.body.ids).toContain(bankedEntryId);

    const [paidRow] = await db
      .select({
        status: payrollEntriesTable.status,
        paidAt: payrollEntriesTable.paidAt,
        paymentReference: payrollEntriesTable.paymentReference,
        paidMethod: payrollEntriesTable.paidMethod,
      })
      .from(payrollEntriesTable)
      .where(eq(payrollEntriesTable.id, bankedEntryId!));
    expect(paidRow.status).toBe("paid");
    expect(paidRow.paidAt).toBeInstanceOf(Date);
    expect(paidRow.paymentReference).toBe("BANK-CONFIRM-001");
    expect(paidRow.paidMethod).toBe("ach_csv");

    // ----- Step 5: mark-paid is idempotent on already-paid rows -----
    const markPaidAgain = await request(app)
      .post("/api/payroll/pay-run/mark-paid")
      .set(authed(ctx.adminToken))
      .send({ ids: [bankedEntryId], method: "manual" });
    expect(markPaidAgain.status).toBe(200);
    expect(markPaidAgain.body.marked).toBe(0);
    expect(markPaidAgain.body.skipped).toBe(1);
  });
});
