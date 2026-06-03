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
import { processInboundClockEvent, processInboundShift } from "../routes/schedulerWebhook";
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
      // The first pull writes this row as syncSource='scheduler' with
      // externalUpdatedAt = this timestamp. The second pull carries the SAME
      // updatedAt, so the scheduler-vs-scheduler comparison ("strictly newer
      // than externalUpdatedAt") is not satisfied and the re-pull is skipped.
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
// 2b. Last-write-wins conflict resolution: a genuinely-newer scheduler update
//     overwrites the local row; an older scheduler update is ignored so local
//     edits survive. Guards against a regression that flips the comparison
//     direction or compares the wrong timestamp (which would silently corrupt
//     shift / clock data).
//
//     The tiebreaker compares the incoming payload.updatedAt against the LOCAL
//     row's wall-clock `updated_at` (set the moment SecureOps last wrote it).
//     Local rows below are inserted "now", so a far-future payload is genuinely
//     newer and a far-past payload is genuinely older — independent of clock skew.
// ---------------------------------------------------------------------------

describe("last-write-wins: newer scheduler update applies, older one is ignored", () => {
  const FAR_FUTURE = "2999-01-01T00:00:00.000Z";
  const FAR_PAST = "2000-01-01T00:00:00.000Z";

  afterEach(async () => {
    await db.execute(
      sql`DELETE FROM time_entries WHERE employee_id = ${ctx.employeeId}::uuid`,
    );
  });

  // --- Shifts (processInboundShift) -----------------------------------------

  it("processInboundShift: a newer scheduler update overwrites the local row", async () => {
    const externalId = `${TAG}-lww-shift-new-${randomUUID().slice(0, 8)}`;

    // Local row written "now" — its wall-clock updated_at is the comparison base.
    const [local] = await db
      .insert(shiftsTable)
      .values({
        title: `${TAG} Local Title`,
        siteId: ctx.siteId,
        startTime: new Date("2026-08-01T08:00:00.000Z"),
        endTime: new Date("2026-08-01T16:00:00.000Z"),
        payRate: "10",
        billRate: "20",
        headcount: 1,
        requiredLicenseLevel: 2,
        status: "upcoming",
        externalId,
        externalSource: SCHEDULER_SOURCE,
        externalUpdatedAt: new Date(FAR_PAST),
        syncSource: "local",
      })
      .returning({ id: shiftsTable.id });

    const result = await processInboundShift({
      id: externalId,
      title: `${TAG} Scheduler Title`,
      siteName: ctx.siteName,
      startTime: "2026-08-01T09:00:00.000Z",
      endTime: "2026-08-01T17:00:00.000Z",
      payRate: "25",
      billRate: "35",
      requiredLicenseLevel: 3,
      headcount: 4,
      status: "upcoming",
      updatedAt: FAR_FUTURE,
    });

    expect(result.action).toBe("updated");
    expect(result.secureopsId).toBe(local.id);

    const [row] = await db
      .select()
      .from(shiftsTable)
      .where(eq(shiftsTable.id, local.id));
    // Fields actually changed to the scheduler's values.
    expect(row.title).toBe(`${TAG} Scheduler Title`);
    expect(row.payRate).toBe("25.00");
    expect(row.billRate).toBe("35.00");
    expect(row.headcount).toBe(4);
    expect(row.requiredLicenseLevel).toBe(3);
    expect(row.syncSource).toBe(SCHEDULER_SOURCE);
  });

  it("processInboundShift: an older scheduler update is skipped (local edits preserved)", async () => {
    const externalId = `${TAG}-lww-shift-old-${randomUUID().slice(0, 8)}`;

    const [local] = await db
      .insert(shiftsTable)
      .values({
        title: `${TAG} Local Wins Title`,
        siteId: ctx.siteId,
        startTime: new Date("2026-08-02T08:00:00.000Z"),
        endTime: new Date("2026-08-02T16:00:00.000Z"),
        payRate: "15",
        billRate: "22",
        headcount: 2,
        requiredLicenseLevel: 2,
        status: "upcoming",
        externalId,
        externalSource: SCHEDULER_SOURCE,
        externalUpdatedAt: new Date(FAR_PAST),
        syncSource: "local",
      })
      .returning({ id: shiftsTable.id });

    const result = await processInboundShift({
      id: externalId,
      title: `${TAG} Stale Scheduler Title`,
      siteName: ctx.siteName,
      startTime: "2026-08-02T09:00:00.000Z",
      endTime: "2026-08-02T17:00:00.000Z",
      payRate: "99",
      billRate: "99",
      requiredLicenseLevel: 4,
      headcount: 9,
      status: "cancelled",
      updatedAt: FAR_PAST,
    });

    expect(result.action).toBe("skipped");
    expect(result.secureopsId).toBe(local.id);

    const [row] = await db
      .select()
      .from(shiftsTable)
      .where(eq(shiftsTable.id, local.id));
    // Nothing changed — the stale scheduler payload was rejected.
    expect(row.title).toBe(`${TAG} Local Wins Title`);
    expect(row.payRate).toBe("15.00");
    expect(row.billRate).toBe("22.00");
    expect(row.headcount).toBe(2);
    expect(row.requiredLicenseLevel).toBe(2);
    expect(row.status).toBe("upcoming");
  });

  // --- Clock events (processInboundClockEvent) ------------------------------

  it("processInboundClockEvent: a newer scheduler update overwrites the local row", async () => {
    const externalId = `${TAG}-lww-clock-new-${randomUUID().slice(0, 8)}`;
    const clockIn = new Date("2026-08-03T09:00:00.000Z");

    // Matched by externalId (not the ±5 min dedup path), so the tiebreaker runs.
    const [local] = await db
      .insert(timeEntriesTable)
      .values({
        employeeId: ctx.employeeId,
        siteId: ctx.siteId,
        clockInTime: clockIn,
        clockOutTime: null,
        hoursWorked: null,
        approvalStatus: "pending",
        isVerified: false,
        externalId,
        externalSource: SCHEDULER_SOURCE,
        externalUpdatedAt: new Date(FAR_PAST),
        syncSource: "local",
      })
      .returning({ id: timeEntriesTable.id });

    const result = await processInboundClockEvent({
      id: externalId,
      employeeEmail: ctx.employeeEmail,
      siteName: ctx.siteName,
      clockInTime: clockIn.toISOString(),
      clockOutTime: new Date(clockIn.getTime() + 8 * 3600 * 1000).toISOString(),
      updatedAt: FAR_FUTURE,
    });

    expect(result.action).toBe("updated");
    expect(result.secureopsId).toBe(local.id);

    const [row] = await db
      .select()
      .from(timeEntriesTable)
      .where(eq(timeEntriesTable.id, local.id));
    // The clock-out + hours were filled in by the newer scheduler update.
    expect(row.clockOutTime).not.toBeNull();
    expect(Number(row.hoursWorked)).toBe(8);
    expect(row.syncSource).toBe(SCHEDULER_SOURCE);
  });

  it("processInboundClockEvent: an older scheduler update is skipped (local edits preserved)", async () => {
    const externalId = `${TAG}-lww-clock-old-${randomUUID().slice(0, 8)}`;
    const clockIn = new Date("2026-08-04T09:00:00.000Z");
    const localClockOut = new Date(clockIn.getTime() + 4 * 3600 * 1000);

    const [local] = await db
      .insert(timeEntriesTable)
      .values({
        employeeId: ctx.employeeId,
        siteId: ctx.siteId,
        clockInTime: clockIn,
        clockOutTime: localClockOut,
        hoursWorked: "4",
        approvalStatus: "pending",
        isVerified: false,
        externalId,
        externalSource: SCHEDULER_SOURCE,
        externalUpdatedAt: new Date(FAR_PAST),
        syncSource: "local",
      })
      .returning({ id: timeEntriesTable.id });

    const result = await processInboundClockEvent({
      id: externalId,
      employeeEmail: ctx.employeeEmail,
      siteName: ctx.siteName,
      clockInTime: clockIn.toISOString(),
      // A stale update that would have rewritten the clock-out to 10h.
      clockOutTime: new Date(clockIn.getTime() + 10 * 3600 * 1000).toISOString(),
      updatedAt: FAR_PAST,
    });

    expect(result.action).toBe("skipped");
    expect(result.secureopsId).toBe(local.id);

    const [row] = await db
      .select()
      .from(timeEntriesTable)
      .where(eq(timeEntriesTable.id, local.id));
    // Local clock-out + hours untouched by the stale scheduler payload.
    expect(Number(row.hoursWorked)).toBe(4);
    expect(new Date(row.clockOutTime!).toISOString()).toBe(localClockOut.toISOString());
  });
});


