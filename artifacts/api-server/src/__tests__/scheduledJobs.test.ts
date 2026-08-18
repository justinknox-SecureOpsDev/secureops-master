import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { eq, sql } from "drizzle-orm";
import {
  db,
  usersTable,
  licensesTable,
  revokedTokensTable,
  timeEntriesTable,
  shiftsTable,
  sitesTable,
  siteManagersTable,
  clientsTable,
} from "@workspace/db";
import {
  sendLicenseExpiryReminders,
  cleanupExpiredRevokedTokens,
  sendUnconfirmedEntryReminders,
  escalateUnconfirmedEntries,
  autoClockOutEndedShifts,
  computeAutoClockOut,
  resolveAutoClockOutDelayMinutes,
} from "../lib/scheduledJobs";

// Tag everything so cleanup can scope precisely and never trample
// the demo seed rows or rows owned by other parallel test files.
const TAG = `sched-jobs-test-${randomUUID().slice(0, 8)}`;
const passwordHash = bcrypt.hashSync("test-password", 4);

function daysFromTodayDateOnly(days: number): string {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
}

async function makeActiveEmployee(suffix: string): Promise<string> {
  const [row] = await db
    .insert(usersTable)
    .values({
      email: `${TAG}-${suffix}-${randomUUID().slice(0, 6)}@example.test`,
      passwordHash,
      firstName: "Sched",
      lastName: TAG,
      role: "employee",
      status: "active",
      tokensValidAfter: new Date(0),
    })
    .returning({ id: usersTable.id });
  return row.id;
}

async function insertLicense(opts: {
  employeeId: string;
  expiryDate: string;
}): Promise<string> {
  const [row] = await db
    .insert(licensesTable)
    .values({
      employeeId: opts.employeeId,
      type: "tx-security",
      level: 2,
      licenseNumber: `${TAG}-${randomUUID().slice(0, 6)}`,
      expiryDate: opts.expiryDate,
    })
    .returning({ id: licensesTable.id });
  return row.id;
}

async function readLicense(id: string) {
  const [row] = await db
    .select({
      lastReminderTier: licensesTable.lastReminderTier,
      lastReminderForExpiry: licensesTable.lastReminderForExpiry,
      lastReminderSentAt: licensesTable.lastReminderSentAt,
    })
    .from(licensesTable)
    .where(eq(licensesTable.id, id))
    .limit(1);
  return row;
}

afterAll(async () => {
  // licenses cascade-delete on user delete, but be explicit so a flaky
  // FK ordering still leaves a clean DB.
  await db.execute(
    sql`DELETE FROM licenses WHERE license_number LIKE ${TAG + "%"}`,
  );
  await db.execute(sql`DELETE FROM users WHERE last_name = ${TAG}`);
});

