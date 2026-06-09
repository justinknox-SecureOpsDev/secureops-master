import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { sql } from "drizzle-orm";
import { db, usersTable } from "@workspace/db";
import app from "../app";
import { signToken } from "../middlewares/auth";

// Payment-discrepancy submission is an officer-facing complaint flow:
// internal staff/officers (employee/lead/admin) may file and read their OWN
// reports; external `client` portal accounts must be refused. These boundaries
// have no other automated coverage, so this suite pins them.
const TAG = `pay-disc-test-${randomUUID().slice(0, 8)}`;
const passwordHash = bcrypt.hashSync("test-password", 4);

type Ctx = {
  officerId: string;
  clientId: string;
  officerToken: string;
  clientToken: string;
};
const ctx = {} as Ctx;

async function makeUser(role: string, suffix: string): Promise<{ id: string; email: string }> {
  const email = `${TAG}-${suffix}-${randomUUID().slice(0, 6)}@example.test`;
  const [row] = await db
    .insert(usersTable)
    .values({
      email,
      passwordHash,
      firstName: "Test",
      lastName: TAG,
      role,
      status: "active",
      tokensValidAfter: new Date(0),
    })
    .returning({ id: usersTable.id });
  return { id: row!.id, email };
}

beforeAll(async () => {
  const officer = await makeUser("employee", "officer");
  const client = await makeUser("client", "client");
  ctx.officerId = officer.id;
  ctx.clientId = client.id;
  ctx.officerToken = signToken({ userId: officer.id, email: officer.email, role: "employee" });
  ctx.clientToken = signToken({ userId: client.id, email: client.email, role: "client" });
});

afterAll(async () => {
  const ids = [ctx.officerId, ctx.clientId].filter(Boolean);
  if (ids.length > 0) {
    const arr = sql.raw(`ARRAY['${ids.join("','")}']::uuid[]`);
    await db.execute(sql`DELETE FROM payment_discrepancies WHERE employee_id = ANY(${arr})`);
  }
  await db.execute(sql`DELETE FROM users WHERE last_name = ${TAG}`);
});

function authed(token: string) {
  return { Authorization: `Bearer ${token}` };
}

describe("POST /payment-discrepancies", () => {
  it("lets an officer submit a report and pins it to the caller", async () => {
    const res = await request(app)
      .post("/api/payment-discrepancies")
      .set(authed(ctx.officerToken))
      .send({
        discrepancyType: "underpaid",
        shiftDate: "2026-06-01",
        payPeriodStart: "2026-05-25",
        payPeriodEnd: "2026-05-31",
        expectedAmount: 300,
        receivedAmount: 250.5,
        description: "Paid for 8 hours but worked 10.",
      });
    expect(res.status).toBe(201);
    expect(res.body.employeeId).toBe(ctx.officerId);
    expect(res.body.discrepancyType).toBe("underpaid");
    expect(res.body.status).toBe("open");
    // pg `date` columns round-trip as YYYY-MM-DD strings (no off-by-one).
    expect(res.body.shiftDate).toBe("2026-06-01");
    expect(res.body.payPeriodStart).toBe("2026-05-25");
    // numeric columns round-trip as decimal strings.
    expect(res.body.expectedAmount).toBe("300.00");
    expect(res.body.receivedAmount).toBe("250.50");
  });

  it("rejects a missing description (400)", async () => {
    const res = await request(app)
      .post("/api/payment-discrepancies")
      .set(authed(ctx.officerToken))
      .send({ discrepancyType: "other" });
    expect(res.status).toBe(400);
  });

  it("forbids an external client account from submitting (403)", async () => {
    const res = await request(app)
      .post("/api/payment-discrepancies")
      .set(authed(ctx.clientToken))
      .send({ discrepancyType: "other", description: "should be blocked" });
    expect(res.status).toBe(403);
  });

  it("requires authentication (401)", async () => {
    const res = await request(app)
      .post("/api/payment-discrepancies")
      .send({ discrepancyType: "other", description: "no token" });
    expect(res.status).toBe(401);
  });
});

describe("GET /me/payment-discrepancies", () => {
  it("returns only the caller's own reports", async () => {
    await request(app)
      .post("/api/payment-discrepancies")
      .set(authed(ctx.officerToken))
      .send({ discrepancyType: "missing_hours", description: "Second report." })
      .expect(201);

    const res = await request(app)
      .get("/api/me/payment-discrepancies")
      .set(authed(ctx.officerToken));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThanOrEqual(2);
    for (const row of res.body as Array<Record<string, unknown>>) {
      expect(row.employeeId).toBe(ctx.officerId);
    }
  });

  it("forbids an external client account (403)", async () => {
    const res = await request(app)
      .get("/api/me/payment-discrepancies")
      .set(authed(ctx.clientToken));
    expect(res.status).toBe(403);
  });
});
