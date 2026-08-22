/**
 * Assistant authorization, approval-gate and adoption-signal tests.
 *
 * The point of this suite is that the assistant is NOT a privileged path. It
 * carries out actions by calling the same HTTP routes the portal UI calls, as
 * the signed-in user, so a dispatcher who cannot approve time by clicking must
 * not be able to approve it by asking. These tests prove that boundary holds,
 * that money-touching work always waits for an explicit human click, and that
 * the suggestion list is scoped to what the caller may already see.
 *
 * The Gemini model itself is never exercised here — the deterministic layers
 * around it (argument validation, the approval allowlist, dispatch, scoping)
 * are what enforce safety, and they are what is tested.
 */

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
  siteManagersTable,
  shiftsTable,
  timeEntriesTable,
  assistantSuggestionDismissalsTable,
} from "@workspace/db";
import app from "../app";
import { signToken } from "../middlewares/auth";
import { requiresApproval, prepareAction, executeAction, runLookupTool } from "../lib/assistant/tools";
import { clearPendingActionsForTests, stagePendingAction, claimPendingAction } from "../lib/assistant/pendingActions";
import { computeFindings, clearSignalCacheForTests, CHECK_IDS } from "../lib/assistant/signals";
import { closeInternalDispatch, classifyDispatchFailure } from "../lib/assistant/internalDispatch";
import { isAssistantConfigured } from "../lib/assistant/gemini";

const TAG = `assistant-test-${randomUUID().slice(0, 8)}`;

type Actor = { id: string; email: string; token: string; role: string; firstName: string };

async function mkUser(role: string, label: string): Promise<Actor> {
  const email = `${TAG}-${label}@example.test`;
  const [row] = await db
    .insert(usersTable)
    .values({
      email,
      passwordHash: bcrypt.hashSync("test-password", 4),
      firstName: label,
      lastName: TAG,
      role,
      status: "active",
      tokensValidAfter: new Date(0),
    })
    .returning({ id: usersTable.id });
  return { id: row.id, email, role, firstName: label, token: signToken({ userId: row.id, email, role }) };
}

/**
 * A tool context for an actor. `prepareAction` needs one because the approval
 * card is now built from reads made AS the caller — so the card can never
 * describe a record they are not allowed to see.
 */
function ctxFor(a: Actor, originRef = "test") {
  return {
    user: { userId: a.id, role: a.role, email: a.email },
    authorization: `Bearer ${a.token}`,
    originRef,
  };
}

let admin: Actor;
let dispatcher: Actor;
let manager: Actor;
let officer: Actor;
let client: Actor;
let managedSiteId = "";
let otherSiteId = "";
let shiftId = "";
let entryId = "";

beforeAll(async () => {
  admin = await mkUser("admin", "admin");
  dispatcher = await mkUser("dispatcher", "dispatcher");
  manager = await mkUser("site_manager", "manager");
  officer = await mkUser("employee", "officer");
  client = await mkUser("client", "client");

  const [c] = await db
    .insert(clientsTable)
    .values({ name: `${TAG}-client` })
    .returning({ id: clientsTable.id });

  const [managed] = await db
    .insert(sitesTable)
    .values({
      clientId: c.id,
      name: `${TAG}-managed-site`,
      status: "active",
      defaultPayRate: "20.00",
      defaultBillRate: "35.00",
    })
    .returning({ id: sitesTable.id });
  managedSiteId = managed.id;

  const [other] = await db
    .insert(sitesTable)
    .values({
      clientId: c.id,
      name: `${TAG}-other-site`,
      status: "active",
      defaultPayRate: "20.00",
      defaultBillRate: "35.00",
    })
    .returning({ id: sitesTable.id });
  otherSiteId = other.id;

  await db.insert(siteManagersTable).values({ userId: manager.id, siteId: managedSiteId });

  const start = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
  const end = new Date(start.getTime() + 8 * 60 * 60 * 1000);
  const [s] = await db
    .insert(shiftsTable)
    .values({
      title: `${TAG}-shift`,
      siteId: otherSiteId,
      startTime: start,
      endTime: end,
      payRate: "20.00",
      billRate: "35.00",
      headcount: 2,
      requiredLicenseLevel: 1,
    })
    .returning({ id: shiftsTable.id });
  shiftId = s.id;

  const clockIn = new Date(Date.now() - 10 * 60 * 60 * 1000);
  const clockOut = new Date(Date.now() - 2 * 60 * 60 * 1000);
  const [te] = await db
    .insert(timeEntriesTable)
    .values({
      employeeId: officer.id,
      siteId: otherSiteId,
      clockInTime: clockIn,
      clockOutTime: clockOut,
      hoursWorked: "8.00",
      approvalStatus: "pending",
    })
    .returning({ id: timeEntriesTable.id });
  entryId = te.id;

  clearSignalCacheForTests();
  clearPendingActionsForTests();
});

