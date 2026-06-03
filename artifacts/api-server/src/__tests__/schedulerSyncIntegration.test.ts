import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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
  timeEntriesTable,
  schedulerSyncCursorsTable,
} from "@workspace/db";
import app from "../app";
import { signPayload, SCHEDULER_SOURCE } from "../lib/schedulerSync";
import { processInboundClockEvent } from "../routes/schedulerWebhook";
import { runSchedulerReconciliation } from "../lib/scheduledJobs";

// ---------------------------------------------------------------------------
// End-to-end coverage of the Event Staff Scheduler sync pipeline:
//   inbound webhook -> DB upsert -> loop prevention,
//   ±5 min clock-event dedup/merge,
//   reconcile job cursor advancement + skip of already-synced entries.
//
// The scheduler's outbound HTTP surface is faked by spying on global fetch
// (the established pattern in this repo — no MSW/nock dependency available).
// ---------------------------------------------------------------------------

const TAG = `sched-sync-it-${randomUUID().slice(0, 8)}`;
const SECRET = "integration-test-shared-secret";
const passwordHash = bcrypt.hashSync("test-password", 4);

const ctx = {
  clientId: "",
  siteId: "",
  siteName: `${TAG}-site`,
  employeeId: "",
  employeeEmail: "",
};

// Preserve and restore scheduler env so other test files are unaffected.
let prevBaseUrl: string | undefined;
let prevSecret: string | undefined;

beforeAll(async () => {
  prevBaseUrl = process.env.SCHEDULER_BASE_URL;
  prevSecret = process.env.SCHEDULER_SHARED_SECRET;

  ctx.employeeEmail = `${TAG}-officer-${randomUUID().slice(0, 6)}@example.test`;
  const [emp] = await db
    .insert(usersTable)
    .values({
      email: ctx.employeeEmail,
      passwordHash,
      firstName: "Sync",
      lastName: TAG,
      role: "employee",
      status: "active",
      tokensValidAfter: new Date(0),
    })
    .returning({ id: usersTable.id });
  ctx.employeeId = emp.id;

  const [client] = await db
    .insert(clientsTable)
    .values({ name: `${TAG}-client` })
    .returning({ id: clientsTable.id });
  ctx.clientId = client.id;

  const [site] = await db
    .insert(sitesTable)
    .values({ clientId: ctx.clientId, name: ctx.siteName, address: "1 Sync Way" })
    .returning({ id: sitesTable.id });
  ctx.siteId = site.id;
});

afterAll(async () => {
  // Scope cleanup tightly so we never trample real seed data.
  await db.execute(
    sql`DELETE FROM time_entries WHERE employee_id = ${ctx.employeeId}::uuid`,
  );
  await db.execute(sql`DELETE FROM shifts WHERE external_id LIKE ${TAG + "%"}`);
  await db.execute(sql`DELETE FROM sites WHERE name LIKE ${TAG + "%"}`);
  await db.execute(sql`DELETE FROM clients WHERE name LIKE ${TAG + "%"}`);
  await db.execute(sql`DELETE FROM users WHERE last_name = ${TAG}`);

  // Restore env exactly as we found it.
  if (prevBaseUrl === undefined) delete process.env.SCHEDULER_BASE_URL;
  else process.env.SCHEDULER_BASE_URL = prevBaseUrl;
  if (prevSecret === undefined) delete process.env.SCHEDULER_SHARED_SECRET;
  else process.env.SCHEDULER_SHARED_SECRET = prevSecret;
});

// ---------------------------------------------------------------------------
// 1. Inbound webhook -> DB upsert, with NO outbound echo (loop prevention).
// ---------------------------------------------------------------------------

