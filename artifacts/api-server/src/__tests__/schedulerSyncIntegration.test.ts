import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  db,
  usersTable,
  clientsTable,
  sitesTable,
  shiftsTable,
  shiftAssignmentsTable,
  licensesTable,
  timeEntriesTable,
  schedulerSyncCursorsTable,
} from "@workspace/db";
import app from "../app";
import { signPayload, SCHEDULER_SOURCE } from "../lib/schedulerSync";
import { processInboundClockEvent, processInboundShift, webhookRateLimitStore } from "../routes/schedulerWebhook";
import { runSchedulerReconciliation } from "../lib/scheduledJobs";
import { signToken } from "../middlewares/auth";

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

  it("skips the merge when the local entry is newer than the inbound scheduler event", async () => {
    const clockIn = new Date("2026-07-05T09:00:00.000Z");
    const localClockOut = new Date(clockIn.getTime() + 4 * 3600 * 1000);

    // A pre-existing local clock-in the officer has already clocked out of
    // (real local clock-out + hours). Inserted "now", so its wall-clock
    // updated_at is far newer than the stale scheduler timestamp below.
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
        syncSource: "local",
      })
      .returning({ id: timeEntriesTable.id });

    // A late / out-of-order scheduler event within the ±5 min window, but stamped
    // far in the past — it would have rewritten the clock-out to 10h and linked
    // its external ID onto the newer local entry.
    const externalId = `${TAG}-clock-stale-${randomUUID().slice(0, 8)}`;
    const result = await processInboundClockEvent({
      id: externalId,
      employeeEmail: ctx.employeeEmail,
      siteName: ctx.siteName,
      clockInTime: new Date(clockIn.getTime() + 2 * 60 * 1000).toISOString(),
      clockOutTime: new Date(clockIn.getTime() + 10 * 3600 * 1000).toISOString(),
      updatedAt: "2000-01-01T00:00:00.000Z",
    });

    expect(result.action).toBe("skipped");
    expect(result.secureopsId).toBe(local.id);

    // The local row is untouched: data preserved AND not linked to the scheduler.
    const rows = await db
      .select()
      .from(timeEntriesTable)
      .where(eq(timeEntriesTable.employeeId, ctx.employeeId));
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(local.id);
    expect(rows[0].externalId).toBeNull();
    expect(rows[0].externalSource).toBeNull();
    expect(Number(rows[0].hoursWorked)).toBe(4);
    expect(new Date(rows[0].clockOutTime!).toISOString()).toBe(localClockOut.toISOString());
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
// 2d. Delete path over the HTTP webhook routes (end-to-end).
//     The unit-level delete logic above is exercised against
//     processInbound{Shift,ClockEvent} directly, but the HTTP routes that wrap
//     them are only ever tested for upserts. A delete payload omits almost all
//     fields (no title/startTime/employeeEmail/clockInTime) — exactly the shape
//     most likely to trip the InboundShiftSchema / InboundClockEventSchema Zod
//     validation or the canonical mapping (deleted / action). These tests post
//     a signed { action: "delete" } body through the real router so a 400 from
//     request validation, or a mis-set `deleted` flag, would be caught.
// ---------------------------------------------------------------------------