// ---------------------------------------------------------------------------
// 2c. Delete path: an inbound delete payload removes the matching local row by
//     externalId; an unknown externalId is a no-op ("skipped" / "not found").
//     Guards against a regression that deletes the wrong row, deletes nothing
//     when it should, or silently leaves stale shifts/clock entries behind.
// ---------------------------------------------------------------------------

describe("delete path: removes the matching row, no-ops on unknown externalId", () => {
  afterEach(async () => {
    await db.execute(
      sql`DELETE FROM time_entries WHERE employee_id = ${ctx.employeeId}::uuid`,
    );
  });

  // --- Shifts (processInboundShift) -----------------------------------------

  it("processInboundShift: a delete payload removes the existing scheduler-originated shift", async () => {
    const externalId = `${TAG}-del-shift-${randomUUID().slice(0, 8)}`;

    const [local] = await db
      .insert(shiftsTable)
      .values({
        title: `${TAG} Doomed Shift`,
        siteId: ctx.siteId,
        startTime: new Date("2026-09-01T08:00:00.000Z"),
        endTime: new Date("2026-09-01T16:00:00.000Z"),
        payRate: "20",
        billRate: "30",
        headcount: 1,
        requiredLicenseLevel: 2,
        status: "upcoming",
        externalId,
        externalSource: SCHEDULER_SOURCE,
        syncSource: SCHEDULER_SOURCE,
      })
      .returning({ id: shiftsTable.id });

    const result = await processInboundShift({
      id: externalId,
      updatedAt: "2026-09-02T00:00:00.000Z",
      deleted: true,
    });

    expect(result.action).toBe("deleted");
    expect(result.secureopsId).toBe(local.id);

    // The row is actually gone — no stale shift left behind.
    const rows = await db
      .select({ id: shiftsTable.id })
      .from(shiftsTable)
      .where(eq(shiftsTable.id, local.id));
    expect(rows).toHaveLength(0);
  });

  it("processInboundShift: a delete for an unknown externalId is skipped and deletes nothing", async () => {
    // A bystander scheduler-originated shift that must survive an unrelated delete.
    const survivorExternalId = `${TAG}-del-shift-survivor-${randomUUID().slice(0, 8)}`;
    const [survivor] = await db
      .insert(shiftsTable)
      .values({
        title: `${TAG} Survivor Shift`,
        siteId: ctx.siteId,
        startTime: new Date("2026-09-03T08:00:00.000Z"),
        endTime: new Date("2026-09-03T16:00:00.000Z"),
        payRate: "20",
        billRate: "30",
        headcount: 1,
        requiredLicenseLevel: 2,
        status: "upcoming",
        externalId: survivorExternalId,
        externalSource: SCHEDULER_SOURCE,
        syncSource: SCHEDULER_SOURCE,
      })
      .returning({ id: shiftsTable.id });

    const result = await processInboundShift({
      id: `${TAG}-del-shift-nonexistent-${randomUUID().slice(0, 8)}`,
      updatedAt: "2026-09-04T00:00:00.000Z",
      deleted: true,
    });

    expect(result.action).toBe("skipped");
    expect(result.skipReason).toBe("not found");
    expect(result.secureopsId).toBeUndefined();

    // The unrelated shift is untouched — the delete targeted nothing.
    const rows = await db
      .select({ id: shiftsTable.id })
      .from(shiftsTable)
      .where(eq(shiftsTable.id, survivor.id));
    expect(rows).toHaveLength(1);
  });

  // --- Clock events (processInboundClockEvent) ------------------------------

  it("processInboundClockEvent: a delete payload removes the existing scheduler-originated entry", async () => {
    const externalId = `${TAG}-del-clock-${randomUUID().slice(0, 8)}`;

    const [local] = await db
      .insert(timeEntriesTable)
      .values({
        employeeId: ctx.employeeId,
        siteId: ctx.siteId,
        clockInTime: new Date("2026-09-05T09:00:00.000Z"),
        approvalStatus: "pending",
        isVerified: false,
        externalId,
        externalSource: SCHEDULER_SOURCE,
        syncSource: SCHEDULER_SOURCE,
      })
      .returning({ id: timeEntriesTable.id });

    const result = await processInboundClockEvent({
      id: externalId,
      action: "delete",
      employeeEmail: "",
      clockInTime: "",
      updatedAt: "2026-09-06T00:00:00.000Z",
    });

    expect(result.action).toBe("deleted");
    expect(result.secureopsId).toBe(local.id);

    // The row is actually gone — no stale clock entry left behind.
    const rows = await db
      .select({ id: timeEntriesTable.id })
      .from(timeEntriesTable)
      .where(eq(timeEntriesTable.id, local.id));
    expect(rows).toHaveLength(0);
  });

  it("processInboundClockEvent: a delete for an unknown externalId is skipped and deletes nothing", async () => {
    // A bystander scheduler-originated clock entry that must survive.
    const survivorExternalId = `${TAG}-del-clock-survivor-${randomUUID().slice(0, 8)}`;
    const [survivor] = await db
      .insert(timeEntriesTable)
      .values({
        employeeId: ctx.employeeId,
        siteId: ctx.siteId,
        clockInTime: new Date("2026-09-07T09:00:00.000Z"),
        approvalStatus: "pending",
        isVerified: false,
        externalId: survivorExternalId,
        externalSource: SCHEDULER_SOURCE,
        syncSource: SCHEDULER_SOURCE,
      })
      .returning({ id: timeEntriesTable.id });

    const result = await processInboundClockEvent({
      id: `${TAG}-del-clock-nonexistent-${randomUUID().slice(0, 8)}`,
      action: "delete",
      employeeEmail: "",
      clockInTime: "",
      updatedAt: "2026-09-08T00:00:00.000Z",
    });

    expect(result.action).toBe("skipped");
    expect(result.skipReason).toBe("not found");
    expect(result.secureopsId).toBeUndefined();

    // The unrelated entry is untouched — the delete targeted nothing.
    const rows = await db
      .select({ id: timeEntriesTable.id })
      .from(timeEntriesTable)
      .where(eq(timeEntriesTable.id, survivor.id));
    expect(rows).toHaveLength(1);
  });
});