afterAll(async () => {
  await closeInternalDispatch();
  await db.execute(sql`DELETE FROM assistant_suggestion_dismissals WHERE user_id IN (SELECT id FROM users WHERE last_name = ${TAG})`);
  await db.execute(sql`DELETE FROM shift_assignments WHERE shift_id IN (SELECT id FROM shifts WHERE title LIKE ${`${TAG}%`})`);
  await db.execute(sql`DELETE FROM time_entries WHERE employee_id IN (SELECT id FROM users WHERE last_name = ${TAG})`);
  await db.execute(sql`DELETE FROM shifts WHERE title LIKE ${`${TAG}%`}`);
  await db.execute(sql`DELETE FROM site_managers WHERE user_id IN (SELECT id FROM users WHERE last_name = ${TAG})`);
  await db.execute(sql`DELETE FROM sites WHERE name LIKE ${`${TAG}%`}`);
  await db.execute(sql`DELETE FROM clients WHERE name LIKE ${`${TAG}%`}`);
  await db.execute(sql`DELETE FROM users WHERE last_name = ${TAG}`);
});

// ── Who may reach the assistant at all ─────────────────────────────────────

describe("assistant access", () => {
  it("refuses an unauthenticated caller", async () => {
    await request(app).get("/api/assistant/suggestions").expect(401);
  });

  it("refuses a client-portal account (external contact, not staff)", async () => {
    const res = await request(app)
      .get("/api/assistant/suggestions")
      .set("Authorization", `Bearer ${client.token}`);
    expect(res.status).toBe(403);
  });

  it("lets staff read the connection status honestly", async () => {
    const res = await request(app)
      .get("/api/assistant/status")
      .set("Authorization", `Bearer ${admin.token}`)
      .expect(200);
    expect(res.body).toEqual({ configured: isAssistantConfigured() });
  });

  it("says the assistant is not connected rather than failing obscurely", async () => {
    if (isAssistantConfigured()) return; // real integration present — nothing to assert
    const res = await request(app)
      .post("/api/assistant/chat")
      .set("Authorization", `Bearer ${admin.token}`)
      .send({ message: "how do I run payroll?" })
      .expect(200);
    expect(res.body.notConfigured).toBe(true);
    expect(res.body.reply).toMatch(/not connected/i);
    expect(res.body.actionsTaken).toEqual([]);
    expect(res.body.pendingAction).toBeNull();
  });

  it("rejects an empty message", async () => {
    await request(app)
      .post("/api/assistant/chat")
      .set("Authorization", `Bearer ${admin.token}`)
      .send({ message: "   " })
      .expect(400);
  });
});

// ── The approval gate ──────────────────────────────────────────────────────

describe("approval gate", () => {
  it("always requires a click before a time entry is approved", () => {
    expect(requiresApproval("approve_time_entry", { timeEntryId: entryId, decision: "approved" })).toBe(true);
    expect(requiresApproval("approve_time_entry", { timeEntryId: entryId, decision: "rejected" })).toBe(true);
  });

  it("always requires a click before an officer is put on a priced shift", () => {
    // The shift already carries pay and bill rates. Naming the person who will
    // work it is the moment the company commits to paying for it.
    expect(requiresApproval("assign_officer_to_shift", { shiftId, employeeId: officer.id })).toBe(true);
  });

  it("always requires a click before a shift is created, rates or no rates", () => {
    // Omitting payRate/billRate does not make the shift free — it inherits the
    // site defaults, and its hours reach payroll and a client invoice all the
    // same. "No explicit rate" must not read as "no money".
    expect(requiresApproval("create_shift", { siteId: managedSiteId })).toBe(true);
    expect(requiresApproval("create_shift", { siteId: managedSiteId, payRate: 25 })).toBe(true);
    expect(requiresApproval("create_shift", { siteId: managedSiteId, billRate: 40 })).toBe(true);
  });

  it("leaves nothing at all able to run unattended", () => {
    // Every action currently reachable creates financial exposure. If this
    // fails, something was added to the autonomy allowlist — check it cannot
    // touch payroll or invoicing before changing this test.
    for (const tool of ["create_shift", "assign_officer_to_shift", "approve_time_entry"]) {
      expect(requiresApproval(tool, {})).toBe(true);
    }
  });

  it("treats anything not on the allowlist as approval-required by default", () => {
    // A tool added later must not become silently autonomous.
    expect(requiresApproval("some_future_tool", {})).toBe(true);
  });
});

