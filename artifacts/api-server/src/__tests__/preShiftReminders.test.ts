import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { eq, sql } from "drizzle-orm";
import {
  db,
  usersTable,
  clientsTable,
  sitesTable,
  shiftsTable,
  shiftAssignmentsTable,
} from "@workspace/db";
import { sendPreShiftReminders } from "../lib/scheduledJobs";

const TAG = `pre-shift-test-${randomUUID().slice(0, 8)}`;
const passwordHash = bcrypt.hashSync("test-password", 4);

type Ctx = {
  empId: string;
  clientId: string;
  siteId: string;
};
const ctx = {} as Ctx;

beforeAll(async () => {
  const [emp] = await db
    .insert(usersTable)
    .values({
      email: `${TAG}-emp-${randomUUID().slice(0, 6)}@example.test`,
      passwordHash,
      firstName: "Pre",
      lastName: TAG,
      role: "employee",
      status: "active",
      tokensValidAfter: new Date(0),
    })
    .returning({ id: usersTable.id });
  ctx.empId = emp.id;

  const [client] = await db
    .insert(clientsTable)
    .values({ name: `${TAG}-client` })
    .returning({ id: clientsTable.id });
  ctx.clientId = client.id;

  const [site] = await db
    .insert(sitesTable)
    .values({ clientId: ctx.clientId, name: `${TAG}-site`, address: "1 Test Way" })
    .returning({ id: sitesTable.id });
  ctx.siteId = site.id;
});

afterAll(async () => {
  await db.execute(
    sql`DELETE FROM shift_assignments WHERE shift_id IN (SELECT id FROM shifts WHERE title LIKE ${TAG + "%"})`,
  );
  await db.execute(sql`DELETE FROM shifts WHERE title LIKE ${TAG + "%"}`);
  await db.execute(sql`DELETE FROM sites WHERE name LIKE ${TAG + "%"}`);
  await db.execute(sql`DELETE FROM clients WHERE name LIKE ${TAG + "%"}`);
  await db.execute(sql`DELETE FROM users WHERE last_name = ${TAG}`);
});

async function makeShift(opts: {
  startsInMs: number;
  status?: "upcoming" | "cancelled" | "completed" | "active";
  suffix: string;
}): Promise<string> {
  const start = new Date(Date.now() + opts.startsInMs);
  const end = new Date(start.getTime() + 4 * 60 * 60 * 1000);
  const [row] = await db
    .insert(shiftsTable)
    .values({
      title: `${TAG}-${opts.suffix}`,
      siteId: ctx.siteId,
      startTime: start,
      endTime: end,
      requiredLicenseLevel: 2,
      headcount: 1,
      status: opts.status ?? "upcoming",
    })
    .returning({ id: shiftsTable.id });
  return row.id;
}

async function assignAccepted(shiftId: string): Promise<string> {
  const [row] = await db
    .insert(shiftAssignmentsTable)
    .values({ shiftId, employeeId: ctx.empId, status: "accepted" })
    .returning({ id: shiftAssignmentsTable.id });
  return row.id;
}

async function readAssignment(id: string) {
  const [row] = await db
    .select({
      r2h: shiftAssignmentsTable.reminder2hSentAt,
      r30m: shiftAssignmentsTable.reminder30mSentAt,
    })
    .from(shiftAssignmentsTable)
    .where(eq(shiftAssignmentsTable.id, id))
    .limit(1);
  return row;
}

describe("sendPreShiftReminders — claim, idempotency, cancellation", () => {
  it("stamps reminder_30m_sent_at exactly once for an upcoming shift inside the 30m window", async () => {
    // Shift starts in ~30 minutes — squarely inside the 25–35m window.
    const shiftId = await makeShift({ startsInMs: 30 * 60 * 1000, suffix: "30m-claim" });
    const aId = await assignAccepted(shiftId);

    const before = await readAssignment(aId);
    expect(before.r30m).toBeNull();
    expect(before.r2h).toBeNull();

    await sendPreShiftReminders();
    const after = await readAssignment(aId);
    expect(after.r30m).not.toBeNull();
    expect(after.r2h).toBeNull(); // 30m shift isn't in the 2h window
    const firstStamp = after.r30m!.getTime();

    // Second tick — should be a no-op for this assignment because the
    // sent column is no longer NULL. This is the per-shift idempotency
    // guarantee.
    await sendPreShiftReminders();
    const second = await readAssignment(aId);
    expect(second.r30m!.getTime()).toBe(firstStamp);
  });

  it("stamps reminder_2h_sent_at for an upcoming shift inside the 2h window without touching 30m", async () => {
    // 2-hour window is 110–130m. 120m lands dead-center.
    const shiftId = await makeShift({ startsInMs: 120 * 60 * 1000, suffix: "2h-claim" });
    const aId = await assignAccepted(shiftId);

    await sendPreShiftReminders();
    const after = await readAssignment(aId);
    expect(after.r2h).not.toBeNull();
    expect(after.r30m).toBeNull();
  });

  it("does NOT remind an officer about a CANCELLED shift", async () => {
    // This is the core silent-failure the task is named for: a
    // dispatcher cancels a shift, but unless we filter by
    // shifts.status='upcoming' the cron still pages the officer
    // 30 minutes before the original start time. Officer drives to
    // a job that no longer exists.
    const shiftId = await makeShift({
      startsInMs: 30 * 60 * 1000,
      status: "cancelled",
      suffix: "cancelled",
    });
    const aId = await assignAccepted(shiftId);

    await sendPreShiftReminders();
    const after = await readAssignment(aId);
    expect(after.r30m).toBeNull();
    expect(after.r2h).toBeNull();
  });

  it("does NOT remind a DECLINED assignment even if the shift itself is still upcoming", async () => {
    // Vacancy filled by someone else: the original officer's
    // assignment was flipped to declined. They should not get a
    // reminder for a shift they're no longer working.
    const shiftId = await makeShift({ startsInMs: 30 * 60 * 1000, suffix: "declined" });
    const [row] = await db
      .insert(shiftAssignmentsTable)
      .values({ shiftId, employeeId: ctx.empId, status: "declined" })
      .returning({ id: shiftAssignmentsTable.id });
    const aId = row.id;

    await sendPreShiftReminders();
    const after = await readAssignment(aId);
    expect(after.r30m).toBeNull();
    expect(after.r2h).toBeNull();
  });

  it("does NOT remind for a shift outside both windows (sanity check on the time bounds)", async () => {
    // 6 hours out — not in 2h (110–130m) or 30m (25–35m) windows.
    const shiftId = await makeShift({ startsInMs: 6 * 60 * 60 * 1000, suffix: "far-future" });
    const aId = await assignAccepted(shiftId);

    await sendPreShiftReminders();
    const after = await readAssignment(aId);
    expect(after.r2h).toBeNull();
    expect(after.r30m).toBeNull();
  });
});