describe("sendLicenseExpiryReminders — tier bookkeeping is idempotent", () => {
  // The job sweeps tiers 60→30→14→7 in a single tick. A license with
  // expiry 25 days out lands inside the 60-day AND 30-day windows but
  // outside 14/7, so the bookkeeping should end at tier 30 — and re-runs
  // should be no-ops (the cron currently runs hourly).
  it("advances last_reminder_tier through the windows the license is currently inside, then stops", async () => {
    const empId = await makeActiveEmployee("a");
    const expiry = daysFromTodayDateOnly(25);
    const licId = await insertLicense({ employeeId: empId, expiryDate: expiry });

    // Pre-condition: untouched bookkeeping.
    const before = await readLicense(licId);
    expect(before.lastReminderTier).toBeNull();
    expect(before.lastReminderForExpiry).toBeNull();

    await sendLicenseExpiryReminders();

    // After a single tick, the smallest in-window tier (30) is stamped.
    // We don't assert the timestamp wall-clock — only that the per-expiry
    // tier bookkeeping advanced and is pinned to THIS expiry date.
    const after = await readLicense(licId);
    expect(after.lastReminderTier).toBe(30);
    expect(after.lastReminderForExpiry).toBe(expiry);
    expect(after.lastReminderSentAt).not.toBeNull();
  });

  it("does not re-send on the next tick when the license has not been renewed", async () => {
    const empId = await makeActiveEmployee("b");
    const expiry = daysFromTodayDateOnly(25);
    const licId = await insertLicense({ employeeId: empId, expiryDate: expiry });

    await sendLicenseExpiryReminders();
    const firstStamp = (await readLicense(licId)).lastReminderSentAt;
    expect(firstStamp).not.toBeNull();

    // Second tick a moment later — license still 25 days out, still at
    // tier=30. The query's WHERE-clause should rule it out (tier 30 isn't
    // > 30, isn't > 60), and the atomic claim should match nothing if it
    // somehow did. Either way, lastReminderSentAt must not move.
    await sendLicenseExpiryReminders();
    const secondStamp = (await readLicense(licId)).lastReminderSentAt;
    expect(secondStamp?.getTime()).toBe(firstStamp?.getTime());
  });

  it("re-arms when the license is renewed (expiryDate changes)", async () => {
    const empId = await makeActiveEmployee("c");
    const firstExpiry = daysFromTodayDateOnly(25);
    const licId = await insertLicense({ employeeId: empId, expiryDate: firstExpiry });

    await sendLicenseExpiryReminders();
    const first = await readLicense(licId);
    expect(first.lastReminderTier).toBe(30);
    expect(first.lastReminderForExpiry).toBe(firstExpiry);

    // Simulate a renewal — admin extends expiry further out and pushes
    // the bookkeeping into a "new expiry" world. The job should treat
    // this as a clean slate because lastReminderForExpiry no longer
    // matches expiryDate.
    const renewedExpiry = daysFromTodayDateOnly(45);
    await db
      .update(licensesTable)
      .set({ expiryDate: renewedExpiry })
      .where(eq(licensesTable.id, licId));

    await sendLicenseExpiryReminders();
    const renewed = await readLicense(licId);
    // 45 days lands inside 60 but outside 30/14/7. We should see the
    // 60-day reminder fired for the NEW expiry, not the old one.
    expect(renewed.lastReminderTier).toBe(60);
    expect(renewed.lastReminderForExpiry).toBe(renewedExpiry);
  });

  it("does not remind inactive (suspended/terminated) employees even when their license is about to expire", async () => {
    const empId = await makeActiveEmployee("d");
    await db
      .update(usersTable)
      .set({ status: "inactive" })
      .where(eq(usersTable.id, empId));
    const licId = await insertLicense({
      employeeId: empId,
      expiryDate: daysFromTodayDateOnly(5),
    });

    await sendLicenseExpiryReminders();
    const after = await readLicense(licId);
    expect(after.lastReminderTier).toBeNull();
    expect(after.lastReminderForExpiry).toBeNull();
    expect(after.lastReminderSentAt).toBeNull();
  });
});

describe("sendUnconfirmedEntryReminders", () => {
  async function insertEntry(opts: {
    employeeId: string;
    clockOutAgoMs: number | null;
    confirmationStatus?: string | null;
    reminderSentAt?: Date | null;
  }): Promise<string> {
    const now = Date.now();
    const clockOut =
      opts.clockOutAgoMs === null ? null : new Date(now - opts.clockOutAgoMs);
    const clockIn = new Date(now - (opts.clockOutAgoMs ?? 0) - 8 * 60 * 60 * 1000);
    const [row] = await db
      .insert(timeEntriesTable)
      .values({
        employeeId: opts.employeeId,
        clockInTime: clockIn,
        clockOutTime: clockOut,
        confirmationStatus:
          opts.confirmationStatus === undefined
            ? "awaiting_confirmation"
            : opts.confirmationStatus,
        confirmationReminderSentAt: opts.reminderSentAt ?? null,
        notes: TAG,
      })
      .returning({ id: timeEntriesTable.id });
    return row.id;
  }

  async function readReminderStamp(id: string): Promise<Date | null> {
    const [row] = await db
      .select({ stamp: timeEntriesTable.confirmationReminderSentAt })
      .from(timeEntriesTable)
      .where(eq(timeEntriesTable.id, id))
      .limit(1);
    return row.stamp;
  }

  afterAll(async () => {
    await db.execute(sql`DELETE FROM time_entries WHERE notes = ${TAG}`);
  });

  it("stamps an entry awaiting confirmation for over an hour, exactly once", async () => {
    const empId = await makeActiveEmployee("uc-a");
    const staleId = await insertEntry({ employeeId: empId, clockOutAgoMs: 2 * 60 * 60 * 1000 });

    await sendUnconfirmedEntryReminders();
    const first = await readReminderStamp(staleId);
    expect(first).not.toBeNull();

    // Second tick must not move the stamp (one reminder per entry, ever).
    await sendUnconfirmedEntryReminders();
    const second = await readReminderStamp(staleId);
    expect(second?.getTime()).toBe(first?.getTime());
  });

  it("skips recent, confirmed, non-applicable, and still-open entries", async () => {
    const empId = await makeActiveEmployee("uc-b");
    const recentId = await insertEntry({ employeeId: empId, clockOutAgoMs: 10 * 60 * 1000 });
    const confirmedId = await insertEntry({
      employeeId: empId,
      clockOutAgoMs: 2 * 60 * 60 * 1000,
      confirmationStatus: "confirmed",
    });
    const legacyId = await insertEntry({
      employeeId: empId,
      clockOutAgoMs: 2 * 60 * 60 * 1000,
      confirmationStatus: null,
    });
    const openId = await insertEntry({ employeeId: empId, clockOutAgoMs: null });

    await sendUnconfirmedEntryReminders();

    expect(await readReminderStamp(recentId)).toBeNull();
    expect(await readReminderStamp(confirmedId)).toBeNull();
    expect(await readReminderStamp(legacyId)).toBeNull();
    expect(await readReminderStamp(openId)).toBeNull();
  });
});