describe("delete over the HTTP webhook routes (signed payloads)", () => {
  beforeEach(() => {
    process.env.SCHEDULER_BASE_URL = "https://scheduler.example.com";
    process.env.SCHEDULER_SHARED_SECRET = SECRET;
    vi.restoreAllMocks();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await db.execute(
      sql`DELETE FROM time_entries WHERE employee_id = ${ctx.employeeId}::uuid`,
    );
  });

  function postShift(body: object) {
    const s = JSON.stringify(body);
    return request(app)
      .post("/api/scheduler-webhook/shifts")
      .set("Content-Type", "application/json")
      .set("X-WCSG-Signature", signPayload(s, SECRET))
      .send(s);
  }

  function postClockEvent(body: object) {
    const s = JSON.stringify(body);
    return request(app)
      .post("/api/scheduler-webhook/clock-events")
      .set("Content-Type", "application/json")
      .set("X-WCSG-Signature", signPayload(s, SECRET))
      .send(s);
  }

  it("POST /scheduler-webhook/shifts with action:'delete' returns 200 + deleted and removes the row", async () => {
    const externalId = `${TAG}-http-del-shift-${randomUUID().slice(0, 8)}`;
    const [local] = await db
      .insert(shiftsTable)
      .values({
        title: `${TAG} HTTP Doomed Shift`,
        siteId: ctx.siteId,
        startTime: new Date("2026-10-01T08:00:00.000Z"),
        endTime: new Date("2026-10-01T16:00:00.000Z"),
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

    // A delete-shaped payload: only id / action / updatedAt — no title,
    // startTime or endTime. This must pass Zod validation and map to deleted.
    const res = await postShift({
      id: externalId,
      action: "delete",
      updatedAt: "2026-10-02T00:00:00.000Z",
    });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, action: "deleted" });
    expect(res.body.secureopsId).toBe(local.id);

    const rows = await db
      .select({ id: shiftsTable.id })
      .from(shiftsTable)
      .where(eq(shiftsTable.id, local.id));
    expect(rows).toHaveLength(0);
  });

  it("POST /scheduler-webhook/shifts delete for an unknown externalId returns 200 + skipped", async () => {
    const res = await postShift({
      id: `${TAG}-http-del-shift-nonexistent-${randomUUID().slice(0, 8)}`,
      action: "delete",
      updatedAt: "2026-10-03T00:00:00.000Z",
    });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, action: "skipped" });
    expect(res.body.skipReason).toBe("not found");
  });

  it("POST /scheduler-webhook/clock-events with action:'delete' returns 200 + deleted and removes the row", async () => {
    const externalId = `${TAG}-http-del-clock-${randomUUID().slice(0, 8)}`;
    const [local] = await db
      .insert(timeEntriesTable)
      .values({
        employeeId: ctx.employeeId,
        siteId: ctx.siteId,
        clockInTime: new Date("2026-10-04T09:00:00.000Z"),
        approvalStatus: "pending",
        isVerified: false,
        externalId,
        externalSource: SCHEDULER_SOURCE,
        syncSource: SCHEDULER_SOURCE,
      })
      .returning({ id: timeEntriesTable.id });

    // No employeeEmail / clockInTime — the delete-shaped payload that the
    // route's Zod schema (employeeEmail/clockInTime optional) must accept.
    const res = await postClockEvent({
      id: externalId,
      action: "delete",
      updatedAt: "2026-10-05T00:00:00.000Z",
    });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, action: "deleted" });
    expect(res.body.secureopsId).toBe(local.id);

    const rows = await db
      .select({ id: timeEntriesTable.id })
      .from(timeEntriesTable)
      .where(eq(timeEntriesTable.id, local.id));
    expect(rows).toHaveLength(0);
  });

  it("POST /scheduler-webhook/clock-events delete for an unknown externalId returns 200 + skipped", async () => {
    const res = await postClockEvent({
      id: `${TAG}-http-del-clock-nonexistent-${randomUUID().slice(0, 8)}`,
      action: "delete",
      updatedAt: "2026-10-06T00:00:00.000Z",
    });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, action: "skipped" });
    expect(res.body.skipReason).toBe("not found");
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

  it("reconciles assignedOfficerEmails through the reconcile job (add + remove via the periodic pull)", async () => {
    // A second officer so we can assert add + remove across two pulls.
    const otherEmail = `${TAG}-recon-officer2-${randomUUID().slice(0, 6)}@example.test`;
    const [other] = await db
      .insert(usersTable)
      .values({
        email: otherEmail,
        passwordHash,
        firstName: "ReconSync2",
        lastName: TAG,
        role: "employee",
        status: "active",
        tokensValidAfter: new Date(0),
      })
      .returning({ id: usersTable.id });

    const externalId = `${TAG}-recon-roster-${randomUUID().slice(0, 8)}`;

    // The delta pull carries a FULL roster in `assignedOfficerEmails`, exactly
    // like the webhook payload. The reconcile job must apply it the same way.
    let roster: string[] = [ctx.employeeEmail];
    let updatedAt = "2026-08-01T00:00:00.000Z";
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, opts) => {
      const sent = JSON.parse((opts?.body as string) ?? "{}") as { since?: string };
      return new Response(
        JSON.stringify({
          shifts: [{
            id: externalId,
            title: `${TAG} Recon Roster Shift`,
            siteName: ctx.siteName,
            startTime: "2026-08-15T08:00:00.000Z",
            endTime: "2026-08-15T16:00:00.000Z",
            payRate: "20",
            billRate: "28",
            requiredLicenseLevel: 2,
            headcount: 2,
            status: "upcoming",
            assignedOfficerEmails: roster,
            updatedAt,
          }],
          clockEvents: [],
          nextCursor: `${sent.since}-next`,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    // --- First tick: creates the shift and assigns officer #1.
    await runSchedulerReconciliation();

    const [shift] = await db
      .select({ id: shiftsTable.id })
      .from(shiftsTable)
      .where(and(
        eq(shiftsTable.externalSource, SCHEDULER_SOURCE),
        eq(shiftsTable.externalId, externalId),
      ));
    expect(shift).toBeTruthy();

    const afterCreate = await db
      .select({ employeeId: shiftAssignmentsTable.employeeId, status: shiftAssignmentsTable.status })
      .from(shiftAssignmentsTable)
      .where(eq(shiftAssignmentsTable.shiftId, shift.id));
    expect(afterCreate).toHaveLength(1);
    expect(afterCreate[0].employeeId).toBe(ctx.employeeId);
    expect(afterCreate[0].status).toBe("accepted");

    // --- Second tick: scheduler drops officer #1 and adds officer #2, with a
    //     strictly-newer updatedAt so the shift update wins the tiebreaker.
    roster = [otherEmail];
    updatedAt = "2026-08-02T00:00:00.000Z";
    await runSchedulerReconciliation();

    const afterUpdate = await db
      .select({ employeeId: shiftAssignmentsTable.employeeId })
      .from(shiftAssignmentsTable)
      .where(eq(shiftAssignmentsTable.shiftId, shift.id));
    expect(afterUpdate).toHaveLength(1);
    expect(afterUpdate[0].employeeId).toBe(other.id);

    // Cleanup the shift created by this test (its assignments cascade).
    await db.delete(shiftsTable).where(eq(shiftsTable.id, shift.id));
  });
});

// ---------------------------------------------------------------------------
// 4. Negative paths on the HTTP webhook routes: the security + robustness
//    boundary of an endpoint reachable from the internet. These assert that
//    requireHmac (503 unconfigured / 401 unsigned-or-wrong) and the Zod
//    request schemas (400 malformed) reject bad input BEFORE any DB write.
//    Also covers the assignedOfficerEmails branch that creates assignment
//    rows on a freshly created shift.
// ---------------------------------------------------------------------------

describe("scheduler webhook rejects unsigned and malformed requests", () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await db.execute(
      sql`DELETE FROM shift_assignments WHERE employee_id = ${ctx.employeeId}::uuid`,
    );
    await db.execute(sql`DELETE FROM shifts WHERE external_id LIKE ${TAG + "%"}`);
    await db.execute(
      sql`DELETE FROM time_entries WHERE employee_id = ${ctx.employeeId}::uuid`,
    );
    // Restore env to the fully-configured baseline for the next test.
    process.env.SCHEDULER_BASE_URL = "https://scheduler.example.com";
    process.env.SCHEDULER_SHARED_SECRET = SECRET;
  });

  // --- 503: integration not configured (no shared secret) -------------------

  it("returns 503 when SCHEDULER_SHARED_SECRET is unset", async () => {
    delete process.env.SCHEDULER_SHARED_SECRET;

    const body = JSON.stringify({
      id: `${TAG}-noenv-${randomUUID().slice(0, 8)}`,
      action: "upsert",
      title: `${TAG} No Env`,
      siteName: ctx.siteName,
      startTime: "2026-11-01T08:00:00.000Z",
      endTime: "2026-11-01T16:00:00.000Z",
      updatedAt: "2026-10-31T00:00:00.000Z",
    });

    const res = await request(app)
      .post("/api/scheduler-webhook/shifts")
      .set("Content-Type", "application/json")
      // A signature is irrelevant — the missing-secret guard runs first.
      .set("X-WCSG-Signature", "0".repeat(64))
      .send(body);

    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ error: "Service Unavailable" });
  });

  it("returns 503 on the clock-events route when SCHEDULER_SHARED_SECRET is unset", async () => {
    delete process.env.SCHEDULER_SHARED_SECRET;

    const body = JSON.stringify({
      id: `${TAG}-noenv-clock-${randomUUID().slice(0, 8)}`,
      action: "upsert",
      employeeEmail: ctx.employeeEmail,
      clockInTime: "2026-11-01T09:00:00.000Z",
      updatedAt: "2026-10-31T00:00:00.000Z",
    });

    const res = await request(app)
      .post("/api/scheduler-webhook/clock-events")
      .set("Content-Type", "application/json")
      .set("X-WCSG-Signature", "0".repeat(64))
      .send(body);

    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ error: "Service Unavailable" });
  });

  // --- 401: missing or wrong HMAC signature ---------------------------------

  it("returns 401 when the X-WCSG-Signature header is missing", async () => {
    const body = JSON.stringify({
      id: `${TAG}-unsigned-${randomUUID().slice(0, 8)}`,
      action: "upsert",
      title: `${TAG} Unsigned`,
      siteName: ctx.siteName,
      startTime: "2026-11-02T08:00:00.000Z",
      endTime: "2026-11-02T16:00:00.000Z",
      updatedAt: "2026-11-01T00:00:00.000Z",
    });

    const res = await request(app)
      .post("/api/scheduler-webhook/shifts")
      .set("Content-Type", "application/json")
      .send(body);

    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ error: "Unauthorized" });

    // The unsigned payload must NOT have created a row.
    const rows = await db
      .select({ id: shiftsTable.id })
      .from(shiftsTable)
      .where(eq(shiftsTable.externalId, JSON.parse(body).id));
    expect(rows).toHaveLength(0);
  });

  it("returns 401 when the X-WCSG-Signature is wrong (signed with the wrong secret)", async () => {
    const body = JSON.stringify({
      id: `${TAG}-wrongsig-${randomUUID().slice(0, 8)}`,
      action: "upsert",
      title: `${TAG} Wrong Sig`,
      siteName: ctx.siteName,
      startTime: "2026-11-03T08:00:00.000Z",
      endTime: "2026-11-03T16:00:00.000Z",
      updatedAt: "2026-11-02T00:00:00.000Z",
    });

    const res = await request(app)
      .post("/api/scheduler-webhook/shifts")
      .set("Content-Type", "application/json")
      // Valid 64-char hex HMAC, but computed with a different secret.
      .set("X-WCSG-Signature", signPayload(body, "the-wrong-secret"))
      .send(body);

    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ error: "Unauthorized" });

    const rows = await db
      .select({ id: shiftsTable.id })
      .from(shiftsTable)
      .where(eq(shiftsTable.externalId, JSON.parse(body).id));
    expect(rows).toHaveLength(0);
  });

  it("returns 401 on the clock-events route when the signature is missing", async () => {
    const body = JSON.stringify({
      id: `${TAG}-unsigned-clock-${randomUUID().slice(0, 8)}`,
      action: "upsert",
      employeeEmail: ctx.employeeEmail,
      clockInTime: "2026-11-03T09:00:00.000Z",
      updatedAt: "2026-11-02T00:00:00.000Z",
    });

    const res = await request(app)
      .post("/api/scheduler-webhook/clock-events")
      .set("Content-Type", "application/json")
      .send(body);

    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ error: "Unauthorized" });
  });

  // --- 400: malformed body (passes HMAC, fails Zod) -------------------------

  // Sign the EXACT bytes we send, so the request clears requireHmac and the
  // 400 is unambiguously a Zod validation failure (not an auth failure).
  function postSignedShift(body: object) {
    const s = JSON.stringify(body);
    return request(app)
      .post("/api/scheduler-webhook/shifts")
      .set("Content-Type", "application/json")
      .set("X-WCSG-Signature", signPayload(s, SECRET))
      .send(s);
  }

  function postSignedClockEvent(body: object) {
    const s = JSON.stringify(body);
    return request(app)
      .post("/api/scheduler-webhook/clock-events")
      .set("Content-Type", "application/json")
      .set("X-WCSG-Signature", signPayload(s, SECRET))
      .send(s);
  }

  it("returns 400 when the shift payload is missing updatedAt", async () => {
    const res = await postSignedShift({
      id: `${TAG}-bad-noupdated-${randomUUID().slice(0, 8)}`,
      action: "upsert",
      title: `${TAG} Bad`,
      siteName: ctx.siteName,
      startTime: "2026-11-04T08:00:00.000Z",
      endTime: "2026-11-04T16:00:00.000Z",
      // updatedAt intentionally omitted
    });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: "Bad Request" });
    expect(Array.isArray(res.body.issues)).toBe(true);
    expect(res.body.issues.some((i: { path: (string | number)[] }) => i.path.includes("updatedAt"))).toBe(true);
  });

  it("returns 400 when the shift payload is missing id", async () => {
    const res = await postSignedShift({
      action: "upsert",
      title: `${TAG} Bad No Id`,
      siteName: ctx.siteName,
      startTime: "2026-11-05T08:00:00.000Z",
      endTime: "2026-11-05T16:00:00.000Z",
      updatedAt: "2026-11-04T00:00:00.000Z",
      // id intentionally omitted
    });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: "Bad Request" });
    expect(res.body.issues.some((i: { path: (string | number)[] }) => i.path.includes("id"))).toBe(true);
  });

  it("returns 400 when the shift payload has an invalid action", async () => {
    const res = await postSignedShift({
      id: `${TAG}-bad-action-${randomUUID().slice(0, 8)}`,
      action: "frobnicate",
      title: `${TAG} Bad Action`,
      siteName: ctx.siteName,
      startTime: "2026-11-06T08:00:00.000Z",
      endTime: "2026-11-06T16:00:00.000Z",
      updatedAt: "2026-11-05T00:00:00.000Z",
    });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: "Bad Request" });
    expect(res.body.issues.some((i: { path: (string | number)[] }) => i.path.includes("action"))).toBe(true);
  });

  it("returns 400 when the clock-event payload is missing updatedAt", async () => {
    const res = await postSignedClockEvent({
      id: `${TAG}-bad-clock-noupdated-${randomUUID().slice(0, 8)}`,
      action: "upsert",
      employeeEmail: ctx.employeeEmail,
      clockInTime: "2026-11-06T09:00:00.000Z",
      // updatedAt intentionally omitted
    });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: "Bad Request" });
    expect(res.body.issues.some((i: { path: (string | number)[] }) => i.path.includes("updatedAt"))).toBe(true);
  });

  // --- assignedOfficerEmails: assignment rows created on a new shift --------

  it("creates shift_assignment rows for assignedOfficerEmails on a newly created shift", async () => {
    const externalId = `${TAG}-assign-${randomUUID().slice(0, 8)}`;
    const res = await postSignedShift({
      id: externalId,
      action: "upsert",
      title: `${TAG} Assigned Shift`,
      siteName: ctx.siteName,
      startTime: "2026-11-07T08:00:00.000Z",
      endTime: "2026-11-07T16:00:00.000Z",
      payRate: "22",
      billRate: "30",
      requiredLicenseLevel: 2,
      headcount: 2,
      status: "upcoming",
      assignedOfficerEmails: [ctx.employeeEmail],
      updatedAt: "2026-11-06T00:00:00.000Z",
    });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, action: "created" });
    const shiftId = res.body.secureopsId as string;
    expect(shiftId).toBeTruthy();

    // The assignment row was created for the resolved officer.
    const assignments = await db
      .select()
      .from(shiftAssignmentsTable)
      .where(eq(shiftAssignmentsTable.shiftId, shiftId));
    expect(assignments).toHaveLength(1);
    expect(assignments[0].employeeId).toBe(ctx.employeeId);
    expect(assignments[0].status).toBe("accepted");
  });

  it("ignores assignedOfficerEmails entries that don't resolve to a known officer", async () => {
    const externalId = `${TAG}-assign-unknown-${randomUUID().slice(0, 8)}`;
    const res = await postSignedShift({
      id: externalId,
      action: "upsert",
      title: `${TAG} Assigned Unknown`,
      siteName: ctx.siteName,
      startTime: "2026-11-08T08:00:00.000Z",
      endTime: "2026-11-08T16:00:00.000Z",
      requiredLicenseLevel: 2,
      headcount: 1,
      status: "upcoming",
      assignedOfficerEmails: [`${TAG}-nobody-${randomUUID().slice(0, 8)}@example.test`],
      updatedAt: "2026-11-07T00:00:00.000Z",
    });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, action: "created" });
    const shiftId = res.body.secureopsId as string;

    // Unknown email is silently skipped — no assignment row created.
    const assignments = await db
      .select({ id: shiftAssignmentsTable.id })
      .from(shiftAssignmentsTable)
      .where(eq(shiftAssignmentsTable.shiftId, shiftId));
    expect(assignments).toHaveLength(0);
  });

  it("reconciles assignedOfficerEmails when the scheduler edits an existing shift (add + remove)", async () => {
    // A second officer we can add to / remove from the roster.
    const otherEmail = `${TAG}-officer2-${randomUUID().slice(0, 6)}@example.test`;
    const [other] = await db
      .insert(usersTable)
      .values({
        email: otherEmail,
        passwordHash,
        firstName: "Sync2",
        lastName: TAG,
        role: "employee",
        status: "active",
        tokensValidAfter: new Date(0),
      })
      .returning({ id: usersTable.id });

    const externalId = `${TAG}-assign-update-${randomUUID().slice(0, 8)}`;

    // 1. Create the shift with officer #1 on the roster.
    const created = await postSignedShift({
      id: externalId,
      action: "upsert",
      title: `${TAG} Roster Shift`,
      siteName: ctx.siteName,
      startTime: "2026-11-09T08:00:00.000Z",
      endTime: "2026-11-09T16:00:00.000Z",
      requiredLicenseLevel: 2,
      headcount: 2,
      status: "upcoming",
      assignedOfficerEmails: [ctx.employeeEmail],
      updatedAt: "2026-11-08T00:00:00.000Z",
    });
    expect(created.body).toMatchObject({ ok: true, action: "created" });
    const shiftId = created.body.secureopsId as string;

    const initial = await db
      .select({ employeeId: shiftAssignmentsTable.employeeId })
      .from(shiftAssignmentsTable)
      .where(eq(shiftAssignmentsTable.shiftId, shiftId));
    expect(initial.map((a) => a.employeeId)).toEqual([ctx.employeeId]);

    // 2. The scheduler edits the shift: officer #1 is dropped, officer #2 added.
    //    A strictly-newer updatedAt so the shift update wins the tiebreaker.
    const updated = await postSignedShift({
      id: externalId,
      action: "upsert",
      title: `${TAG} Roster Shift`,
      siteName: ctx.siteName,
      startTime: "2026-11-09T08:00:00.000Z",
      endTime: "2026-11-09T16:00:00.000Z",
      requiredLicenseLevel: 2,
      headcount: 2,
      status: "upcoming",
      assignedOfficerEmails: [otherEmail],
      updatedAt: "2026-11-08T12:00:00.000Z",
    });
    expect(updated.body).toMatchObject({ ok: true, action: "updated" });

    // Roster reconciled: officer #1 removed, officer #2 added.
    const after = await db
      .select({ employeeId: shiftAssignmentsTable.employeeId, status: shiftAssignmentsTable.status })
      .from(shiftAssignmentsTable)
      .where(eq(shiftAssignmentsTable.shiftId, shiftId));
    expect(after).toHaveLength(1);
    expect(after[0].employeeId).toBe(other.id);
    expect(after[0].status).toBe("accepted");

    // 3. A stale edit (older updatedAt) must NOT touch the roster.
    const stale = await postSignedShift({
      id: externalId,
      action: "upsert",
      title: `${TAG} Roster Shift`,
      siteName: ctx.siteName,
      startTime: "2026-11-09T08:00:00.000Z",
      endTime: "2026-11-09T16:00:00.000Z",
      requiredLicenseLevel: 2,
      headcount: 2,
      status: "upcoming",
      assignedOfficerEmails: [ctx.employeeEmail],
      updatedAt: "2026-11-07T00:00:00.000Z",
    });
    expect(stale.body).toMatchObject({ ok: true, action: "skipped" });

    const afterStale = await db
      .select({ employeeId: shiftAssignmentsTable.employeeId })
      .from(shiftAssignmentsTable)
      .where(eq(shiftAssignmentsTable.shiftId, shiftId));
    expect(afterStale.map((a) => a.employeeId)).toEqual([other.id]);
  });
});

