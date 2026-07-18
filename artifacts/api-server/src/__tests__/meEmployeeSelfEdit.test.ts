import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { sql } from "drizzle-orm";
import { db, usersTable, employeesTable } from "@workspace/db";
import app from "../app";
import { signToken } from "../middlewares/auth";

// PATCH /me/employee is the officer self-service profile edit used by the
// mobile app. It widened its writable allow-list to include all personal
// fields (DOB, city/state of birth, SSN last 4, right-to-work status, tax
// code, direct-deposit consent). Because this is a PII allow-list on a
// self-edit boundary, this suite pins three security-relevant invariants:
//   1. the new fields persist (the feature works),
//   2. the body stays a STRICT allow-list (no over-posting of admin-only
//      fields like hourlyRate),
//   3. the compliance/financial fields (niNumber, rightToWorkStatus,
//      directDepositConsent) fire the same-day HR alert, while a benign
//      personal-field change does not.
const TAG = `me-employee-test-${randomUUID().slice(0, 8)}`;
const passwordHash = bcrypt.hashSync("test-password", 4);

type Ctx = {
  primaryId: string;
  primaryToken: string;
  benignId: string;
  benignToken: string;
};
const ctx = {} as Ctx;

async function makeOfficer(suffix: string): Promise<string> {
  const email = `${TAG}-${suffix}-${randomUUID().slice(0, 6)}@example.test`;
  const [row] = await db
    .insert(usersTable)
    .values({
      email,
      passwordHash,
      firstName: "Officer",
      lastName: TAG,
      role: "employee",
      status: "active",
      tokensValidAfter: new Date(0),
    })
    .returning({ id: usersTable.id });
  // Minimal employee row — personal fields start null/unset so the PATCH
  // under test is an unambiguous null -> value transition.
  await db.insert(employeesTable).values({ userId: row.id, position: "officer" });
  return row.id;
}

beforeAll(async () => {
  ctx.primaryId = await makeOfficer("primary");
  ctx.benignId = await makeOfficer("benign");
  ctx.primaryToken = signToken({
    userId: ctx.primaryId,
    email: `${TAG}-primary@example.test`,
    role: "employee",
  });
  ctx.benignToken = signToken({
    userId: ctx.benignId,
    email: `${TAG}-benign@example.test`,
    role: "employee",
  });
});

afterAll(async () => {
  // high_risk_change_queue + employee_changes cascade on the user row; the
  // high-risk enqueue is fire-and-forget, so settle briefly before deleting
  // the users to avoid a late background insert hitting a missing FK.
  await new Promise((r) => setTimeout(r, 250));
  const ids = [ctx.primaryId, ctx.benignId].filter(Boolean);
  if (ids.length > 0) {
    const arr = sql.raw(`ARRAY['${ids.join("','")}']::uuid[]`);
    await db.execute(sql`DELETE FROM employees WHERE user_id = ANY(${arr})`);
  }
  await db.execute(sql`DELETE FROM users WHERE last_name = ${TAG}`);
});

function authed(token: string) {
  return { Authorization: `Bearer ${token}` };
}

describe("PATCH /me/employee — personal-field self-edit", () => {
  it("persists all newly editable personal fields and flags the 3 high-risk ones", async () => {
    const res = await request(app)
      .patch("/api/me/employee")
      .set(authed(ctx.primaryToken))
      .send({
        dateOfBirth: "1990-05-15",
        cityOfBirth: "Dallas",
        stateOfBirth: "TX",
        niNumber: "1234",
        rightToWorkStatus: "US Citizen",
        taxCode: "TX01",
        directDepositConsent: true,
      });
    expect(res.status).toBe(200);
    expect(res.body.dateOfBirth).toBe("1990-05-15");
    expect(res.body.cityOfBirth).toBe("Dallas");
    expect(res.body.stateOfBirth).toBe("TX");
    expect(res.body.niNumber).toBe("1234");
    expect(res.body.rightToWorkStatus).toBe("US Citizen");
    expect(res.body.taxCode).toBe("TX01");
    expect(res.body.directDepositConsent).toBe(true);
    // The compliance/financial fields fire the same-day HR re-verification
    // alert; the benign personal fields (DOB, city, state, tax code) do not.
    expect(res.body.hrNotified).toBe(true);
    expect([...res.body.hrNotifiedFields].sort()).toEqual(
      ["directDepositConsent", "niNumber", "rightToWorkStatus"].sort(),
    );
  });

  it("rejects an over-posted admin-only field (strict allow-list)", async () => {
    const res = await request(app)
      .patch("/api/me/employee")
      .set(authed(ctx.primaryToken))
      .send({ hourlyRate: "999.00" });
    expect(res.status).toBe(400);
    // The injected field must not have been written.
    const [row] = await db
      .select({ hourlyRate: employeesTable.hourlyRate })
      .from(employeesTable)
      .where(sql`${employeesTable.userId} = ${ctx.primaryId}`);
    expect(row?.hourlyRate ?? null).toBeNull();
  });

  it("rejects an impossible date of birth with 400", async () => {
    const res = await request(app)
      .patch("/api/me/employee")
      .set(authed(ctx.primaryToken))
      .send({ dateOfBirth: "2026-02-30" });
    expect(res.status).toBe(400);
  });

  it("clears the date of birth when sent empty", async () => {
    const res = await request(app)
      .patch("/api/me/employee")
      .set(authed(ctx.primaryToken))
      .send({ dateOfBirth: "" });
    expect(res.status).toBe(200);
    expect(res.body.dateOfBirth).toBeNull();
  });

  it("does NOT alert HR for a benign personal-only change", async () => {
    const res = await request(app)
      .patch("/api/me/employee")
      .set(authed(ctx.benignToken))
      .send({ cityOfBirth: "Austin", stateOfBirth: "TX" });
    expect(res.status).toBe(200);
    expect(res.body.cityOfBirth).toBe("Austin");
    expect(res.body.hrNotified).toBe(false);
    expect(res.body.hrNotifiedFields).toEqual([]);
  });
});