describe("escalateUnconfirmedEntries", () => {
  async function makeActiveManagerAtSite(siteId: string, suffix: string): Promise<string> {
    const [u] = await db
      .insert(usersTable)
      .values({
        email: `${TAG}-${suffix}-${randomUUID().slice(0, 6)}@example.test`,
        passwordHash,
        firstName: "Mgr",
        lastName: TAG,
        role: "site_manager",
        status: "active",
        tokensValidAfter: new Date(0),
      })
      .returning({ id: usersTable.id });
    await db.insert(siteManagersTable).values({ siteId, userId: u.id });
    return u.id;
  }

  async function makeSite(suffix: string): Promise<string> {
    const [c] = await db
      .insert(clientsTable)
      .values({ name: `${TAG}-client-${suffix}` })
      .returning({ id: clientsTable.id });
    const [s] = await db
      .insert(sitesTable)
      .values({ name: `${TAG}-site-${suffix}`, address: "1 Test Way", clientId: c.id })
      .returning({ id: sitesTable.id });
    return s.id;
  }

  async function insertEntry(opts: {
    employeeId: string;
    siteId?: string | null;
    clockOutAgoMs: number | null;
    confirmationStatus?: string | null;
    escalatedAt?: Date | null;
  }): Promise<string> {
    const now = Date.now();
    const clockOut =
      opts.clockOutAgoMs === null ? null : new Date(now - opts.clockOutAgoMs);
    const clockIn = new Date(now - (opts.clockOutAgoMs ?? 0) - 8 * 60 * 60 * 1000);
    const [row] = await db
      .insert(timeEntriesTable)
      .values({
        employeeId: opts.employeeId,
        siteId: opts.siteId ?? null,
        clockInTime: clockIn,
        clockOutTime: clockOut,
        confirmationStatus:
          opts.confirmationStatus === undefined
            ? "awaiting_confirmation"
            : opts.confirmationStatus,
        confirmationEscalatedAt: opts.escalatedAt ?? null,
        notes: TAG,
      })
      .returning({ id: timeEntriesTable.id });
    return row.id;
  }

  async function readEscalationStamp(id: string): Promise<Date | null> {
    const [row] = await db
      .select({ stamp: timeEntriesTable.confirmationEscalatedAt })
      .from(timeEntriesTable)
      .where(eq(timeEntriesTable.id, id))
      .limit(1);
    return row.stamp;
  }

  afterAll(async () => {
    await db.execute(sql`DELETE FROM time_entries WHERE notes = ${TAG}`);
    await db.execute(sql`DELETE FROM sites WHERE name LIKE ${TAG + "-site-%"}`);
  });

  const DAY = 24 * 60 * 60 * 1000;

  it("escalates a >24h-awaiting entry with a site manager exactly once", async () => {
    const empId = await makeActiveEmployee("esc-a");
    const siteId = await makeSite("a");
    await makeActiveManagerAtSite(siteId, "esc-mgr-a");
    const staleId = await insertEntry({ employeeId: empId, siteId, clockOutAgoMs: DAY + 2 * 60 * 60 * 1000 });

    await escalateUnconfirmedEntries();
    const first = await readEscalationStamp(staleId);
    expect(first).not.toBeNull();

    // Second tick must not move the stamp (one escalation per entry, ever).
    await escalateUnconfirmedEntries();
    const second = await readEscalationStamp(staleId);
    expect(second?.getTime()).toBe(first?.getTime());
  });

  it("escalates a site-less entry to active admins", async () => {
    const empId = await makeActiveEmployee("esc-b");
    // Guarantee at least one active admin recipient exists.
    await db.insert(usersTable).values({
      email: `${TAG}-admin-${randomUUID().slice(0, 6)}@example.test`,
      passwordHash,
      firstName: "Adm",
      lastName: TAG,
      role: "admin",
      status: "active",
      tokensValidAfter: new Date(0),
    });
    const staleId = await insertEntry({ employeeId: empId, siteId: null, clockOutAgoMs: DAY + 60 * 60 * 1000 });

    await escalateUnconfirmedEntries();
    expect(await readEscalationStamp(staleId)).not.toBeNull();
  });

  it("skips entries under 24h, confirmed, non-applicable, and still-open", async () => {
    const empId = await makeActiveEmployee("esc-c");
    const siteId = await makeSite("c");
    await makeActiveManagerAtSite(siteId, "esc-mgr-c");
    const recentId = await insertEntry({ employeeId: empId, siteId, clockOutAgoMs: 2 * 60 * 60 * 1000 });
    const confirmedId = await insertEntry({
      employeeId: empId,
      siteId,
      clockOutAgoMs: DAY + 60 * 60 * 1000,
      confirmationStatus: "confirmed",
    });
    const legacyId = await insertEntry({
      employeeId: empId,
      siteId,
      clockOutAgoMs: DAY + 60 * 60 * 1000,
      confirmationStatus: null,
    });
    const openId = await insertEntry({ employeeId: empId, siteId, clockOutAgoMs: null });

    await escalateUnconfirmedEntries();

    expect(await readEscalationStamp(recentId)).toBeNull();
    expect(await readEscalationStamp(confirmedId)).toBeNull();
    expect(await readEscalationStamp(legacyId)).toBeNull();
    expect(await readEscalationStamp(openId)).toBeNull();
  });
});

