/**
 * An interrupted assistant write is never applied twice — and never leaves the
 * person guessing.
 *
 * The assistant carries out an approved action by calling this server's own
 * HTTP route as the signed-in user. If that request is interrupted after it
 * was sent, the write may already have committed, and re-sending a route that
 * is not idempotent would double-book a shift or double-approve payroll.
 *
 * An idempotency key removes that dilemma. The route records its outcome
 * against the key, so a re-send either replays what already committed or
 * performs the work for the first time. This suite proves both halves:
 *
 *   1. The routes honour the key — same key, one write, replayed answer; a
 *      different key or a different user is a different write.
 *   2. The assistant uses it — a dispatch interrupted AFTER the route
 *      committed comes back as a definite "done", with exactly one shift, one
 *      assignment and one approval to show for it.
 *
 * And the honesty contract still holds at the end of the rope: when even the
 * reconciling re-send is lost, the answer is still "I cannot tell you", and
 * still nothing was duplicated.
 *
 * The interruption is real, not mocked at the dispatcher: global fetch is
 * wrapped so the first write goes all the way to the route, commits, and then
 * loses its answer exactly as a dropped socket would.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { and, eq, sql } from "drizzle-orm";
import {
  db,
  usersTable,
  clientsTable,
  sitesTable,
  shiftsTable,
  shiftAssignmentsTable,
  timeEntriesTable,
  auditLogsTable,
  idempotencyKeysTable,
} from "@workspace/db";
import app from "../app";
import { signToken } from "../middlewares/auth";
import { stagePendingAction, clearPendingActionsForTests } from "../lib/assistant/pendingActions";
import { closeInternalDispatch } from "../lib/assistant/internalDispatch";
import {
  clearIdempotencyStoreForTests,
  resetIdempotencyLimitsForTests,
  setIdempotencyLimitsForTests,
  simulateProcessRestartForTests,
  idempotencyScopeHash,
  IDEMPOTENT_REPLAY_HEADER,
} from "../lib/idempotency";

const TAG = `assistant-idem-${randomUUID().slice(0, 8)}`;

type Actor = { id: string; email: string; token: string };

async function mkAdmin(label: string): Promise<Actor> {
  const email = `${TAG}-${label}@example.test`;
  const [row] = await db
    .insert(usersTable)
    .values({
      email,
      passwordHash: bcrypt.hashSync("test-password", 4),
      firstName: label,
      lastName: TAG,
      role: "admin",
      status: "active",
      tokensValidAfter: new Date(0),
    })
    .returning({ id: usersTable.id });
  return { id: row.id, email, token: signToken({ userId: row.id, email, role: "admin" }) };
}

/**
 * Let the next matching write reach the route and commit, then throw the
 * answer away — the caller is left in exactly the state this task is about.
 *
 * The thrown error deliberately carries no ECONNREFUSED/ENOTFOUND code, so
 * `classifyDispatchFailure` cannot rule out that the write landed. That is the
 * "unknown outcome" branch, and the one a retry has to be safe for.
 *
 * @param times how many sends to swallow (1 = only the first).
 * @param betweenSends runs after the answer is lost and before the retry — the
 *   hook the capacity test uses to put the store under pressure at the one
 *   moment the recorded outcome must survive.
 */
function loseTheAnswerFor(
  pathFragment: string,
  times = 1,
  betweenSends?: () => Promise<void>,
): { lost: () => number } {
  const real = globalThis.fetch;
  let lost = 0;
  const stub = (async (input: Parameters<typeof real>[0], init?: Parameters<typeof real>[1]) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : String(input);
    const method = String(init?.method ?? "GET").toUpperCase();
    if (lost < times && method === "POST" && url.includes(pathFragment)) {
      lost += 1;
      // The route runs for real and commits...
      const res = await real(input, init);
      await res.text().catch(() => undefined);
      if (betweenSends) await betweenSends();
      // ...and then the answer never gets back to us.
      const err = new TypeError("fetch failed");
      (err as { cause?: unknown }).cause = { code: "UND_ERR_SOCKET" };
      throw err;
    }
    return real(input, init);
  }) as typeof fetch;
  vi.stubGlobal("fetch", stub);
  return { lost: () => lost };
}

