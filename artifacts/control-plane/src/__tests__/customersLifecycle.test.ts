/**
 * Trial/Paid lifecycle transition semantics on the customer registry.
 *
 * `converted_at` must only move on an ACTUAL stored-status transition — never
 * whenever a client happens to resend the current `lifecycleStatus` value
 * (e.g. editing an already-Paid customer's contact info or notes). Otherwise
 * the conversion date silently drifts every time someone touches an unrelated
 * field, which defeats the whole point of recording it.
 *
 * Exercises the real Express app + a live Postgres connection (ensureSchema
 * is idempotent) so the SQL itself — not just a mocked query call — is
 * verified.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import app from "../app";
import { pool, ensureSchema, seedInitialCustomers } from "../db";
import { issueOperatorToken } from "../auth";

const token = issueOperatorToken();
const authHeader = `Bearer ${token}`;
const orgCode = `test-lifecycle-${Date.now()}`;
let customerId: string;

beforeAll(async () => {
  await ensureSchema();
});

afterAll(async () => {
  if (customerId) {
    await pool.query(`DELETE FROM control_plane_customers WHERE id = $1`, [customerId]);
  }
});

describe("customer lifecycle status transitions", () => {
  it("defaults a newly created customer to trial with no conversion date", async () => {
    const res = await request(app)
      .post("/api/customers")
      .set("Authorization", authHeader)
      .send({ orgCode, name: "Lifecycle Test Co", apiBaseUrl: "https://lifecycle-test.example.com" });
    expect(res.status).toBe(201);
    expect(res.body.customer.lifecycleStatus).toBe("trial");
    expect(res.body.customer.convertedAt).toBeNull();
    customerId = res.body.customer.id;
  });

  it("stamps converted_at on the trial -> paid transition", async () => {
    const before = Date.now();
    const res = await request(app)
      .put(`/api/customers/${customerId}`)
      .set("Authorization", authHeader)
      .send({ lifecycleStatus: "paid" });
    expect(res.status).toBe(200);
    expect(res.body.customer.lifecycleStatus).toBe("paid");
    expect(res.body.customer.convertedAt).not.toBeNull();
    expect(new Date(res.body.customer.convertedAt).getTime()).toBeGreaterThanOrEqual(before);
  });

  it("does NOT re-stamp converted_at when an already-paid customer is edited", async () => {
    const paidAt = (
      await request(app).get("/api/customers").set("Authorization", authHeader)
    ).body.customers.find((c: { id: string }) => c.id === customerId).convertedAt;

    // Wait past millisecond precision, then edit an unrelated field while
    // resending the (unchanged) current lifecycleStatus — the way the fleet
    // console's edit form always does.
    await new Promise((r) => setTimeout(r, 20));
    const res = await request(app)
      .put(`/api/customers/${customerId}`)
      .set("Authorization", authHeader)
      .send({ notes: "unrelated edit", lifecycleStatus: "paid" });

    expect(res.status).toBe(200);
    expect(res.body.customer.lifecycleStatus).toBe("paid");
    expect(res.body.customer.notes).toBe("unrelated edit");
    expect(res.body.customer.convertedAt).toBe(paidAt);
  });

  it("clears converted_at on the paid -> trial transition", async () => {
    const res = await request(app)
      .put(`/api/customers/${customerId}`)
      .set("Authorization", authHeader)
      .send({ lifecycleStatus: "trial" });
    expect(res.status).toBe(200);
    expect(res.body.customer.lifecycleStatus).toBe("trial");
    expect(res.body.customer.convertedAt).toBeNull();
  });

  it("stamps a FRESH converted_at on a later trial -> paid re-conversion", async () => {
    const res = await request(app)
      .put(`/api/customers/${customerId}`)
      .set("Authorization", authHeader)
      .send({ lifecycleStatus: "paid" });
    expect(res.status).toBe(200);
    expect(res.body.customer.lifecycleStatus).toBe("paid");
    expect(res.body.customer.convertedAt).not.toBeNull();
  });
});

describe("seedInitialCustomers", () => {
  it("registers Quell Protection in trial status, and is idempotent", async () => {
    await seedInitialCustomers();
    await seedInitialCustomers(); // must not throw / duplicate on a second boot

    const res = await request(app).get("/api/customers").set("Authorization", authHeader);
    const quell = res.body.customers.filter((c: { orgCode: string }) => c.orgCode === "quell");
    expect(quell).toHaveLength(1);
    expect(quell[0].lifecycleStatus).toBe("trial");
    expect(quell[0].convertedAt).toBeNull();
    expect(quell[0].name).toBe("Quell Protection");
  });
});
