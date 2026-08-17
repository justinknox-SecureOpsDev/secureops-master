/**
 * Checklist preservation across customer delete + re-create.
 *
 * When an operator deletes a customer and re-adds it with the same org code
 * (e.g. to fix a typo in the URL), the previously checked-off onboarding
 * steps must survive — no manual re-ticking required.
 *
 * Verifies:
 * - DELETE /customers/:id archives done steps and returns checklistProgress.
 * - POST /customers with a previously-used org code restores the done steps.
 * - Steps that were NOT done start unchecked on the new record (no ghost ticks).
 * - The archive survives multiple delete→re-create cycles (steps accumulate).
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import app from "../app";
import { pool, ONBOARDING_STEPS } from "../db";
import { issueOperatorToken } from "../auth";

const auth = `Bearer ${issueOperatorToken()}`;
// Unique org code for this test run so parallel suites don't collide.
const orgCode = `test-preservation-${Date.now()}`;
const basePayload = {
  orgCode,
  name: "Preservation Test Co",
  apiBaseUrl: "https://preservation-test.example.com",
};

let customerId: string;

beforeAll(async () => {
  // Clean up any leftover rows from a previous run (idempotent).
  await pool.query(
    `DELETE FROM control_plane_customers WHERE org_code = $1`,
    [orgCode],
  );
  await pool.query(
    `DELETE FROM control_plane_checklist_archive WHERE org_code = $1`,
    [orgCode],
  );
});

afterAll(async () => {
  // Best-effort cleanup — doesn't matter if a test already deleted the row.
  if (customerId) {
    await pool.query(`DELETE FROM control_plane_customers WHERE id = $1`, [customerId]);
  }
  await pool.query(
    `DELETE FROM control_plane_checklist_archive WHERE org_code = $1`,
    [orgCode],
  );
});

describe("checklist preservation on delete + re-create", () => {
  const stepA = ONBOARDING_STEPS[0].key;
  const stepB = ONBOARDING_STEPS[1].key;

  it("creates a customer and marks two steps done", async () => {
    const res = await request(app)
      .post("/api/customers")
      .set("Authorization", auth)
      .send(basePayload);
    expect(res.status).toBe(201);
    customerId = res.body.customer.id;

    for (const step of [stepA, stepB]) {
      const toggle = await request(app)
        .put(`/api/customers/${customerId}/checklist/${step}`)
        .set("Authorization", auth)
        .send({ isDone: true });
      expect(toggle.status).toBe(200);
    }
  });

  it("DELETE returns checklistProgress with the done count", async () => {
    const res = await request(app)
      .delete(`/api/customers/${customerId}`)
      .set("Authorization", auth);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.checklistProgress).toMatchObject({
      done: 2,
      total: ONBOARDING_STEPS.length,
    });
    customerId = ""; // mark as deleted so afterAll doesn't double-delete
  });

  it("re-creating with the same org code restores the two done steps", async () => {
    const res = await request(app)
      .post("/api/customers")
      .set("Authorization", auth)
      .send(basePayload);
    expect(res.status).toBe(201);
    customerId = res.body.customer.id;

    // The fleet list should immediately show the restored progress.
    expect(res.body.customer.checklistProgress).toMatchObject({
      done: 2,
      total: ONBOARDING_STEPS.length,
    });
  });

  it("the checklist detail shows the correct done/undone split", async () => {
    const res = await request(app)
      .get(`/api/customers/${customerId}/checklist`)
      .set("Authorization", auth);
    expect(res.status).toBe(200);
    const { checklist } = res.body as {
      checklist: { stepKey: string; isDone: boolean; doneAt: string | null }[];
    };

    const doneKeys = checklist.filter((s) => s.isDone).map((s) => s.stepKey);
    expect(doneKeys).toContain(stepA);
    expect(doneKeys).toContain(stepB);

    // Steps that were never checked off must stay undone.
    const undoneKeys = checklist.filter((s) => !s.isDone).map((s) => s.stepKey);
    expect(undoneKeys.length).toBe(ONBOARDING_STEPS.length - 2);

    // Done steps have a non-null doneAt preserved from the archive.
    for (const step of checklist.filter((s) => [stepA, stepB].includes(s.stepKey))) {
      expect(step.doneAt).not.toBeNull();
    }
  });

  it("a step that was un-done before deletion is NOT restored on re-create", async () => {
    // Un-do stepA on the current record.
    const undo = await request(app)
      .put(`/api/customers/${customerId}/checklist/${stepA}`)
      .set("Authorization", auth)
      .send({ isDone: false });
    expect(undo.status).toBe(200);
    expect(undo.body.step.isDone).toBe(false);

    // Delete (snapshot = only stepB done now).
    const del = await request(app)
      .delete(`/api/customers/${customerId}`)
      .set("Authorization", auth);
    expect(del.status).toBe(200);
    expect(del.body.checklistProgress.done).toBe(1); // only stepB
    customerId = "";

    // Re-create.
    const res = await request(app)
      .post("/api/customers")
      .set("Authorization", auth)
      .send(basePayload);
    expect(res.status).toBe(201);
    customerId = res.body.customer.id;

    // Only stepB should be restored — stepA was explicitly un-done.
    const list = await request(app)
      .get(`/api/customers/${customerId}/checklist`)
      .set("Authorization", auth);
    const checklist = list.body.checklist as { stepKey: string; isDone: boolean }[];
    const stepARow = checklist.find((s) => s.stepKey === stepA);
    const stepBRow = checklist.find((s) => s.stepKey === stepB);
    expect(stepARow?.isDone).toBe(false);
    expect(stepBRow?.isDone).toBe(true);
  });

  it("a second delete + re-create cycle still preserves progress", async () => {
    // Delete again.
    const del = await request(app)
      .delete(`/api/customers/${customerId}`)
      .set("Authorization", auth);
    expect(del.status).toBe(200);
    customerId = "";

    // Re-add a third time.
    const res = await request(app)
      .post("/api/customers")
      .set("Authorization", auth)
      .send(basePayload);
    expect(res.status).toBe(201);
    customerId = res.body.customer.id;
    // Only stepB survives (stepA was un-done in the previous cycle).
    expect(res.body.customer.checklistProgress?.done).toBe(1);
  });

  it("returns 404 when deleting an already-deleted customer", async () => {
    const res = await request(app)
      .delete(`/api/customers/does-not-exist-${Date.now()}`)
      .set("Authorization", auth);
    expect(res.status).toBe(404);
  });
});