// ---------------------------------------------------------------------------
// 5. Assignment sync end-to-end: the real HTTP endpoints the app uses to add
//    and remove officers must drive the correct outbound scheduler push.
//
//    The unit tests already cover pushAssignmentEvent in isolation; what they
//    do NOT prove is that the live handlers wire it up correctly — that the
//    claim / admin-assign / decline routes pass the right action and the
//    parent shift's syncSource so loop prevention actually engages. A wiring
//    slip (wrong origin flag, missing call) would silently stop roster updates
//    from syncing even though the helper is fine. These tests exercise:
//      POST /shifts/:id/claim                       -> action "created"
//      POST /shifts/:id/assignments (admin assign)  -> action "created"
//      PUT  /shifts/:id/assignments/:aid {declined} -> action "deleted"
//    on a LOCAL shift (push fires) and on a scheduler-origin shift (no push).
//
//    The push is fire-and-forget (`void pushAssignmentEvent(...)`), so after
//    the HTTP response we poll the fetch spy for the outbound call.
// ---------------------------------------------------------------------------

describe("assignment endpoints drive the outbound scheduler push end-to-end", () => {
  const ASSIGN_PATH = "/api/secureops-webhook/assignments";

  const lctx = {
    adminId: "",
    adminToken: "",
    officerId: "",
    officerEmail: "",
    officerToken: "",
    officer2Id: "",
    officer2Email: "",
    createdShiftIds: [] as string[],
  };

  function authed(token: string) {
    return { Authorization: `Bearer ${token}` };
  }

  // Outbound fetch calls that targeted the assignment webhook.
  function assignmentCalls(spy: ReturnType<typeof vi.spyOn>) {
    return (spy.mock.calls as unknown[][]).filter((c) =>
      String(c[0]).includes(ASSIGN_PATH),
    );
  }

  // The push is fired with `void` (not awaited by the handler), so the fetch
  // may land a tick or two after the HTTP response. Poll until it shows up.
  async function waitForAssignmentCall(
    spy: ReturnType<typeof vi.spyOn>,
    timeoutMs = 3000,
  ): Promise<unknown[] | undefined> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const calls = assignmentCalls(spy);
      if (calls.length > 0) return calls[0];
      await new Promise((r) => setTimeout(r, 10));
    }
    return undefined;
  }

  function parseBody(call: unknown[]): Record<string, unknown> {
    const init = call[1] as { body?: string } | undefined;
    return JSON.parse(init?.body ?? "{}") as Record<string, unknown>;
  }

  // Create a shift directly in the DB. `scheduler` controls whether the row is
  // stamped as scheduler-originated (which must suppress the outbound push).
  async function makeShift(opts: { scheduler: boolean }): Promise<string> {
    const start = new Date(Date.now() + 6 * 60 * 60 * 1000);
    const end = new Date(start.getTime() + 4 * 60 * 60 * 1000);
    const [row] = await db
      .insert(shiftsTable)
      .values({
        title: `${TAG} Assign E2E`,
        siteId: ctx.siteId,
        startTime: start,
        endTime: end,
        payRate: "22",
        billRate: "30",
        requiredLicenseLevel: 2,
        headcount: 5,
        status: "upcoming",
        ...(opts.scheduler
          ? {
              externalId: `${TAG}-assign-${randomUUID().slice(0, 8)}`,
              externalSource: SCHEDULER_SOURCE,
              syncSource: SCHEDULER_SOURCE,
            }
          : { syncSource: "local" }),
      })
      .returning({ id: shiftsTable.id });
    lctx.createdShiftIds.push(row.id);
    return row.id;
  }

  beforeAll(async () => {
    const futureDate = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);

    const adminEmail = `${TAG}-admin-${randomUUID().slice(0, 6)}@example.test`;
    const [admin] = await db
      .insert(usersTable)
      .values({
        email: adminEmail,
        passwordHash,
        firstName: "Admin",
        lastName: TAG,
        role: "admin",
        status: "active",
        tokensValidAfter: new Date(0),
      })
      .returning({ id: usersTable.id });
    lctx.adminId = admin.id;
    lctx.adminToken = signToken({ userId: admin.id, email: adminEmail, role: "admin" });

    // Two officers, each with a level-3 licence that covers the level-2 shifts
    // created above (claim/admin-assign both gate on effective licence level).
    const officerEmail = `${TAG}-officer-e2e-${randomUUID().slice(0, 6)}@example.test`;
    const [officer] = await db
      .insert(usersTable)
      .values({
        email: officerEmail,
        passwordHash,
        firstName: "Officer",
        lastName: TAG,
        role: "employee",
        status: "active",
        tokensValidAfter: new Date(0),
      })
      .returning({ id: usersTable.id });
    lctx.officerId = officer.id;
    lctx.officerEmail = officerEmail;
    lctx.officerToken = signToken({ userId: officer.id, email: officerEmail, role: "employee" });

    const officer2Email = `${TAG}-officer2-e2e-${randomUUID().slice(0, 6)}@example.test`;
    const [officer2] = await db
      .insert(usersTable)
      .values({
        email: officer2Email,
        passwordHash,
        firstName: "Officer",
        lastName: TAG,
        role: "employee",
        status: "active",
        tokensValidAfter: new Date(0),
      })
      .returning({ id: usersTable.id });
    lctx.officer2Id = officer2.id;
    lctx.officer2Email = officer2Email;

    for (const empId of [lctx.officerId, lctx.officer2Id]) {
      await db.insert(licensesTable).values({
        employeeId: empId,
        type: "tx-security",
        level: 3,
        licenseNumber: `${TAG}-${empId.slice(0, 6)}`,
        expiryDate: futureDate,
      });
    }
  });

  beforeEach(() => {
    // Fully configured so loop prevention is the ONLY thing that can suppress
    // an outbound push — a zero-call assertion is therefore meaningful.
    process.env.SCHEDULER_BASE_URL = "https://scheduler.example.com";
    process.env.SCHEDULER_SHARED_SECRET = SECRET;
    vi.restoreAllMocks();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    // Free seats / remove rows between cases so headcount + dup guards reset.
    const ids = lctx.createdShiftIds;
    if (ids.length > 0) {
      await db.delete(shiftAssignmentsTable).where(
        inArray(shiftAssignmentsTable.shiftId, ids),
      );
    }
  });

  afterAll(async () => {
    // Clean up everything this block created (the file-level afterAll deletes
    // users by last_name=TAG, but not these assignments / shifts / licences).
    const ids = lctx.createdShiftIds;
    if (ids.length > 0) {
      await db.delete(shiftAssignmentsTable).where(
        inArray(shiftAssignmentsTable.shiftId, ids),
      );
      await db.delete(shiftsTable).where(inArray(shiftsTable.id, ids));
    }
    await db.execute(
      sql`DELETE FROM licenses WHERE employee_id IN (${sql.join(
        [lctx.officerId, lctx.officer2Id].map((id) => sql`${id}::uuid`),
        sql`, `,
      )})`,
    );
  });

  // --- LOCAL shift: the push fires with the right action -------------------

  it("POST /shifts/:id/claim fires an outbound 'created' assignment push", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("{}", { status: 200 }));

    const shiftId = await makeShift({ scheduler: false });

    const res = await request(app)
      .post(`/api/shifts/${shiftId}/claim`)
      .set(authed(lctx.officerToken))
      .send({});
    expect(res.status).toBe(201);

    const call = await waitForAssignmentCall(fetchSpy);
    expect(call, "expected an outbound assignment push after claim").toBeTruthy();
    const body = parseBody(call!);
    expect(body.action).toBe("created");
    expect(body.shiftSecureopsId).toBe(shiftId);
    expect(body.employeeEmail).toBe(lctx.officerEmail);
    // Exactly one assignment push for this single claim.
    expect(assignmentCalls(fetchSpy)).toHaveLength(1);
  });

  it("POST /shifts/:id/assignments (admin assign) fires an outbound 'created' push", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("{}", { status: 200 }));

    const shiftId = await makeShift({ scheduler: false });

    const res = await request(app)
      .post(`/api/shifts/${shiftId}/assignments`)
      .set(authed(lctx.adminToken))
      .send({ employeeId: lctx.officer2Id });
    expect(res.status).toBe(201);

    const call = await waitForAssignmentCall(fetchSpy);
    expect(call, "expected an outbound assignment push after admin assign").toBeTruthy();
    const body = parseBody(call!);
    expect(body.action).toBe("created");
    expect(body.shiftSecureopsId).toBe(shiftId);
    expect(body.employeeEmail).toBe(lctx.officer2Email);
    expect(assignmentCalls(fetchSpy)).toHaveLength(1);
  });

  it("PUT /shifts/:id/assignments/:aid {declined} fires an outbound 'deleted' push", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("{}", { status: 200 }));

    const shiftId = await makeShift({ scheduler: false });
    // Seed an existing assignment directly so the decline endpoint has a row to
    // remove (the decline path itself is what we're exercising end-to-end).
    const [assignment] = await db
      .insert(shiftAssignmentsTable)
      .values({ shiftId, employeeId: lctx.officerId, status: "accepted" })
      .returning({ id: shiftAssignmentsTable.id });

    const res = await request(app)
      .put(`/api/shifts/${shiftId}/assignments/${assignment.id}`)
      .set(authed(lctx.officerToken))
      .send({ status: "declined" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ removed: true });

    const call = await waitForAssignmentCall(fetchSpy);
    expect(call, "expected an outbound assignment push after decline").toBeTruthy();
    const body = parseBody(call!);
    expect(body.action).toBe("deleted");
    expect(body.shiftSecureopsId).toBe(shiftId);
    expect(body.employeeEmail).toBe(lctx.officerEmail);
    expect(assignmentCalls(fetchSpy)).toHaveLength(1);
  });

  // --- SCHEDULER-origin shift: loop prevention -> NO outbound push ---------

  it("fires NO outbound push for any of the three endpoints when the shift originated on the scheduler", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("{}", { status: 200 }));

    // Claim a scheduler-origin shift.
    const claimShiftId = await makeShift({ scheduler: true });
    const claimRes = await request(app)
      .post(`/api/shifts/${claimShiftId}/claim`)
      .set(authed(lctx.officerToken))
      .send({});
    expect(claimRes.status).toBe(201);

    // Admin-assign onto a scheduler-origin shift.
    const assignShiftId = await makeShift({ scheduler: true });
    const assignRes = await request(app)
      .post(`/api/shifts/${assignShiftId}/assignments`)
      .set(authed(lctx.adminToken))
      .send({ employeeId: lctx.officer2Id });
    expect(assignRes.status).toBe(201);

    // Decline an assignment on a scheduler-origin shift.
    const declineShiftId = await makeShift({ scheduler: true });
    const [assignment] = await db
      .insert(shiftAssignmentsTable)
      .values({ shiftId: declineShiftId, employeeId: lctx.officerId, status: "accepted" })
      .returning({ id: shiftAssignmentsTable.id });
    const declineRes = await request(app)
      .put(`/api/shifts/${declineShiftId}/assignments/${assignment.id}`)
      .set(authed(lctx.officerToken))
      .send({ status: "declined" });
    expect(declineRes.status).toBe(200);

    // Give any errant fire-and-forget push a chance to land, then assert none
    // of the three reached the scheduler (loop prevention engaged end-to-end).
    await new Promise((r) => setTimeout(r, 250));
    expect(assignmentCalls(fetchSpy)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 6. Rate limiting: the public webhook routes (reachable from the internet)
//    are guarded by a per-IP limiter (`webhookLimiter`). Flooding past the
//    cap from a single source must short-circuit to 429 BEFORE the HMAC
//    check or any DB work, so the endpoint can't be used for brute-force
//    signature guessing or DB-write flooding.
//
//    The production default is 120 req / 5 min. To assert the 429 branch
//    without firing 120+ requests, we drive a low override via the
//    `SCHEDULER_WEBHOOK_RATE_LIMIT` env var and reset the shared per-IP
//    counter before each case so the boundary is deterministic. A
//    regression that removes the limiter (no 429) or loosens it (raises
//    the cap so the override is ignored) makes one of these assertions fail.
// ---------------------------------------------------------------------------

describe("scheduler webhook rate limiter blocks request floods", () => {
  const RATE_LIMIT = 5;
  let prevRateLimit: string | undefined;

  beforeEach(() => {
    prevRateLimit = process.env.SCHEDULER_WEBHOOK_RATE_LIMIT;
    process.env.SCHEDULER_WEBHOOK_RATE_LIMIT = String(RATE_LIMIT);
    // Fully configured so signed requests clear requireHmac and would reach
    // the DB if the limiter let them through.
    process.env.SCHEDULER_BASE_URL = "https://scheduler.example.com";
    process.env.SCHEDULER_SHARED_SECRET = SECRET;
    // The limiter is shared across the whole app instance for the test run;
    // clear the per-IP counter so each case starts from a known state.
    webhookRateLimitStore.resetAll();
  });

  afterEach(() => {
    if (prevRateLimit === undefined) delete process.env.SCHEDULER_WEBHOOK_RATE_LIMIT;
    else process.env.SCHEDULER_WEBHOOK_RATE_LIMIT = prevRateLimit;
    // Leave a clean counter for any later suites.
    webhookRateLimitStore.resetAll();
  });

  // A fully-signed delete payload for an externalId that doesn't exist:
  // it clears requireHmac + Zod and resolves to a cheap "skipped / not
  // found" (a single SELECT, no writes), so legitimate-but-allowed calls
  // are distinguishable from rate-limited (429) ones.
  function floodShift() {
    const body = JSON.stringify({
      id: `${TAG}-flood-${randomUUID().slice(0, 8)}`,
      action: "delete",
      updatedAt: "2027-01-01T00:00:00.000Z",
    });
    return request(app)
      .post("/api/scheduler-webhook/shifts")
      .set("Content-Type", "application/json")
      .set("X-WCSG-Signature", signPayload(body, SECRET))
      .send(body);
  }

  function floodClockEvent() {
    const body = JSON.stringify({
      id: `${TAG}-flood-clock-${randomUUID().slice(0, 8)}`,
      action: "delete",
      updatedAt: "2027-01-01T00:00:00.000Z",
    });
    return request(app)
      .post("/api/scheduler-webhook/clock-events")
      .set("Content-Type", "application/json")
      .set("X-WCSG-Signature", signPayload(body, SECRET))
      .send(body);
  }

  it("returns 429 once a single IP floods past the per-IP cap on /shifts", async () => {
    // Drive more than the cap from one simulated IP within the window.
    const total = RATE_LIMIT + 5;
    const statuses: number[] = [];
    let limitedBody: { error?: string; message?: string } | undefined;

    for (let i = 0; i < total; i++) {
      const res = await floodShift();
      statuses.push(res.status);
      if (res.status === 429 && !limitedBody) limitedBody = res.body;
    }

    // Requests up to the cap are allowed through (the limiter isn't blanket-
    // blocking legitimate traffic) — guards against a regression to limit 0.
    const allowed = statuses.filter((s) => s !== 429);
    const blocked = statuses.filter((s) => s === 429);
    expect(allowed).toHaveLength(RATE_LIMIT);
    expect(blocked).toHaveLength(total - RATE_LIMIT);

    // The over-cap requests short-circuit to the documented 429 response.
    expect(limitedBody).toMatchObject({
      error: "Too Many Requests",
      message: "Webhook rate limit exceeded",
    });
  });

  it("returns 429 once a single IP floods past the per-IP cap on /clock-events", async () => {
    const total = RATE_LIMIT + 3;
    const statuses: number[] = [];

    for (let i = 0; i < total; i++) {
      const res = await floodClockEvent();
      statuses.push(res.status);
    }

    // The /shifts and /clock-events routes share the same limiter, so the
    // clock-events surface is protected too.
    expect(statuses.filter((s) => s === 429)).toHaveLength(total - RATE_LIMIT);
    expect(statuses[total - 1]).toBe(429);
  });
});