let admin: Actor;
let otherAdmin: Actor;
let officerId = "";
let siteId = "";
let rosterShiftId = "";
let entryId = "";

beforeAll(async () => {
  admin = await mkAdmin("admin");
  otherAdmin = await mkAdmin("admin2");

  const [officer] = await db
    .insert(usersTable)
    .values({
      email: `${TAG}-officer@example.test`,
      passwordHash: bcrypt.hashSync("test-password", 4),
      firstName: "officer",
      lastName: TAG,
      role: "employee",
      status: "active",
      tokensValidAfter: new Date(0),
    })
    .returning({ id: usersTable.id });
  officerId = officer.id;

  const [c] = await db.insert(clientsTable).values({ name: `${TAG}-client` }).returning({ id: clientsTable.id });
  const [s] = await db
    .insert(sitesTable)
    .values({
      clientId: c.id,
      name: `${TAG}-site`,
      status: "active",
      defaultPayRate: "20.00",
      defaultBillRate: "35.00",
    })
    .returning({ id: sitesTable.id });
  siteId = s.id;

  const start = new Date(Date.now() + 6 * 24 * 60 * 60 * 1000);
  const [shift] = await db
    .insert(shiftsTable)
    .values({
      title: `${TAG}-roster-shift`,
      siteId,
      startTime: start,
      endTime: new Date(start.getTime() + 8 * 3600_000),
      payRate: "20.00",
      billRate: "35.00",
      headcount: 2,
      requiredLicenseLevel: 1,
    })
    .returning({ id: shiftsTable.id });
  rosterShiftId = shift.id;

  const clockIn = new Date(Date.now() - 10 * 3600_000);
  const [te] = await db
    .insert(timeEntriesTable)
    .values({
      employeeId: officerId,
      siteId,
      clockInTime: clockIn,
      clockOutTime: new Date(clockIn.getTime() + 8 * 3600_000),
      hoursWorked: "8.00",
      approvalStatus: "pending",
    })
    .returning({ id: timeEntriesTable.id });
  entryId = te.id;

  clearPendingActionsForTests();
  await clearIdempotencyStoreForTests();
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetIdempotencyLimitsForTests();
});

afterAll(async () => {
  await closeInternalDispatch();
  // Approval kicks off a best-effort invoice roll-up. Let it land before the
  // site it points at is deleted.
  await new Promise((r) => setTimeout(r, 500));
  await db.execute(sql`DELETE FROM audit_logs WHERE actor_user_id IN (SELECT id FROM users WHERE last_name = ${TAG})`);
  await db.execute(sql`DELETE FROM shift_assignments WHERE shift_id IN (SELECT id FROM shifts WHERE title LIKE ${`${TAG}%`})`);
  await db.execute(sql`DELETE FROM time_entries WHERE employee_id IN (SELECT id FROM users WHERE last_name = ${TAG})`);
  await db.execute(sql`DELETE FROM invoices WHERE site_id IN (SELECT id FROM sites WHERE name LIKE ${`${TAG}%`})`);
  await db.execute(sql`DELETE FROM shifts WHERE title LIKE ${`${TAG}%`}`);
  await db.execute(sql`DELETE FROM sites WHERE name LIKE ${`${TAG}%`}`);
  await db.execute(sql`DELETE FROM clients WHERE name LIKE ${`${TAG}%`}`);
  await db.execute(sql`DELETE FROM users WHERE last_name = ${TAG}`);
  await db.execute(sql`DELETE FROM idempotency_keys WHERE actor IN (${admin.id}, ${otherAdmin.id}, 'anonymous')`);
});

function shiftBody(title: string) {
  const start = new Date(Date.now() + 8 * 24 * 60 * 60 * 1000);
  return {
    title,
    siteId,
    startTime: start.toISOString(),
    endTime: new Date(start.getTime() + 6 * 3600_000).toISOString(),
    payRate: "20.00",
    billRate: "35.00",
    requiredLicenseLevel: 1,
    headcount: 1,
  };
}