describe("inbound shift webhook: upsert creates a row and never echoes back out", () => {
  beforeEach(() => {
    // Fully configured: if loop prevention were broken, an outbound push
    // WOULD fire, so a fetch spy with zero calls is a meaningful assertion.
    process.env.SCHEDULER_BASE_URL = "https://scheduler.example.com";
    process.env.SCHEDULER_SHARED_SECRET = SECRET;
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("writes a shift tagged syncSource='scheduler' and fires no outbound fetch", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("{}", { status: 200 }));

    const externalId = `${TAG}-shift-${randomUUID().slice(0, 8)}`;
    const payload = {
      id: externalId,
      action: "upsert" as const,
      title: `${TAG} Morning Patrol`,
      siteName: ctx.siteName,
      startTime: "2026-07-01T08:00:00.000Z",
      endTime: "2026-07-01T16:00:00.000Z",
      payRate: "22",
      billRate: "30",
      requiredLicenseLevel: 2,
      headcount: 2,
      status: "upcoming",
      updatedAt: "2026-06-30T00:00:00.000Z",
    };

    const bodyStr = JSON.stringify(payload);
    const sig = signPayload(bodyStr, SECRET);

    const res = await request(app)
      .post("/api/scheduler-webhook/shifts")
      .set("Content-Type", "application/json")
      .set("X-WCSG-Signature", sig)
      .send(bodyStr);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, action: "created" });

    // The DB row exists and is stamped as scheduler-originated.
    const [row] = await db
      .select()
      .from(shiftsTable)
      .where(
        and(
          eq(shiftsTable.externalSource, SCHEDULER_SOURCE),
          eq(shiftsTable.externalId, externalId),
        ),
      )
      .limit(1);

    expect(row).toBeTruthy();
    expect(row.syncSource).toBe(SCHEDULER_SOURCE);
    expect(row.title).toBe(`${TAG} Morning Patrol`);
    expect(row.siteId).toBe(ctx.siteId);

    // Loop prevention: processing an inbound shift must NOT push anything
    // back to the scheduler (no outbound HTTP at all).
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("re-applying the same shift is idempotent (no duplicate row)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));

    const externalId = `${TAG}-shift-idem-${randomUUID().slice(0, 8)}`;
    const base = {
      id: externalId,
      action: "upsert" as const,
      title: `${TAG} Idempotent`,
      siteName: ctx.siteName,
      startTime: "2026-07-02T08:00:00.000Z",
      endTime: "2026-07-02T16:00:00.000Z",
      requiredLicenseLevel: 2,
      headcount: 1,
      status: "upcoming",
      // Past-dated: conflict resolution compares this against the DB row's
      // wall-clock updatedAt (the moment SecureOps wrote it). A scheduler
      // timestamp older than the local write means SecureOps wins the
      // tiebreaker, so a re-pull of an unchanged shift is skipped.
      updatedAt: "2025-01-01T00:00:00.000Z",
    };

    async function post(body: object) {
      const s = JSON.stringify(body);
      return request(app)
        .post("/api/scheduler-webhook/shifts")
        .set("Content-Type", "application/json")
        .set("X-WCSG-Signature", signPayload(s, SECRET))
        .send(s);
    }

    const first = await post(base);
    expect(first.body.action).toBe("created");

    // Same updatedAt -> SecureOps wins the tiebreaker -> skipped, never duplicated.
    const second = await post(base);
    expect(second.body.action).toBe("skipped");

    const rows = await db
      .select({ id: shiftsTable.id })
      .from(shiftsTable)
      .where(
        and(
          eq(shiftsTable.externalSource, SCHEDULER_SOURCE),
          eq(shiftsTable.externalId, externalId),
        ),
      );
    expect(rows).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 2. Clock-event dedup: an inbound event within ±5 min of an existing local
//    entry merges into it instead of creating a duplicate row.
// ---------------------------------------------------------------------------

describe("inbound clock-event dedup within ±5 min", () => {
  afterEach(async () => {
    await db.execute(
      sql`DELETE FROM time_entries WHERE employee_id = ${ctx.employeeId}::uuid`,
    );
  });

  it("merges into the existing local entry rather than creating a duplicate", async () => {
    const clockIn = new Date("2026-07-03T09:00:00.000Z");

    // A pre-existing local clock-in (e.g. the officer clocked in via the app).
    const [local] = await db
      .insert(timeEntriesTable)
      .values({
        employeeId: ctx.employeeId,
        siteId: ctx.siteId,
        clockInTime: clockIn,
        approvalStatus: "pending",
        isVerified: false,
        syncSource: "local",
      })
      .returning({ id: timeEntriesTable.id });

    // Same officer + site, clock-in 3 minutes later (inside the ±5 min window).
    const externalId = `${TAG}-clock-${randomUUID().slice(0, 8)}`;
    const result = await processInboundClockEvent({
      id: externalId,
      employeeEmail: ctx.employeeEmail,
      siteName: ctx.siteName,
      clockInTime: new Date(clockIn.getTime() + 3 * 60 * 1000).toISOString(),
      updatedAt: "2026-07-03T10:00:00.000Z",
    });

    expect(result.action).toBe("updated");
    expect(result.mergedExisting).toBe(true);
    expect(result.secureopsId).toBe(local.id);

    // Exactly one row for this officer — the merge, not a new insert.
    const rows = await db
      .select()
      .from(timeEntriesTable)
      .where(eq(timeEntriesTable.employeeId, ctx.employeeId));
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(local.id);
    expect(rows[0].externalId).toBe(externalId);
    expect(rows[0].externalSource).toBe(SCHEDULER_SOURCE);
  });

  it("creates a separate row when the clock-in is outside the ±5 min window", async () => {
    const clockIn = new Date("2026-07-04T09:00:00.000Z");

    await db.insert(timeEntriesTable).values({
      employeeId: ctx.employeeId,
      siteId: ctx.siteId,
      clockInTime: clockIn,
      approvalStatus: "pending",
      isVerified: false,
      syncSource: "local",
    });

    // 20 minutes later — well outside tolerance, so this is a new entry.
    const externalId = `${TAG}-clock-far-${randomUUID().slice(0, 8)}`;
    const result = await processInboundClockEvent({
      id: externalId,
      employeeEmail: ctx.employeeEmail,
      siteName: ctx.siteName,
      clockInTime: new Date(clockIn.getTime() + 20 * 60 * 1000).toISOString(),
      updatedAt: "2026-07-04T10:00:00.000Z",
    });

    expect(result.action).toBe("created");

    const rows = await db
      .select({ id: timeEntriesTable.id })
      .from(timeEntriesTable)
      .where(eq(timeEntriesTable.employeeId, ctx.employeeId));
    expect(rows).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// 3. Reconcile job: advances the cursor and skips already-synced entries.
// ---------------------------------------------------------------------------

describe("scheduler reconciliation job", () => {
  const CURSOR_C1 = "2026-07-10T00:00:00.000Z";
  const CURSOR_C2 = "2026-07-11T00:00:00.000Z";

  beforeEach(async () => {
    process.env.SCHEDULER_BASE_URL = "https://scheduler.example.com";
    process.env.SCHEDULER_SHARED_SECRET = SECRET;
    // Start from a clean cursor so assertions are deterministic.
    await db
      .delete(schedulerSyncCursorsTable)
      .where(eq(schedulerSyncCursorsTable.cursorKey, "shifts"));
    vi.restoreAllMocks();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await db
      .delete(schedulerSyncCursorsTable)
      .where(eq(schedulerSyncCursorsTable.cursorKey, "shifts"));
  });

  it("applies a delta, advances the cursor, then skips already-synced entries on the next pull", async () => {
    const externalId = `${TAG}-recon-${randomUUID().slice(0, 8)}`;
    const shiftPayload = {
      id: externalId,
      title: `${TAG} Reconciled Shift`,
      siteName: ctx.siteName,
      startTime: "2026-07-15T08:00:00.000Z",
      endTime: "2026-07-15T16:00:00.000Z",
      payRate: "21",
      billRate: "29",
      requiredLicenseLevel: 2,
      headcount: 1,
      status: "upcoming",
      // Past-dated so the second pull of this unchanged shift is skipped by
      // the last-write-wins tiebreaker (see the webhook idempotency test).
      updatedAt: "2025-01-01T00:00:00.000Z",
    };

    // The delta endpoint returns the SAME shift each call; nextCursor advances
    // based on the `since` the job sends, so we can drive two ticks.
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (_url, opts) => {
        const sent = JSON.parse((opts?.body as string) ?? "{}") as { since?: string };
        const nextCursor = sent.since === CURSOR_C1 ? CURSOR_C2 : CURSOR_C1;
        return new Response(
          JSON.stringify({ shifts: [shiftPayload], clockEvents: [], nextCursor }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      });

    // --- First tick: creates the shift, advances cursor to C1.
    await runSchedulerReconciliation();

    const afterFirst = await db
      .select()
      .from(shiftsTable)
      .where(
        and(
          eq(shiftsTable.externalSource, SCHEDULER_SOURCE),
          eq(shiftsTable.externalId, externalId),
        ),
      );
    expect(afterFirst).toHaveLength(1);

    const [cursor1] = await db
      .select()
      .from(schedulerSyncCursorsTable)
      .where(eq(schedulerSyncCursorsTable.cursorKey, "shifts"));
    expect(cursor1.cursorValue).toBe(CURSOR_C1);
    expect(cursor1.lastSyncError).toBeNull();
    expect(cursor1.lastSyncShiftsProcessed).toBe("1");

    // --- Second tick: same shift + same updatedAt -> skipped (already synced),
    //     no duplicate row, but the cursor still advances to C2.
    await runSchedulerReconciliation();

    const afterSecond = await db
      .select()
      .from(shiftsTable)
      .where(
        and(
          eq(shiftsTable.externalSource, SCHEDULER_SOURCE),
          eq(shiftsTable.externalId, externalId),
        ),
      );
    expect(afterSecond).toHaveLength(1);

    const [cursor2] = await db
      .select()
      .from(schedulerSyncCursorsTable)
      .where(eq(schedulerSyncCursorsTable.cursorKey, "shifts"));
    expect(cursor2.cursorValue).toBe(CURSOR_C2);
    // The skipped entry is not counted as processed.
    expect(cursor2.lastSyncShiftsProcessed).toBe("0");

    // The job sent the stored cursor as `since` on the second pull.
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const secondCallBody = JSON.parse(
      (fetchSpy.mock.calls[1][1]?.body as string) ?? "{}",
    ) as { since?: string };
    expect(secondCallBody.since).toBe(CURSOR_C1);
  });

  it("records lastSyncError and holds the cursor when the delta fetch fails", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("oops", { status: 502 }));

    await runSchedulerReconciliation();

    const [cursor] = await db
      .select()
      .from(schedulerSyncCursorsTable)
      .where(eq(schedulerSyncCursorsTable.cursorKey, "shifts"));
    expect(cursor).toBeTruthy();
    expect(cursor.lastSyncError).toBeTruthy();
    // Cursor stays at the epoch default — a failed pull must not advance it.
    expect(cursor.cursorValue).toBe("1970-01-01T00:00:00.000Z");
  });
});