describe("computeAutoClockOut", () => {
  const HOUR = 60 * 60 * 1000;

  it("clocks out at the shift's scheduled end for a normal forgotten entry", () => {
    const shiftEnd = new Date("2026-07-01T18:00:00Z");
    const clockIn = new Date(shiftEnd.getTime() - 8 * HOUR);

    const got = computeAutoClockOut({
      clockInTime: clockIn,
      shiftEndTime: shiftEnd,
      now: shiftEnd.getTime() + 30 * 60 * 1000,
    });

    expect(got.clockOut.toISOString()).toBe(shiftEnd.toISOString());
    expect(got.hours).toBe(8);
    expect(got.capped).toBe(false);
  });

  it("falls back to now() when the officer clocked in after the shift ended", () => {
    const shiftEnd = new Date("2026-07-01T18:00:00Z");
    const clockIn = new Date(shiftEnd.getTime() + 1 * HOUR);
    const now = clockIn.getTime() + 2 * HOUR;

    const got = computeAutoClockOut({ clockInTime: clockIn, shiftEndTime: shiftEnd, now });

    expect(got.clockOut.getTime()).toBe(now);
    expect(got.hours).toBe(2);
    expect(got.capped).toBe(false);
  });

  it("leaves a long but legitimate shift (24h post, early clock-in) uncapped", () => {
    const shiftEnd = new Date("2026-07-02T18:00:00Z");
    const clockIn = new Date(shiftEnd.getTime() - 24 * HOUR - 15 * 60 * 1000);

    const got = computeAutoClockOut({
      clockInTime: clockIn,
      shiftEndTime: shiftEnd,
      now: shiftEnd.getTime() + HOUR,
    });

    expect(got.capped).toBe(false);
    expect(got.hours).toBe(24.25);
  });

  it("caps an entry left open for months instead of overflowing hours_worked", () => {
    // The real production row: clocked in ~420 days ago, and clocked in AFTER
    // its shift had already ended, so the old code fell back to now() and tried
    // to write 10065.08 into numeric(6,2) — which threw and killed the run.
    const clockIn = new Date("2025-06-05T14:00:00Z");
    const shiftEnd = new Date("2025-06-03T18:00:00Z");
    const now = new Date("2026-07-30T12:00:00Z").getTime();

    const got = computeAutoClockOut({ clockInTime: clockIn, shiftEndTime: shiftEnd, now });

    expect(got.capped).toBe(true);
    expect(got.hours).toBe(36);
    // hours must stay consistent with the timestamps, and must fit numeric(6,2).
    expect(got.clockOut.getTime()).toBe(clockIn.getTime() + 36 * HOUR);
    expect(got.hours).toBeLessThan(10000);
  });

  it("ignores the site's delay when the grace period is unpaid (today's behavior)", () => {
    const shiftEnd = new Date("2026-07-01T18:00:00Z");
    const clockIn = new Date(shiftEnd.getTime() - 8 * HOUR);

    const got = computeAutoClockOut({
      clockInTime: clockIn,
      shiftEndTime: shiftEnd,
      now: shiftEnd.getTime() + 90 * 60 * 1000,
      delayMinutes: 45,
      payGrace: false,
    });

    expect(got.clockOut.toISOString()).toBe(shiftEnd.toISOString());
    expect(got.hours).toBe(8);
  });

  it("pays through the grace window when the site opts in", () => {
    const shiftEnd = new Date("2026-07-01T18:00:00Z");
    const clockIn = new Date(shiftEnd.getTime() - 8 * HOUR);

    const got = computeAutoClockOut({
      clockInTime: clockIn,
      shiftEndTime: shiftEnd,
      now: shiftEnd.getTime() + 90 * 60 * 1000,
      delayMinutes: 45,
      payGrace: true,
    });

    expect(got.clockOut.getTime()).toBe(shiftEnd.getTime() + 45 * 60 * 1000);
    expect(got.hours).toBe(8.75);
    expect(got.capped).toBe(false);
  });

  it("pays the default 10 minutes of grace when the site has no delay configured", () => {
    const shiftEnd = new Date("2026-07-01T18:00:00Z");
    const clockIn = new Date(shiftEnd.getTime() - 8 * HOUR);

    const got = computeAutoClockOut({
      clockInTime: clockIn,
      shiftEndTime: shiftEnd,
      now: shiftEnd.getTime() + 30 * 60 * 1000,
      delayMinutes: null as unknown as undefined,
      payGrace: true,
    });

    expect(got.clockOut.getTime()).toBe(shiftEnd.getTime() + 10 * 60 * 1000);
    expect(got.hours).toBe(8.17);
  });

  it("clamps an absurd stored delay before paying it out", () => {
    const shiftEnd = new Date("2026-07-01T18:00:00Z");
    const clockIn = new Date(shiftEnd.getTime() - 1 * HOUR);

    const got = computeAutoClockOut({
      clockInTime: clockIn,
      shiftEndTime: shiftEnd,
      now: shiftEnd.getTime() + 30 * 60 * 1000,
      delayMinutes: 999_999,
      payGrace: true,
    });

    // 720-minute (12h) ceiling, not 999999 minutes of invented paid time.
    expect(got.clockOut.getTime()).toBe(shiftEnd.getTime() + 720 * 60 * 1000);
    expect(got.hours).toBe(13);
  });

  it("keeps the 36h maximum-duration cap winning over paid grace", () => {
    // Clocked in two days before the shift ended: end + 12h of paid grace
    // would be ~60h, well past the numeric(6,2)-protecting ceiling.
    const shiftEnd = new Date("2026-07-03T18:00:00Z");
    const clockIn = new Date(shiftEnd.getTime() - 48 * HOUR);

    const got = computeAutoClockOut({
      clockInTime: clockIn,
      shiftEndTime: shiftEnd,
      now: shiftEnd.getTime() + 13 * HOUR,
      delayMinutes: 720,
      payGrace: true,
    });

    expect(got.capped).toBe(true);
    expect(got.hours).toBe(36);
    expect(got.clockOut.getTime()).toBe(clockIn.getTime() + 36 * HOUR);
  });
});

