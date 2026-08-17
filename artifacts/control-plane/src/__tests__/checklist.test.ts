/**
 * Onboarding checklist — API behaviour.
 *
 * Verifies that:
 * - A new customer gets 11 checklist steps seeded automatically on POST /customers.
 * - GET /customers includes per-customer checklistProgress (0/11 initially).
 * - GET /customers/:id/checklist returns all steps in order, all undone.
 * - PUT /customers/:id/checklist/:stepKey marks a step done (stamps done_at).
 * - Toggling the same step back to undone clears done_at.
 * - An unknown step key returns 404.
 * - All checklist endpoints require an operator JWT.
 *
 * Uses the real Express app + a live Postgres connection (ensureSchema is
 * idempotent) so the SQL itself is verified, not just mocked query calls.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import app from "../app";
import { pool, ensureSchema, ONBOARDING_STEPS } from "../db";
import { issueOperatorToken } from "../auth";

const token = issueOperatorToken();
const auth = `Bearer ${token}`;
const orgCode = `test-checklist-${Date.now()}`;
let customerId: string;

beforeAll(async () => {
  await ensureSchema();
  const res = await request(app)
    .post("/api/customers")
    .set("Authorization", auth)
    .send({ orgCode, name: "Checklist Test Co", apiBaseUrl: "https://checklist-test.example.com" });
  expect(res.status).toBe(201);
  customerId = res.body.customer.id;
});

afterAll(async () => {
  if (customerId) {
    // CASCADE deletes checklist rows too.
    await pool.query(`DELETE FROM control_plane_customers WHERE id = $1`, [customerId]);
  }
});

describe("checklist seeding on customer create", () => {
  it("seeds all runbook steps on POST /customers", async () => {
    const res = await request(app)
      .get(`/api/customers/${customerId}/checklist`)
      .set("Authorization", auth);
    expect(res.status).toBe(200);
    const { checklist } = res.body as {
      checklist: { stepKey: string; stepLabel: string; stepOrder: number; isDone: boolean; doneAt: string | null }[];
    };
    expect(checklist).toHaveLength(ONBOARDING_STEPS.length);
    // Verify ordering and default state.
    checklist.forEach((step, i) => {
      expect(step.stepOrder).toBe(i + 1);
      expect(step.isDone).toBe(false);
      expect(step.doneAt).toBeNull();
    });
    // Every defined step key is present.
    const keys = checklist.map((s) => s.stepKey);
    for (const s of ONBOARDING_STEPS) {
      expect(keys).toContain(s.key);
    }
  });

  it("includes checklistProgress 0/N in the customer list response", async () => {
    const res = await request(app).get("/api/customers").set("Authorization", auth);
    expect(res.status).toBe(200);
    const customer = (res.body.customers as { id: string; checklistProgress: { done: number; total: number } | null }[]).find(
      (c) => c.id === customerId,
    );
    expect(customer).toBeTruthy();
    expect(customer!.checklistProgress).toMatchObject({
      done: 0,
      total: ONBOARDING_STEPS.length,
    });
  });
});

describe("checklist toggle", () => {
  const firstStep = ONBOARDING_STEPS[0].key;

  it("marks a step done and stamps done_at", async () => {
    const before = Date.now();
    const res = await request(app)
      .put(`/api/customers/${customerId}/checklist/${firstStep}`)
      .set("Authorization", auth)
      .send({ isDone: true });
    expect(res.status).toBe(200);
    expect(res.body.step.isDone).toBe(true);
    expect(res.body.step.doneAt).not.toBeNull();
    expect(new Date(res.body.step.doneAt).getTime()).toBeGreaterThanOrEqual(before);
  });

  it("reflects the new done count in the customer list", async () => {
    const res = await request(app).get("/api/customers").set("Authorization", auth);
    const customer = (
      res.body.customers as { id: string; checklistProgress: { done: number; total: number } }[]
    ).find((c) => c.id === customerId);
    expect(customer!.checklistProgress.done).toBe(1);
    expect(customer!.checklistProgress.total).toBe(ONBOARDING_STEPS.length);
  });

  it("marks a step undone and clears done_at", async () => {
    const res = await request(app)
      .put(`/api/customers/${customerId}/checklist/${firstStep}`)
      .set("Authorization", auth)
      .send({ isDone: false });
    expect(res.status).toBe(200);
    expect(res.body.step.isDone).toBe(false);
    expect(res.body.step.doneAt).toBeNull();
  });

  it("returns 404 for an unknown step key", async () => {
    const res = await request(app)
      .put(`/api/customers/${customerId}/checklist/no_such_step`)
      .set("Authorization", auth)
      .send({ isDone: true });
    expect(res.status).toBe(404);
  });

  it("returns 400 when the request body is invalid", async () => {
    const res = await request(app)
      .put(`/api/customers/${customerId}/checklist/${firstStep}`)
      .set("Authorization", auth)
      .send({ isDone: "yes" });
    expect(res.status).toBe(400);
  });
});

describe("checklist auth", () => {
  it("GET /customers/:id/checklist requires a valid JWT", async () => {
    const res = await request(app).get(`/api/customers/${customerId}/checklist`);
    expect(res.status).toBe(401);
  });

  it("PUT /customers/:id/checklist/:stepKey requires a valid JWT", async () => {
    const res = await request(app)
      .put(`/api/customers/${customerId}/checklist/${ONBOARDING_STEPS[0].key}`)
      .send({ isDone: true });
    expect(res.status).toBe(401);
  });
});
