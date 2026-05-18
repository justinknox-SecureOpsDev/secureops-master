import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { eq, sql } from "drizzle-orm";
import {
  db,
  usersTable,
  licensesTable,
  revokedTokensTable,
} from "@workspace/db";
import {
  sendLicenseExpiryReminders,
  cleanupExpiredRevokedTokens,
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