async function countShifts(title: string): Promise<number> {
  const rows = await db.select({ id: shiftsTable.id }).from(shiftsTable).where(eq(shiftsTable.title, title));
  return rows.length;
}

// ── The routes honour the key ──────────────────────────────────────────────

describe("a write that carries an idempotency key", () => {
  it("performs the work once and replays the same answer to a re-send", async () => {
    const title = `${TAG}-replayed`;
    const key = `test-${randomUUID()}`;

    const first = await request(app)
      .post("/api/shifts")
      .set("Authorization", `Bearer ${admin.token}`)
      .set("Idempotency-Key", key)
      .send(shiftBody(title))
      .expect(201);

    const second = await request(app)
      .post("/api/shifts")
      .set("Authorization", `Bearer ${admin.token}`)
      .set("Idempotency-Key", key)
      .send(shiftBody(title))
      .expect(201);

    // Same answer, and the header says why: the route never ran again.
    expect(second.headers[IDEMPOTENT_REPLAY_HEADER]).toBe("true");
    expect(second.body.id).toBe(first.body.id);
    expect(first.headers[IDEMPOTENT_REPLAY_HEADER]).toBeUndefined();
    expect(await countShifts(title)).toBe(1);
  });

  it("treats a different key as a different write, so genuine repeats still work", async () => {
    const title = `${TAG}-two-keys`;
    await request(app)
      .post("/api/shifts")
      .set("Authorization", `Bearer ${admin.token}`)
      .set("Idempotency-Key", `test-${randomUUID()}`)
      .send(shiftBody(title))
      .expect(201);
    await request(app)
      .post("/api/shifts")
      .set("Authorization", `Bearer ${admin.token}`)
      .set("Idempotency-Key", `test-${randomUUID()}`)
      .send(shiftBody(title))
      .expect(201);

    expect(await countShifts(title)).toBe(2);
  });

  it("leaves callers that send no key exactly as they were", async () => {
    const title = `${TAG}-no-key`;
    await request(app)
      .post("/api/shifts")
      .set("Authorization", `Bearer ${admin.token}`)
      .send(shiftBody(title))
      .expect(201);
    await request(app)
      .post("/api/shifts")
      .set("Authorization", `Bearer ${admin.token}`)
      .send(shiftBody(title))
      .expect(201);

    expect(await countShifts(title)).toBe(2);
  });

  it("never lets one person's key replay another person's answer", async () => {
    const key = `test-${randomUUID()}`;
    const mine = await request(app)
      .post("/api/shifts")
      .set("Authorization", `Bearer ${admin.token}`)
      .set("Idempotency-Key", key)
      .send(shiftBody(`${TAG}-mine`))
      .expect(201);

    const theirs = await request(app)
      .post("/api/shifts")
      .set("Authorization", `Bearer ${otherAdmin.token}`)
      .set("Idempotency-Key", key)
      .send(shiftBody(`${TAG}-theirs`))
      .expect(201);

    expect(theirs.headers[IDEMPOTENT_REPLAY_HEADER]).toBeUndefined();
    expect(theirs.body.id).not.toBe(mine.body.id);
    expect(theirs.body.title).toBe(`${TAG}-theirs`);
  });

  it("refuses a new keyed write outright when no key can safely be retained", async () => {
    // Every retained key is either a write still running or an outcome still
    // replayable. With no room for another, the only two options are to run
    // the write without the protection it asked for, or not to run it. It must
    // not run it.
    await clearIdempotencyStoreForTests();
    setIdempotencyLimitsForTests({ maxEntries: 1 });

    await request(app)
      .post("/api/shifts")
      .set("Authorization", `Bearer ${admin.token}`)
      .set("Idempotency-Key", `test-${randomUUID()}`)
      .send(shiftBody(`${TAG}-fills-the-store`))
      .expect(201);

    const refused = await request(app)
      .post("/api/shifts")
      .set("Authorization", `Bearer ${admin.token}`)
      .set("Idempotency-Key", `test-${randomUUID()}`)
      .send(shiftBody(`${TAG}-refused`))
      .expect(503);

    expect(refused.body.message).toMatch(/nothing was changed/i);
    expect(await countShifts(`${TAG}-refused`)).toBe(0);
  });

  it("rejects a key too short to be unique rather than quietly ignoring it", async () => {
    const res = await request(app)
      .post("/api/shifts")
      .set("Authorization", `Bearer ${admin.token}`)
      .set("Idempotency-Key", "abc")
      .send(shiftBody(`${TAG}-short-key`))
      .expect(400);
    expect(res.body.message).toMatch(/idempotency key/i);
    expect(await countShifts(`${TAG}-short-key`)).toBe(0);
  });
});