describe("staged actions", () => {
  it("can only be claimed once", () => {
    const staged = stagePendingAction({
      userId: admin.id, tool: "create_shift", args: {}, summary: "s", details: [],
    });
    expect(claimPendingAction(staged.id, admin.id).ok).toBe(true);
    const second = claimPendingAction(staged.id, admin.id);
    expect(second.ok).toBe(false);
  });

  it("cannot be approved by a different user", () => {
    const staged = stagePendingAction({
      userId: admin.id, tool: "create_shift", args: {}, summary: "s", details: [],
    });
    const stolen = claimPendingAction(staged.id, dispatcher.id);
    expect(stolen.ok).toBe(false);
    if (!stolen.ok) expect(stolen.reason).toBe("not_yours");
    // …and the rightful owner can still approve it.
    expect(claimPendingAction(staged.id, admin.id).ok).toBe(true);
  });

  it("returns a clear 404 when approving something that is not staged", async () => {
    await request(app)
      .post(`/api/assistant/actions/${randomUUID()}/approve`)
      .set("Authorization", `Bearer ${admin.token}`)
      .expect(404);
  });
});

// ── Argument validation (the model's output is untrusted) ──────────────────

describe("action argument validation", () => {
  it("refuses a name where an id is required", async () => {
    const out = await prepareAction(ctxFor(admin), "create_shift", {
      siteId: "Riverside Plaza",
      title: "Night patrol",
      startTime: new Date().toISOString(),
      endTime: new Date(Date.now() + 3600_000).toISOString(),
    });
    expect(out).toHaveProperty("error");
  });

  it("refuses a shift that ends before it starts", async () => {
    const start = new Date(Date.now() + 3600_000);
    const out = await prepareAction(ctxFor(admin), "create_shift", {
      siteId: managedSiteId,
      title: "Backwards",
      startTime: start.toISOString(),
      endTime: new Date(start.getTime() - 60_000).toISOString(),
    });
    expect(out).toHaveProperty("error");
  });

  it("refuses a decision that is neither approved nor rejected", async () => {
    const out = await prepareAction(ctxFor(admin), "approve_time_entry", { timeEntryId: entryId, decision: "definitely" });
    expect(out).toHaveProperty("error");
  });

  it("refuses an unknown action outright", async () => {
    const out = await prepareAction(ctxFor(admin), "delete_everything", {});
    expect(out).toHaveProperty("error");
  });

  it("gives the same answer for a foreign time entry and one that never existed", async () => {
    // Two different messages would make guessed uuids an existence oracle: a
    // site manager could learn that a foreign officer's entry exists.
    const foreign = await prepareAction(ctxFor(manager), "approve_time_entry", {
      timeEntryId: entryId,
      decision: "approved",
    });
    const nonexistent = await prepareAction(ctxFor(manager), "approve_time_entry", {
      timeEntryId: randomUUID(),
      decision: "approved",
    });
    expect(foreign).toHaveProperty("error");
    expect(nonexistent).toHaveProperty("error");
    if (!("error" in foreign) || !("error" in nonexistent)) return;
    expect(foreign.error).toBe(nonexistent.error);
  });

  it("will not describe a time entry the caller cannot see", async () => {
    // The entry belongs to an officer at a site this manager does NOT manage.
    // Guessing its id must yield nothing — not a card carrying that officer's
    // name, clock times and hours.
    const out = await prepareAction(ctxFor(manager), "approve_time_entry", {
      timeEntryId: entryId,
      decision: "approved",
    });
    expect(out).toHaveProperty("error");
    expect(JSON.stringify(out)).not.toContain("officer");
  });

  it("will not describe a shift the caller cannot see", async () => {
    const out = await prepareAction(ctxFor(manager), "assign_officer_to_shift", {
      shiftId,
      employeeId: officer.id,
    });
    expect(out).toHaveProperty("error");
    expect(JSON.stringify(out)).not.toContain(`${TAG}-shift`);
  });

  it("refuses to roster an id that is not a member of staff", async () => {
    const out = await prepareAction(ctxFor(admin), "assign_officer_to_shift", {
      shiftId,
      employeeId: client.id,
    });
    expect(out).toHaveProperty("error");
  });

  it("builds a concrete diff summary a human can check before approving", async () => {
    const out = await prepareAction(ctxFor(admin), "approve_time_entry", { timeEntryId: entryId, decision: "approved" });
    expect(out).not.toHaveProperty("error");
    if ("error" in out) return;
    expect(out.summary).toMatch(/payroll/i);
    const labels = out.details.map((d) => d.label);
    expect(labels).toContain("Clocked in");
    expect(labels).toContain("Hours");
  });
});