// ---------------------------------------------------------------------------
// 2d. Clock-skew resistance: when the row was last written BY the scheduler
//     (syncSource='scheduler'), the tiebreaker compares the incoming updatedAt
//     against the stored externalUpdatedAt (the scheduler's OWN previous
//     timestamp) — same clock, apples-to-apples — NOT against SecureOps's
//     wall-clock updated_at. This makes conflict resolution correct even when
//     the two systems' clocks are skewed:
//       - scheduler ahead: a stale (out-of-order) update is still rejected,
//         even though its timestamp is far ahead of SecureOps's wall clock.
//       - scheduler behind: a genuinely fresh update is still applied, even
//         though its timestamp is older than SecureOps's wall clock.
//     A naive wall-clock comparison would get BOTH of these wrong.
// ---------------------------------------------------------------------------

describe("conflict resolution is resistant to clock skew between SecureOps and the scheduler", () => {
  afterEach(async () => {
    await db.execute(
      sql`DELETE FROM time_entries WHERE employee_id = ${ctx.employeeId}::uuid`,
    );
  });

  it("processInboundShift: rejects a stale scheduler update when the scheduler clock runs AHEAD", async () => {
    const externalId = `${TAG}-skew-ahead-${randomUUID().slice(0, 8)}`;

    // Row last written by the scheduler. externalUpdatedAt is the scheduler's
    // own clock (running ahead). The wall-clock updated_at lags far behind, so
    // a naive comparison would wrongly accept the stale payload below.
    const [local] = await db
      .insert(shiftsTable)
      .values({
        title: `${TAG} Last Scheduler Write`,
        siteId: ctx.siteId,
        startTime: new Date("2026-09-01T08:00:00.000Z"),
        endTime: new Date("2026-09-01T16:00:00.000Z"),
        payRate: "20",
        billRate: "30",
        headcount: 2,
        requiredLicenseLevel: 2,
        status: "upcoming",
        externalId,
        externalSource: SCHEDULER_SOURCE,
        externalUpdatedAt: new Date("2030-01-02T00:00:00.000Z"),
        updatedAt: new Date("2026-09-01T00:00:00.000Z"),
        syncSource: SCHEDULER_SOURCE,
      })
      .returning({ id: shiftsTable.id });

    const result = await processInboundShift({
      id: externalId,
      title: `${TAG} Stale Reorder`,
      siteName: ctx.siteName,
      startTime: "2026-09-01T09:00:00.000Z",
      endTime: "2026-09-01T17:00:00.000Z",
      payRate: "99",
      billRate: "99",
      requiredLicenseLevel: 4,
      headcount: 9,
      status: "cancelled",
      // Older than externalUpdatedAt, but still far ahead of the wall clock.
      updatedAt: "2030-01-01T00:00:00.000Z",
    });

    expect(result.action).toBe("skipped");
    expect(result.secureopsId).toBe(local.id);

    const [row] = await db
      .select()
      .from(shiftsTable)
      .where(eq(shiftsTable.id, local.id));
    expect(row.title).toBe(`${TAG} Last Scheduler Write`);
    expect(row.payRate).toBe("20.00");
    expect(row.headcount).toBe(2);
    expect(row.requiredLicenseLevel).toBe(2);
    expect(row.status).toBe("upcoming");
  });

  it("processInboundShift: applies a fresh scheduler update when the scheduler clock LAGS", async () => {
    const externalId = `${TAG}-skew-lag-${randomUUID().slice(0, 8)}`;

    // Row last written by the scheduler with a lagging clock; the wall-clock
    // updated_at is far ahead, so a naive comparison would wrongly skip the
    // genuinely-newer payload below.
    const [local] = await db
      .insert(shiftsTable)
      .values({
        title: `${TAG} Old Scheduler Write`,
        siteId: ctx.siteId,
        startTime: new Date("2026-09-02T08:00:00.000Z"),
        endTime: new Date("2026-09-02T16:00:00.000Z"),
        payRate: "20",
        billRate: "30",
        headcount: 1,
        requiredLicenseLevel: 2,
        status: "upcoming",
        externalId,
        externalSource: SCHEDULER_SOURCE,
        externalUpdatedAt: new Date("2020-01-01T00:00:00.000Z"),
        updatedAt: new Date("2026-09-02T00:00:00.000Z"),
        syncSource: SCHEDULER_SOURCE,
      })
      .returning({ id: shiftsTable.id });

    const result = await processInboundShift({
      id: externalId,
      title: `${TAG} Fresh Update`,
      siteName: ctx.siteName,
      startTime: "2026-09-02T09:00:00.000Z",
      endTime: "2026-09-02T17:00:00.000Z",
      payRate: "27",
      billRate: "37",
      requiredLicenseLevel: 3,
      headcount: 5,
      status: "upcoming",
      // Newer than externalUpdatedAt, but older than the wall clock.
      updatedAt: "2020-01-02T00:00:00.000Z",
    });

    expect(result.action).toBe("updated");
    expect(result.secureopsId).toBe(local.id);

    const [row] = await db
      .select()
      .from(shiftsTable)
      .where(eq(shiftsTable.id, local.id));
    expect(row.title).toBe(`${TAG} Fresh Update`);
    expect(row.payRate).toBe("27.00");
    expect(row.billRate).toBe("37.00");
    expect(row.headcount).toBe(5);
    expect(row.requiredLicenseLevel).toBe(3);
  });

  it("processInboundClockEvent: rejects a stale scheduler update when the scheduler clock runs AHEAD", async () => {
    const externalId = `${TAG}-skew-clock-${randomUUID().slice(0, 8)}`;
    const clockIn = new Date("2026-09-03T09:00:00.000Z");
    const localClockOut = new Date(clockIn.getTime() + 4 * 3600 * 1000);

    const [local] = await db
      .insert(timeEntriesTable)
      .values({
        employeeId: ctx.employeeId,
        siteId: ctx.siteId,
        clockInTime: clockIn,
        clockOutTime: localClockOut,
        hoursWorked: "4",
        approvalStatus: "pending",
        isVerified: false,
        externalId,
        externalSource: SCHEDULER_SOURCE,
        externalUpdatedAt: new Date("2030-01-02T00:00:00.000Z"),
        updatedAt: new Date("2026-09-03T00:00:00.000Z"),
        syncSource: SCHEDULER_SOURCE,
      })
      .returning({ id: timeEntriesTable.id });

    const result = await processInboundClockEvent({
      id: externalId,
      employeeEmail: ctx.employeeEmail,
      siteName: ctx.siteName,
      clockInTime: clockIn.toISOString(),
      // Would rewrite the clock-out to 10h if (wrongly) applied.
      clockOutTime: new Date(clockIn.getTime() + 10 * 3600 * 1000).toISOString(),
      // Older than externalUpdatedAt, but still far ahead of the wall clock.
      updatedAt: "2030-01-01T00:00:00.000Z",
    });

    expect(result.action).toBe("skipped");
    expect(result.secureopsId).toBe(local.id);

    const [row] = await db
      .select()
      .from(timeEntriesTable)
      .where(eq(timeEntriesTable.id, local.id));
    expect(Number(row.hoursWorked)).toBe(4);
    expect(new Date(row.clockOutTime!).toISOString()).toBe(localClockOut.toISOString());
  });

  it("processInboundClockEvent: applies a fresh scheduler update when the scheduler clock LAGS", async () => {
    const externalId = `${TAG}-skew-clock-lag-${randomUUID().slice(0, 8)}`;
    const clockIn = new Date("2026-09-05T09:00:00.000Z");

    const [local] = await db
      .insert(timeEntriesTable)
      .values({
        employeeId: ctx.employeeId,
        siteId: ctx.siteId,
        clockInTime: clockIn,
        clockOutTime: null,
        hoursWorked: null,
        approvalStatus: "pending",
        isVerified: false,
        externalId,
        externalSource: SCHEDULER_SOURCE,
        externalUpdatedAt: new Date("2020-01-01T00:00:00.000Z"),
        updatedAt: new Date("2026-09-05T00:00:00.000Z"),
        syncSource: SCHEDULER_SOURCE,
      })
      .returning({ id: timeEntriesTable.id });

    const result = await processInboundClockEvent({
      id: externalId,
      employeeEmail: ctx.employeeEmail,
      siteName: ctx.siteName,
      clockInTime: clockIn.toISOString(),
      clockOutTime: new Date(clockIn.getTime() + 8 * 3600 * 1000).toISOString(),
      // Newer than externalUpdatedAt, but older than the wall clock.
      updatedAt: "2020-01-02T00:00:00.000Z",
    });

    expect(result.action).toBe("updated");
    expect(result.secureopsId).toBe(local.id);

    const [row] = await db
      .select()
      .from(timeEntriesTable)
      .where(eq(timeEntriesTable.id, local.id));
    expect(row.clockOutTime).not.toBeNull();
    expect(Number(row.hoursWorked)).toBe(8);
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
      // After the first tick the row is syncSource='scheduler' with
      // externalUpdatedAt = this timestamp; the second tick carries the same
      // updatedAt, so the scheduler-vs-scheduler tiebreaker skips it (see the
      // webhook idempotency test).
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