// ── The assistant reconciles instead of shrugging ──────────────────────────

describe("an assistant action whose dispatch is interrupted after it committed", () => {
  it("creates exactly one shift and reports that it went through", async () => {
    const title = `${TAG}-interrupted-create`;
    const start = new Date(Date.now() + 9 * 24 * 60 * 60 * 1000);
    const staged = stagePendingAction({
      userId: admin.id,
      tool: "create_shift",
      args: {
        siteId,
        title,
        startTime: start.toISOString(),
        endTime: new Date(start.getTime() + 6 * 3600_000).toISOString(),
      },
      summary: "Create a shift.",
      details: [],
    });

    const interrupt = loseTheAnswerFor("/api/shifts");

    const res = await request(app)
      .post(`/api/assistant/actions/${staged.id}/approve`)
      .set("Authorization", `Bearer ${admin.token}`)
      .expect(200);

    expect(interrupt.lost()).toBe(1);
    expect(res.body.reconciled).toBe(true);
    // "Already gone through" is only said when the server recognised the key
    // and replayed — i.e. the route was not run a second time.
    expect(res.body.note).toMatch(/already gone through/i);
    expect(await countShifts(title)).toBe(1);
  });

  it("rosters the officer exactly once", async () => {
    const staged = stagePendingAction({
      userId: admin.id,
      tool: "assign_officer_to_shift",
      args: { shiftId: rosterShiftId, employeeId: officerId },
      summary: "Put the officer on the shift.",
      details: [],
    });

    const interrupt = loseTheAnswerFor(`/api/shifts/${rosterShiftId}/assignments`);

    const res = await request(app)
      .post(`/api/assistant/actions/${staged.id}/approve`)
      .set("Authorization", `Bearer ${admin.token}`)
      .expect(200);

    expect(interrupt.lost()).toBe(1);
    expect(res.body.reconciled).toBe(true);
    expect(res.body.note).toMatch(/already gone through/i);

    const rows = await db
      .select({ id: shiftAssignmentsTable.id })
      .from(shiftAssignmentsTable)
      .where(
        and(
          eq(shiftAssignmentsTable.shiftId, rosterShiftId),
          eq(shiftAssignmentsTable.employeeId, officerId),
        ),
      );
    // Without the key the re-send would have hit the double-book guard and
    // come back as a 409 refusal — a lie about what happened.
    expect(rows).toHaveLength(1);
  });

  it("approves the time entry exactly once, and records the re-send as a replay", async () => {
    const staged = stagePendingAction({
      userId: admin.id,
      tool: "approve_time_entry",
      args: { timeEntryId: entryId, decision: "approved" },
      summary: "Approve the time entry.",
      details: [],
    });

    const interrupt = loseTheAnswerFor(`/api/time-entries/${entryId}/approve`);

    const res = await request(app)
      .post(`/api/assistant/actions/${staged.id}/approve`)
      .set("Authorization", `Bearer ${admin.token}`)
      .expect(200);

    expect(interrupt.lost()).toBe(1);
    expect(res.body.reconciled).toBe(true);
    expect(res.body.note).toMatch(/already gone through/i);

    const [entry] = await db
      .select({ status: timeEntriesTable.approvalStatus, approvedAt: timeEntriesTable.approvedAt })
      .from(timeEntriesTable)
      .where(eq(timeEntriesTable.id, entryId));
    expect(entry.status).toBe("approved");

    // The audit trail must show ONE approval, with the re-send marked as a
    // replay rather than reading as a second sign-off on the same hours.
    const auditPath = `/time-entries/${entryId}/approve`;
    const rows = await waitForAuditRows(auditPath, admin.id, 2);
    const performed = rows.filter(
      (r) => (r.metadata as { idempotentReplay?: boolean } | null)?.idempotentReplay !== true,
    );
    expect(performed).toHaveLength(1);
    expect(rows).toHaveLength(2);
  });

  it("holds on to the lost write's outcome even when the store is full", async () => {
    // The dangerous shortcut would be to make room under pressure by dropping
    // the oldest key. The oldest key here is the interrupted write's — freeing
    // it would turn the reconciling re-send into a second shift.
    await clearIdempotencyStoreForTests();
    setIdempotencyLimitsForTests({ maxEntries: 2 });

    const title = `${TAG}-under-pressure`;
    const start = new Date(Date.now() + 11 * 24 * 60 * 60 * 1000);
    const staged = stagePendingAction({
      userId: admin.id,
      tool: "create_shift",
      args: {
        siteId,
        title,
        startTime: start.toISOString(),
        endTime: new Date(start.getTime() + 6 * 3600_000).toISOString(),
      },
      summary: "Create a shift.",
      details: [],
    });

    // Fill the store to capacity in the gap between the lost answer and the
    // retry, with unrelated keyed writes from another user.
    const fillerStatuses: number[] = [];
    const interrupt = loseTheAnswerFor("/api/shifts", 1, async () => {
      for (let i = 0; i < 3; i += 1) {
        const filler = await request(app)
          .post("/api/shifts")
          .set("Authorization", `Bearer ${otherAdmin.token}`)
          .set("Idempotency-Key", `test-filler-${randomUUID()}`)
          .send(shiftBody(`${TAG}-filler`));
        fillerStatuses.push(filler.status);
      }
    });

    const res = await request(app)
      .post(`/api/assistant/actions/${staged.id}/approve`)
      .set("Authorization", `Bearer ${admin.token}`)
      .expect(200);

    // Proof the ceiling was genuinely reached while the outcome was pending —
    // otherwise this test would pass without ever exercising the pressure.
    expect(fillerStatuses).toContain(503);
    expect(interrupt.lost()).toBe(1);
    expect(res.body.reconciled).toBe(true);
    expect(res.body.note).toMatch(/already gone through/i);
    expect(await countShifts(title)).toBe(1);
  });

  it("still says it cannot tell you when even the re-send is lost — and still duplicates nothing", async () => {
    const title = `${TAG}-both-lost`;
    const start = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000);
    const staged = stagePendingAction({
      userId: admin.id,
      tool: "create_shift",
      args: {
        siteId,
        title,
        startTime: start.toISOString(),
        endTime: new Date(start.getTime() + 6 * 3600_000).toISOString(),
      },
      summary: "Create a shift.",
      details: [],
    });

    const interrupt = loseTheAnswerFor("/api/shifts", 2);

    const res = await request(app)
      .post(`/api/assistant/actions/${staged.id}/approve`)
      .set("Authorization", `Bearer ${admin.token}`)
      .expect(504);

    expect(interrupt.lost()).toBe(2);
    expect(res.body.unconfirmed).toBe(true);
    expect(res.body.message).toMatch(/cannot tell you/i);
    expect(res.body.message).not.toMatch(/nothing was changed/i);
    // The second send was answered from the recorded outcome, so the shift
    // exists once even though nobody ever received the answer.
    expect(await countShifts(title)).toBe(1);
  });
});