// ── Looking people up is bounded by the caller's own directory access ──────

describe("staff lookup scoping", () => {
  it("does not let an ordinary employee enumerate staff", async () => {
    // requireStaff admits officers, but the portal only shows the roster to
    // scheduling staff. The tool must not become a back door around that.
    const out = await runLookupTool(ctxFor(officer), "find_employee", { query: TAG });
    expect(out).toHaveProperty("error");
    expect(out["matches"]).toBeUndefined();
    expect(JSON.stringify(out)).not.toContain(admin.email);
  });

  it("gives a site manager no more of the directory than the portal does", async () => {
    const viaTool = await runLookupTool(ctxFor(manager), "find_employee", { query: TAG });
    const viaPortal = await request(app)
      .get(`/api/employees?search=${encodeURIComponent(TAG)}`)
      .set("Authorization", `Bearer ${manager.token}`);

    if (viaPortal.status === 403) {
      // Policy tightened: the tool must have refused too, not gone around it.
      expect(viaTool).toHaveProperty("error");
      return;
    }

    expect(viaTool).not.toHaveProperty("error");
    const allowed = new Set(
      ((viaPortal.body.employees ?? viaPortal.body) as Array<{ id: string }>).map((e) => e.id),
    );
    const seen = (viaTool["matches"] as Array<{ id: string }>) ?? [];
    for (const m of seen) expect(allowed.has(m.id)).toBe(true);
  });

  it("still resolves an officer for a dispatcher, who has to roster them", async () => {
    const out = await runLookupTool(ctxFor(dispatcher), "find_employee", { query: officer.email });
    expect(out).not.toHaveProperty("error");
    const matches = (out["matches"] as Array<{ id: string; role: string }>) ?? [];
    expect(matches.some((m) => m.id === officer.id)).toBe(true);
  });

  it("will not name a colleague on a card an officer asked for with a guessed id", async () => {
    // The shift-detail route lets any officer read a shift, so the card build
    // gets past that gate — the staff lookup is the only thing standing between
    // a guessed uuid and a card naming someone. A later 403 on the assignment
    // itself would come too late to take the name back.
    const out = await prepareAction(ctxFor(officer), "assign_officer_to_shift", {
      shiftId,
      employeeId: admin.id,
    });
    expect(out).toHaveProperty("error");
    const asText = JSON.stringify(out);
    expect(asText).not.toContain(admin.firstName);
    expect(asText).not.toContain(admin.email);
  });

  it("gives the same answer whether the id is a stranger or nobody at all", async () => {
    // Two different messages would turn guessed uuids into an existence oracle.
    const stranger = await prepareAction(ctxFor(officer), "assign_officer_to_shift", {
      shiftId,
      employeeId: admin.id,
    });
    const nobody = await prepareAction(ctxFor(officer), "assign_officer_to_shift", {
      shiftId,
      employeeId: randomUUID(),
    });
    expect(stranger).toEqual(nobody);
  });

  it("still names the officer for a dispatcher, who is allowed the roster", async () => {
    const out = await prepareAction(ctxFor(dispatcher), "assign_officer_to_shift", {
      shiftId,
      employeeId: officer.id,
    });
    expect(out).not.toHaveProperty("error");
    if ("error" in out) return;
    expect(JSON.stringify(out.details)).toContain(officer.firstName);
  });

  it("never resolves a client-portal contact as staff", async () => {
    const out = await runLookupTool(ctxFor(admin), "find_employee", { query: client.email });
    const matches = (out["matches"] as Array<{ id: string }>) ?? [];
    expect(matches.some((m) => m.id === client.id)).toBe(false);
  });
});