describe("resolveAutoClockOutDelayMinutes", () => {
  it("falls back to the 10-minute default for an unconfigured site", () => {
    expect(resolveAutoClockOutDelayMinutes(null)).toBe(10);
    expect(resolveAutoClockOutDelayMinutes(undefined)).toBe(10);
    expect(resolveAutoClockOutDelayMinutes(Number.NaN)).toBe(10);
  });

  it("passes a configured delay through untouched", () => {
    expect(resolveAutoClockOutDelayMinutes(45)).toBe(45);
    expect(resolveAutoClockOutDelayMinutes(0)).toBe(0);
    expect(resolveAutoClockOutDelayMinutes(720)).toBe(720);
  });

  it("clamps corrupt values into the supported range", () => {
    expect(resolveAutoClockOutDelayMinutes(-30)).toBe(0);
    expect(resolveAutoClockOutDelayMinutes(100_000)).toBe(720);
    expect(resolveAutoClockOutDelayMinutes(12.9)).toBe(12);
  });
});

describe("autoClockOutEndedShifts", () => {
  const ATAG = `${TAG}-aco`;
  let siteId: string;
  let clientId: string;
  // Extra sites created per-test to exercise the per-site timing settings.
  const extraSiteIds: string[] = [];

  async function makeShift(suffix: string, startTime: Date, endTime: Date, atSiteId?: string): Promise<string> {
    const [row] = await db
      .insert(shiftsTable)
      .values({ title: `${ATAG}-shift-${suffix}`, siteId: atSiteId ?? siteId, startTime, endTime, status: "active" })
      .returning({ id: shiftsTable.id });
    return row.id;
  }

  async function makeOpenEntry(employeeId: string, shiftId: string, clockIn: Date, atSiteId?: string): Promise<string> {
    const [row] = await db
      .insert(timeEntriesTable)
      .values({ employeeId, shiftId, siteId: atSiteId ?? siteId, clockInTime: clockIn, clockOutTime: null, notes: ATAG })
      .returning({ id: timeEntriesTable.id });
    return row.id;
  }

  /**
   * Site with explicit auto-clock-out timing. `delayMinutes` is written with a
   * raw SQL cast so tests can also store values the API would reject (corrupt
   * rows), which is exactly what the job's clamp defends against.
   */
  async function makeSiteWithDelay(
    suffix: string,
    delayMinutes: number | null,
    payGrace: boolean,
  ): Promise<string> {
    const [s] = await db
      .insert(sitesTable)
      .values({
        name: `${ATAG}-${suffix}`,
        address: "1 Test Way",
        clientId,
        autoClockOutDelayMinutes: delayMinutes,
        autoClockOutPayGrace: payGrace,
      })
      .returning({ id: sitesTable.id });
    extraSiteIds.push(s.id);
    return s.id;
  }

  async function readEntry(id: string) {
    const [row] = await db
      .select({
        clockOutTime: timeEntriesTable.clockOutTime,
        hoursWorked: timeEntriesTable.hoursWorked,
        notes: timeEntriesTable.notes,
      })
      .from(timeEntriesTable)
      .where(eq(timeEntriesTable.id, id))
      .limit(1);
    return row;
  }

  beforeAll(async () => {
    const [c] = await db
      .insert(clientsTable)
      .values({ name: `${ATAG}-client` })
      .returning({ id: clientsTable.id });
    clientId = c.id;
    const [s] = await db
      .insert(sitesTable)
      .values({ name: `${ATAG}-location`, address: "1 Test Way", clientId: c.id })
      .returning({ id: sitesTable.id });
    siteId = s.id;
  });

  afterAll(async () => {
    const ids = [siteId, ...extraSiteIds];
    for (const id of ids) {
      await db.execute(sql`DELETE FROM time_entries WHERE site_id = ${id}`);
      await db.execute(sql`DELETE FROM shifts WHERE site_id = ${id}`);
      await db.execute(sql`DELETE FROM sites WHERE id = ${id}`);
    }
    await db.execute(sql`DELETE FROM clients WHERE name = ${`${ATAG}-client`}`);
  });

  it("closes a months-open entry with a capped, reviewable duration and still closes everyone else in the same run", async () => {
    const now = Date.now();
    const HOUR = 60 * 60 * 1000;

    // The pathological row that used to abort the entire job: open for ~420
    // days, and clocked in AFTER its shift had already ended, so there is no
    // scheduled end to anchor to and the old code fell back to now().
    const staleEmp = await makeActiveEmployee("aco-stale");
    const staleShift = await makeShift(
      "stale",
      new Date(now - 421 * 24 * HOUR),
      new Date(now - 420 * 24 * HOUR),
    );
    const staleEntry = await makeOpenEntry(staleEmp, staleShift, new Date(now - 418 * 24 * HOUR));

    // An ordinary forgotten clock-out that must not be collateral damage.
    const normalEmp = await makeActiveEmployee("aco-normal");
    const normalEnd = new Date(now - 2 * HOUR);
    const normalShift = await makeShift("normal", new Date(now - 10 * HOUR), normalEnd);
    const normalEntry = await makeOpenEntry(normalEmp, normalShift, new Date(now - 10 * HOUR));

    await autoClockOutEndedShifts();

    const stale = await readEntry(staleEntry);
    expect(stale.clockOutTime).not.toBeNull();
    expect(Number(stale.hoursWorked)).toBe(36);
    expect(stale.notes).toContain("capped");

    const normal = await readEntry(normalEntry);
    expect(normal.clockOutTime).not.toBeNull();
    expect(normal.clockOutTime?.getTime()).toBe(normalEnd.getTime());
    expect(Number(normal.hoursWorked)).toBe(8);
    expect(normal.notes).not.toContain("capped");
  });

  it("keeps going when one entry's write throws, instead of aborting the whole run", async () => {
    const now = Date.now();
    const HOUR = 60 * 60 * 1000;
    const end = new Date(now - 2 * HOUR);

    const empA = await makeActiveEmployee("aco-iso-a");
    const shiftA = await makeShift("iso-a", new Date(now - 10 * HOUR), end);
    const entryA = await makeOpenEntry(empA, shiftA, new Date(now - 10 * HOUR));

    const empB = await makeActiveEmployee("aco-iso-b");
    const shiftB = await makeShift("iso-b", new Date(now - 10 * HOUR), end);
    const entryB = await makeOpenEntry(empB, shiftB, new Date(now - 10 * HOUR));

    // Blow up the very first write of the run. Whichever row that lands on,
    // the other one must still be closed by the same tick.
    const spy = vi.spyOn(db, "update").mockImplementationOnce(() => {
      throw new Error("simulated write failure");
    });

    try {
      await expect(autoClockOutEndedShifts()).resolves.toBeUndefined();
    } finally {
      spy.mockRestore();
    }

    const [a, b] = [await readEntry(entryA), await readEntry(entryB)];
    const closed = [a, b].filter((e) => e.clockOutTime !== null);
    expect(closed).toHaveLength(1);
  });

  it("waits out the site's own delay instead of the global 10 minutes", async () => {
    const now = Date.now();
    const MIN = 60 * 1000;
    const eventSite = await makeSiteWithDelay("delay45", 45, false);

    // 20 minutes past end: already past the global default, but this site
    // asked for 45 — the officer must be left alone for now.
    const earlyEmp = await makeActiveEmployee("aco-d45-early");
    const earlyEnd = new Date(now - 20 * MIN);
    const earlyShift = await makeShift("d45-early", new Date(now - 8 * 60 * MIN), earlyEnd, eventSite);
    const earlyEntry = await makeOpenEntry(earlyEmp, earlyShift, new Date(now - 8 * 60 * MIN), eventSite);

    // 50 minutes past end: the site's delay has elapsed, so this one closes.
    const lateEmp = await makeActiveEmployee("aco-d45-late");
    const lateEnd = new Date(now - 50 * MIN);
    const lateShift = await makeShift("d45-late", new Date(now - 8 * 60 * MIN), lateEnd, eventSite);
    const lateEntry = await makeOpenEntry(lateEmp, lateShift, new Date(now - 8 * 60 * MIN), eventSite);

    await autoClockOutEndedShifts();

    const early = await readEntry(earlyEntry);
    expect(early.clockOutTime).toBeNull();

    const late = await readEntry(lateEntry);
    expect(late.clockOutTime).not.toBeNull();
    // Grace unpaid (default): stamped at the scheduled end, exactly as today.
    expect(late.clockOutTime?.getTime()).toBe(lateEnd.getTime());
    expect(late.notes).toContain("Waited 45 min past scheduled end");
    expect(late.notes).toContain("grace period unpaid");
  });

  it("pays through the grace window when the site opts in, and says so on the entry", async () => {
    const now = Date.now();
    const MIN = 60 * 1000;
    const paidSite = await makeSiteWithDelay("paid30", 30, true);

    const emp = await makeActiveEmployee("aco-paid");
    const end = new Date(now - 40 * MIN);
    const clockIn = new Date(end.getTime() - 8 * 60 * MIN);
    const shift = await makeShift("paid30", clockIn, end, paidSite);
    const entryId = await makeOpenEntry(emp, shift, clockIn, paidSite);

    await autoClockOutEndedShifts();

    const entry = await readEntry(entryId);
    expect(entry.clockOutTime?.getTime()).toBe(end.getTime() + 30 * MIN);
    expect(Number(entry.hoursWorked)).toBe(8.5);
    expect(entry.notes).toContain("Waited 30 min past scheduled end");
    expect(entry.notes).toContain("grace period paid");
  });

  it("clamps a corrupt stored delay rather than stalling the site", async () => {
    const now = Date.now();
    const MIN = 60 * 1000;
    // Negative minutes can only come from a corrupt/hand-edited row — the API
    // rejects them. Clamped to 0, so the entry closes as soon as the shift
    // has ended rather than the job silently skipping this site forever.
    const brokenSite = await makeSiteWithDelay("broken", -600, false);

    const emp = await makeActiveEmployee("aco-broken");
    const end = new Date(now - 1 * MIN);
    const clockIn = new Date(end.getTime() - 4 * 60 * MIN);
    const shift = await makeShift("broken", clockIn, end, brokenSite);
    const entryId = await makeOpenEntry(emp, shift, clockIn, brokenSite);

    await autoClockOutEndedShifts();

    const entry = await readEntry(entryId);
    expect(entry.clockOutTime?.getTime()).toBe(end.getTime());
    expect(Number(entry.hoursWorked)).toBe(4);
    expect(entry.notes).toContain("Waited 0 min past scheduled end");
  });

  it("leaves a site with auto clock-out switched off alone, whatever its timing settings say", async () => {
    const now = Date.now();
    const MIN = 60 * 1000;
    const [offSite] = await db
      .insert(sitesTable)
      .values({
        name: `${ATAG}-off`,
        address: "1 Test Way",
        clientId,
        autoClockOutEnabled: false,
        autoClockOutDelayMinutes: 0,
        autoClockOutPayGrace: true,
      })
      .returning({ id: sitesTable.id });
    extraSiteIds.push(offSite.id);

    const emp = await makeActiveEmployee("aco-off");
    const end = new Date(now - 3 * 60 * MIN);
    const clockIn = new Date(end.getTime() - 8 * 60 * MIN);
    const shift = await makeShift("off", clockIn, end, offSite.id);
    const entryId = await makeOpenEntry(emp, shift, clockIn, offSite.id);

    await autoClockOutEndedShifts();

    expect((await readEntry(entryId)).clockOutTime).toBeNull();
  });
});

describe("cleanupExpiredRevokedTokens", () => {
  it("removes rows past expiresAt and leaves fresh rows intact", async () => {
    const userId = await makeActiveEmployee("rt");

    const expiredJti = `${TAG}-jti-expired-${randomUUID().slice(0, 6)}`;
    const freshJti = `${TAG}-jti-fresh-${randomUUID().slice(0, 6)}`;

    await db.insert(revokedTokensTable).values([
      {
        jti: expiredJti,
        userId,
        expiresAt: new Date(Date.now() - 60_000),
      },
      {
        jti: freshJti,
        userId,
        expiresAt: new Date(Date.now() + 60 * 60_000),
      },
    ]);

    await cleanupExpiredRevokedTokens();

    const remaining = await db
      .select({ jti: revokedTokensTable.jti })
      .from(revokedTokensTable)
      .where(eq(revokedTokensTable.userId, userId));
    const jtis = remaining.map((r) => r.jti);
    expect(jtis).toContain(freshJti);
    expect(jtis).not.toContain(expiredJti);
  });
});