// ── A recorded outcome survives a restart, and a second instance ───────────

describe("a recorded outcome survives a restart and a second instance", () => {
  it("replays a retry after the process's own in-flight memory is wiped, from the durable row", async () => {
    const title = `${TAG}-post-restart`;
    const key = `test-${randomUUID()}`;

    const first = await request(app)
      .post("/api/shifts")
      .set("Authorization", `Bearer ${admin.token}`)
      .set("Idempotency-Key", key)
      .send(shiftBody(title))
      .expect(201);

    // A redeploy or crash erases whatever this process was holding in memory
    // about writes it had running — the durable row is all that is left.
    simulateProcessRestartForTests();

    const second = await request(app)
      .post("/api/shifts")
      .set("Authorization", `Bearer ${admin.token}`)
      .set("Idempotency-Key", key)
      .send(shiftBody(title))
      .expect(201);

    expect(second.headers[IDEMPOTENT_REPLAY_HEADER]).toBe("true");
    expect(second.body.id).toBe(first.body.id);
    expect(await countShifts(title)).toBe(1);

    const [row] = await db
      .select({ status: idempotencyKeysTable.status })
      .from(idempotencyKeysTable)
      .where(
        eq(
          idempotencyKeysTable.scopeHash,
          idempotencyScopeHash({ actor: admin.id, method: "POST", path: "/api/shifts", key }),
        ),
      );
    expect(row?.status).toBe(201);
  });

  it("replays an outcome recorded by another instance, without running the route here", async () => {
    const title = `${TAG}-other-instance-resolved`;
    const key = `test-${randomUUID()}`;
    const scope = { actor: admin.id, method: "POST", path: "/api/shifts", key };
    const plantedBody = { id: randomUUID(), title, plantedBy: "other-instance" };

    // Stand in for a second instance of the API: it claimed the key, ran the
    // write, and recorded the answer. This instance never saw any of that
    // happen — its only view of it is this row.
    await db.insert(idempotencyKeysTable).values({
      scopeHash: idempotencyScopeHash(scope),
      actor: scope.actor,
      method: scope.method,
      path: scope.path,
      idempotencyKey: key,
      status: 201,
      body: plantedBody,
      claimedAt: new Date(),
      resolvedAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
    });

    const res = await request(app)
      .post("/api/shifts")
      .set("Authorization", `Bearer ${admin.token}`)
      .set("Idempotency-Key", key)
      .send(shiftBody(title))
      .expect(201);

    expect(res.headers[IDEMPOTENT_REPLAY_HEADER]).toBe("true");
    expect(res.body).toEqual(plantedBody);
    // The route never ran here — nothing was ever inserted for this title.
    expect(await countShifts(title)).toBe(0);
  });

  it("answers 'still being processed' for a claim another instance is holding, without writing anything", async () => {
    const title = `${TAG}-other-instance-unresolved`;
    const key = `test-${randomUUID()}`;
    const scope = { actor: admin.id, method: "POST", path: "/api/shifts", key };

    // Stand in for a second instance mid-write: it claimed the key but has not
    // answered yet. From here that is indistinguishable from this instance
    // before a restart — either way, the work may be one instant from
    // committing, so it must not be repeated.
    await db.insert(idempotencyKeysTable).values({
      scopeHash: idempotencyScopeHash(scope),
      actor: scope.actor,
      method: scope.method,
      path: scope.path,
      idempotencyKey: key,
      status: null,
      body: null,
      claimedAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
    });

    setIdempotencyLimitsForTests({ inFlightWaitMs: 300 });

    const res = await request(app)
      .post("/api/shifts")
      .set("Authorization", `Bearer ${admin.token}`)
      .set("Idempotency-Key", key)
      .send(shiftBody(title))
      .expect(409);

    expect(res.body.message).toMatch(/still being processed/i);
    expect(await countShifts(title)).toBe(0);
  });
});

/**
 * The audit middleware writes after the response finishes, so give it a beat
 * rather than racing it.
 */
async function waitForAuditRows(
  path: string,
  actorUserId: string,
  expected: number,
): Promise<Array<{ metadata: unknown }>> {
  let rows: Array<{ metadata: unknown }> = [];
  for (let i = 0; i < 30; i += 1) {
    rows = await db
      .select({ metadata: auditLogsTable.metadata })
      .from(auditLogsTable)
      .where(and(eq(auditLogsTable.path, path), eq(auditLogsTable.actorUserId, actorUserId)));
    if (rows.length >= expected) return rows;
    await new Promise((r) => setTimeout(r, 100));
  }
  return rows;
}