// ── The assistant inherits the caller's permissions, nothing more ──────────

describe("permission inheritance through the loopback dispatcher", () => {
  it("lets an admin create a shift", async () => {
    const start = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000);
    const prepared = await prepareAction(ctxFor(admin), "create_shift", {
      siteId: managedSiteId,
      title: `${TAG}-admin-made`,
      startTime: start.toISOString(),
      endTime: new Date(start.getTime() + 4 * 3600_000).toISOString(),
    });
    expect(prepared).not.toHaveProperty("error");
    if ("error" in prepared) return;

    const outcome = await executeAction(
      {
        user: { userId: admin.id, role: admin.role, email: admin.email },
        authorization: `Bearer ${admin.token}`,
        originRef: "test",
      },
      prepared,
    );
    expect(outcome.ok).toBe(true);
  });

  it("refuses a dispatcher the same call, with the route's own message", async () => {
    const start = new Date(Date.now() + 6 * 24 * 60 * 60 * 1000);
    const prepared = await prepareAction(ctxFor(dispatcher), "create_shift", {
      siteId: managedSiteId,
      title: `${TAG}-dispatcher-attempt`,
      startTime: start.toISOString(),
      endTime: new Date(start.getTime() + 4 * 3600_000).toISOString(),
    });
    if ("error" in prepared) throw new Error(prepared.error);

    const outcome = await executeAction(
      {
        user: { userId: dispatcher.id, role: dispatcher.role, email: dispatcher.email },
        authorization: `Bearer ${dispatcher.token}`,
        originRef: "test",
      },
      prepared,
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.status).toBe(403);

    const [leaked] = await db
      .select({ id: shiftsTable.id })
      .from(shiftsTable)
      .where(eq(shiftsTable.title, `${TAG}-dispatcher-attempt`));
    expect(leaked).toBeUndefined();
  });

  it("still lets a site manager create a shift at a site they DO manage", async () => {
    // The card's site-name read goes through GET /api/sites/:id, which is
    // admin/dispatcher-only. That refusal must degrade the card, never block a
    // legitimate creation.
    const start = new Date(Date.now() + 11 * 24 * 60 * 60 * 1000);
    const prepared = await prepareAction(ctxFor(manager), "create_shift", {
      siteId: managedSiteId,
      title: `${TAG}-manager-own-site`,
      startTime: start.toISOString(),
      endTime: new Date(start.getTime() + 4 * 3600_000).toISOString(),
    });
    if ("error" in prepared) throw new Error(prepared.error);

    const outcome = await executeAction(ctxFor(manager), prepared);
    expect(outcome.ok).toBe(true);
  });

  it("still lets a dispatcher roster an officer company-wide", async () => {
    // Dispatchers have no site scope by design. Scoping the card reads must
    // not accidentally fence them out of shifts they legitimately run.
    const start = new Date(Date.now() + 12 * 24 * 60 * 60 * 1000);
    const [openShift] = await db
      .insert(shiftsTable)
      .values({
        title: `${TAG}-dispatcher-roster`,
        siteId: otherSiteId,
        startTime: start,
        endTime: new Date(start.getTime() + 4 * 3600_000),
        payRate: "20.00",
        billRate: "35.00",
        headcount: 1,
        requiredLicenseLevel: 0,
      })
      .returning({ id: shiftsTable.id });

    const prepared = await prepareAction(ctxFor(dispatcher), "assign_officer_to_shift", {
      shiftId: openShift.id,
      employeeId: officer.id,
    });
    if ("error" in prepared) throw new Error(prepared.error);
    expect(prepared.details.find((d) => d.label === "Shift")?.value).toBe(`${TAG}-dispatcher-roster`);

    const outcome = await executeAction(ctxFor(dispatcher), prepared);
    expect(outcome.ok).toBe(true);
  });

  it("holds the site-manager boundary — no acting on a site they do not manage", async () => {
    const start = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    const prepared = await prepareAction(ctxFor(manager), "create_shift", {
      siteId: otherSiteId,
      title: `${TAG}-cross-site-attempt`,
      startTime: start.toISOString(),
      endTime: new Date(start.getTime() + 4 * 3600_000).toISOString(),
    });
    if ("error" in prepared) throw new Error(prepared.error);

    const outcome = await executeAction(
      {
        user: { userId: manager.id, role: manager.role, email: manager.email },
        authorization: `Bearer ${manager.token}`,
        originRef: "test",
      },
      prepared,
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.status).toBe(403);
  });

  it("refuses to approve a time entry for a role that cannot approve time", async () => {
    const prepared = await prepareAction(ctxFor(admin), "approve_time_entry", { timeEntryId: entryId, decision: "approved" });
    if ("error" in prepared) throw new Error(prepared.error);

    const outcome = await executeAction(
      {
        user: { userId: dispatcher.id, role: dispatcher.role, email: dispatcher.email },
        authorization: `Bearer ${dispatcher.token}`,
        originRef: "test",
      },
      prepared,
    );
    expect(outcome.ok).toBe(false);

    const [entry] = await db
      .select({ status: timeEntriesTable.approvalStatus })
      .from(timeEntriesTable)
      .where(eq(timeEntriesTable.id, entryId));
    expect(entry?.status).toBe("pending");
  });

  it("records an assistant-performed write in the audit log, attributed to the user", async () => {
    const start = new Date(Date.now() + 8 * 24 * 60 * 60 * 1000);
    const prepared = await prepareAction(ctxFor(admin), "create_shift", {
      siteId: managedSiteId,
      title: `${TAG}-audited`,
      startTime: start.toISOString(),
      endTime: new Date(start.getTime() + 4 * 3600_000).toISOString(),
    });
    if ("error" in prepared) throw new Error(prepared.error);

    const outcome = await executeAction(
      {
        user: { userId: admin.id, role: admin.role, email: admin.email },
        authorization: `Bearer ${admin.token}`,
        originRef: "assistant:test-origin",
      },
      prepared,
    );
    expect(outcome.ok).toBe(true);

    // The audit row is written on res.finish, fire-and-forget.
    await new Promise((r) => setTimeout(r, 400));
    const rows = await db.execute(
      sql`select actor_user_id, metadata from audit_logs where actor_user_id = ${admin.id} and path = '/shifts' order by created_at desc limit 5`,
    );
    const marked = (rows.rows as Array<{ metadata: Record<string, unknown> | null }>).find(
      (r) => r.metadata?.["assistantInitiated"] === true,
    );
    expect(marked).toBeDefined();
    expect(marked?.metadata?.["assistantOrigin"]).toBe("assistant:test-origin");
  });

  it("does not let an outside caller forge the assistant marker", async () => {
    const start = new Date(Date.now() + 9 * 24 * 60 * 60 * 1000);
    await request(app)
      .post("/api/shifts")
      .set("Authorization", `Bearer ${admin.token}`)
      .set("x-assistant-origin", "forged")
      .set("x-assistant-internal-token", "not-the-real-token")
      .send({
        siteId: managedSiteId,
        title: `${TAG}-forged`,
        startTime: start.toISOString(),
        endTime: new Date(start.getTime() + 3600_000).toISOString(),
      })
      .expect(201);

    await new Promise((r) => setTimeout(r, 400));
    const rows = await db.execute(
      sql`select metadata from audit_logs where actor_user_id = ${admin.id} and path = '/shifts' order by created_at desc limit 1`,
    );
    const meta = (rows.rows[0] as { metadata: Record<string, unknown> | null } | undefined)?.metadata;
    expect(meta?.["assistantOrigin"]).toBeUndefined();
  });
});

// ── Honesty about outcomes we cannot verify ────────────────────────────────

describe("failed dispatch never claims false certainty", () => {
  it("only says 'nothing was changed' when the request provably never left", () => {
    const refused = Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }),
    });
    const out = classifyDispatchFailure(refused);
    expect(out.unconfirmed).toBe(false);
    expect(out.message).toMatch(/nothing was changed/i);
  });

  it("treats a timeout as unknown, not as a failure", () => {
    // These writes are not idempotent: the route may have committed before the
    // answer was lost, so "it failed, try again" would double-book.
    const out = classifyDispatchFailure(
      Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" }),
    );
    expect(out.unconfirmed).toBe(true);
    expect(out.message).not.toMatch(/nothing was changed/i);
    expect(out.message).toMatch(/cannot tell you|check/i);
  });

  it("treats a bare network failure as unknown too", () => {
    const out = classifyDispatchFailure(new TypeError("fetch failed"));
    expect(out.unconfirmed).toBe(true);
    expect(out.message).not.toMatch(/nothing was changed/i);
  });
});

// ── Adoption signals ───────────────────────────────────────────────────────

describe("adoption findings", () => {
  it("uses stable, unique finding ids (dismissals are keyed on them)", () => {
    expect(new Set(CHECK_IDS).size).toBe(CHECK_IDS.length);
    for (const id of CHECK_IDS) expect(id).toMatch(/^[a-z0-9_]+$/);
  });

  it("gives an admin company-wide findings", async () => {
    clearSignalCacheForTests();
    const findings = await computeFindings({ userId: admin.id, role: admin.role });
    expect(Array.isArray(findings)).toBe(true);
    for (const f of findings) {
      expect(f.evidence.length).toBeGreaterThan(0);
      expect(f.route.startsWith("/")).toBe(true);
    }
  });

  it("never gives a site manager a company-wide finance finding", async () => {
    clearSignalCacheForTests();
    const findings = await computeFindings({ userId: manager.id, role: manager.role });
    const ids = findings.map((f) => f.id);
    expect(ids).not.toContain("subcontractor_hours_uninvoiced");
    expect(ids).not.toContain("client_portal_unused");
    expect(ids).not.toContain("pending_accounts_stale");
    expect(ids).not.toContain("permission_matrix_unused");
  });

  it("never gives a site manager a client-finance finding about their OWN sites", async () => {
    // The bill-rate finding names sites and states that their hours are going
    // un-invoiced. Site-scoping is not enough — a site manager must not see
    // client finance at all, including for a site they manage.
    clearSignalCacheForTests();
    const findings = await computeFindings({ userId: manager.id, role: manager.role });
    expect(findings.map((f) => f.id)).not.toContain("site_bill_rate_missing");
    expect(findings.some((f) => f.category === "money")).toBe(false);

    const res = await request(app)
      .get("/api/assistant/suggestions")
      .set("Authorization", `Bearer ${manager.token}`)
      .expect(200);
    const served = res.body.findings as Array<{ id: string; category: string; evidence: string }>;
    expect(served.some((f) => f.category === "money")).toBe(false);
    for (const f of served) expect(f.evidence).not.toMatch(/bill rate|invoice/i);
  });

  it("gives a dispatcher no site-scoped findings at all", async () => {
    clearSignalCacheForTests();
    const findings = await computeFindings({ userId: dispatcher.id, role: dispatcher.role });
    expect(findings).toEqual([]);
  });

  it("hides a finding once it is dismissed, and only for that user", async () => {
    clearSignalCacheForTests();
    const before = await computeFindings({ userId: admin.id, role: admin.role });
    if (before.length === 0) return; // healthy account — nothing to dismiss
    const target = before[0]!.id;

    await request(app)
      .post(`/api/assistant/suggestions/${encodeURIComponent(target)}/dismiss`)
      .set("Authorization", `Bearer ${admin.token}`)
      .expect(200);

    clearSignalCacheForTests();
    const after = await computeFindings({ userId: admin.id, role: admin.role });
    expect(after.map((f) => f.id)).not.toContain(target);

    // Another admin is unaffected — dismissal is personal.
    const other = await mkUser("admin", "admin2");
    clearSignalCacheForTests();
    const theirs = await computeFindings({ userId: other.id, role: other.role });
    expect(theirs.map((f) => f.id)).toContain(target);

    await db
      .delete(assistantSuggestionDismissalsTable)
      .where(eq(assistantSuggestionDismissalsTable.userId, admin.id));
    clearSignalCacheForTests();
  });

  it("serves suggestions over HTTP without needing the AI integration", async () => {
    const res = await request(app)
      .get("/api/assistant/suggestions")
      .set("Authorization", `Bearer ${admin.token}`)
      .expect(200);
    expect(Array.isArray(res.body.findings)).toBe(true);
  });
});
