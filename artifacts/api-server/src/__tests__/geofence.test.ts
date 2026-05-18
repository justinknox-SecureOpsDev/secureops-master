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
  timeEntriesTable,
} from "@workspace/db";
import { evaluateGeofence } from "../lib/geofence";

const TAG = `geofence-test-${randomUUID().slice(0, 8)}`;
const passwordHash = bcrypt.hashSync("test-password", 4);

type Ctx = {
  employeeId: string;
  clientId: string;
  siteId: string;
  shiftId: string;
  timeEntryId: string;
  siteLat: number;
  siteLng: number;
};
const ctx = {} as Ctx;

beforeAll(async () => {
  // Make sure the breach cooldown is the prod default (5 min). The
  // geofence module reads the env at module load — these tests run with
  // it unset, so 5min is what we'll be testing against.

  const [emp] = await db
    .insert(usersTable)
    .values({
      email: `${TAG}-emp-${randomUUID().slice(0, 6)}@example.test`,
      passwordHash,
      firstName: "Geo",
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

  // Austin-ish coords; precise enough that small perturbations land us
  // either side of the 0.25-mile default radius deterministically.
  ctx.siteLat = 30.2672;
  ctx.siteLng = -97.7431;

  const [site] = await db
    .insert(sitesTable)
    .values({
      clientId: ctx.clientId,
      name: `${TAG}-site`,
      address: "1 Test Way",
      locationLat: ctx.siteLat.toString(),
      locationLng: ctx.siteLng.toString(),
    })
    .returning({ id: sitesTable.id });
  ctx.siteId = site.id;

  const start = new Date(Date.now() - 30 * 60_000);
  const end = new Date(start.getTime() + 8 * 60 * 60_000);
  const [shift] = await db
    .insert(shiftsTable)
    .values({
      title: `${TAG}-shift`,
      siteId: ctx.siteId,
      startTime: start,
      endTime: end,
      requiredLicenseLevel: 2,
      headcount: 1,
      status: "in_progress",
    })
    .returning({ id: shiftsTable.id });
  ctx.shiftId = shift.id;

  // Open (no clockOutTime) time entry — the geofence evaluator only acts
  // on currently-active clock-ins.
  const [te] = await db
    .insert(timeEntriesTable)
    .values({
      shiftId: ctx.shiftId,
      siteId: ctx.siteId,
      employeeId: ctx.employeeId,
      clockInTime: new Date(Date.now() - 5 * 60_000),
    })
    .returning({ id: timeEntriesTable.id });
  ctx.timeEntryId = te.id;
});

afterAll(async () => {
  await db.execute(
    sql`DELETE FROM time_entries WHERE employee_id IN (SELECT id FROM users WHERE last_name = ${TAG})`,
  );
  await db.execute(sql`DELETE FROM shifts WHERE title LIKE ${TAG + "%"}`);
  await db.execute(sql`DELETE FROM sites WHERE name LIKE ${TAG + "%"}`);
  await db.execute(sql`DELETE FROM clients WHERE name LIKE ${TAG + "%"}`);
  await db.execute(sql`DELETE FROM users WHERE last_name = ${TAG}`);
});

async function readEntry() {
  const [row] = await db
    .select({
      state: timeEntriesTable.geofenceState,
      lastBreachAt: timeEntriesTable.geofenceLastBreachAt,
    })
    .from(timeEntriesTable)
    .where(eq(timeEntriesTable.id, ctx.timeEntryId))
    .limit(1);
  return row;
}

async function resetEntryState() {
  await db
    .update(timeEntriesTable)
    .set({ geofenceState: null, geofenceLastBreachAt: null })
    .where(eq(timeEntriesTable.id, ctx.timeEntryId));
}

// ~0.7 miles east of site at ~30° latitude. Outside the 0.25-mile default radius.
const OUTSIDE_LNG_OFFSET = 0.012;
// ~0.001° ≈ ~70m ≈ ~0.04 miles. Well inside 0.25 miles.
const INSIDE_LNG_OFFSET = 0.001;

describe("evaluateGeofence — breach state machine", () => {
  it("transitions null → inside on first inside ping without stamping a breach", async () => {
    await resetEntryState();
    await evaluateGeofence(ctx.employeeId, ctx.siteLat, ctx.siteLng + INSIDE_LNG_OFFSET);
    const row = await readEntry();
    expect(row.state).toBe("inside");
    expect(row.lastBreachAt).toBeNull();
  });

  it("fires a breach exactly once on the inside → outside transition", async () => {
    await resetEntryState();
    // Establish baseline inside.
    await evaluateGeofence(ctx.employeeId, ctx.siteLat, ctx.siteLng + INSIDE_LNG_OFFSET);
    const baseline = await readEntry();
    expect(baseline.state).toBe("inside");
    expect(baseline.lastBreachAt).toBeNull();

    // First outside ping — drift detected. State flips and the breach
    // timestamp is stamped.
    await evaluateGeofence(ctx.employeeId, ctx.siteLat, ctx.siteLng + OUTSIDE_LNG_OFFSET);
    const afterBreach = await readEntry();
    expect(afterBreach.state).toBe("outside");
    expect(afterBreach.lastBreachAt).not.toBeNull();
    const firstBreachMs = afterBreach.lastBreachAt!.getTime();

    // A second outside ping while already outside is NOT a transition —
    // state stays outside and the breach timestamp does not advance.
    // This is the "exactly once per breach" property: admins are not
    // re-paged for every GPS sample while the officer is away.
    await evaluateGeofence(ctx.employeeId, ctx.siteLat, ctx.siteLng + OUTSIDE_LNG_OFFSET * 1.5);
    const stillOutside = await readEntry();
    expect(stillOutside.state).toBe("outside");
    expect(stillOutside.lastBreachAt!.getTime()).toBe(firstBreachMs);
  });

  it("resets state cleanly on outside → inside (officer returned) without stamping a new breach", async () => {
    await resetEntryState();
    await evaluateGeofence(ctx.employeeId, ctx.siteLat, ctx.siteLng + INSIDE_LNG_OFFSET);
    await evaluateGeofence(ctx.employeeId, ctx.siteLat, ctx.siteLng + OUTSIDE_LNG_OFFSET);
    const breachedAt = (await readEntry()).lastBreachAt!.getTime();

    // Officer returns to site. State flips back to inside; the historical
    // breach timestamp is preserved (audit trail / cooldown reference)
    // but no new breach is stamped — return-to-site is not an alert.
    await evaluateGeofence(ctx.employeeId, ctx.siteLat, ctx.siteLng + INSIDE_LNG_OFFSET);
    const returned = await readEntry();
    expect(returned.state).toBe("inside");
    expect(returned.lastBreachAt!.getTime()).toBe(breachedAt);
  });

  it("suppresses a re-breach within the cooldown window (the alert channel is throttled)", async () => {
    await resetEntryState();
    await evaluateGeofence(ctx.employeeId, ctx.siteLat, ctx.siteLng + INSIDE_LNG_OFFSET);
    await evaluateGeofence(ctx.employeeId, ctx.siteLat, ctx.siteLng + OUTSIDE_LNG_OFFSET);
    const firstBreachMs = (await readEntry()).lastBreachAt!.getTime();

    // Return inside, then drift out again immediately (well within the
    // default 5-minute cooldown). State must reflect reality, but the
    // breach timestamp must NOT advance — otherwise a buggy/jittery
    // client could turn admin alerts into a noise machine.
    await evaluateGeofence(ctx.employeeId, ctx.siteLat, ctx.siteLng + INSIDE_LNG_OFFSET);
    await evaluateGeofence(ctx.employeeId, ctx.siteLat, ctx.siteLng + OUTSIDE_LNG_OFFSET);
    const second = await readEntry();
    expect(second.state).toBe("outside");
    expect(second.lastBreachAt!.getTime()).toBe(firstBreachMs);
  });

  it("no-ops when the officer is not clocked in", async () => {
    // Close out the time entry — evaluateGeofence should now find no
    // active entry and return without touching anything.
    await db
      .update(timeEntriesTable)
      .set({ clockOutTime: new Date(), geofenceState: null, geofenceLastBreachAt: null })
      .where(eq(timeEntriesTable.id, ctx.timeEntryId));

    await evaluateGeofence(ctx.employeeId, ctx.siteLat, ctx.siteLng + OUTSIDE_LNG_OFFSET);
    const row = await readEntry();
    expect(row.state).toBeNull();
    expect(row.lastBreachAt).toBeNull();

    // Re-open the entry for any later tests in the same file (none right now,
    // but keeps the fixture in a known state).
    await db
      .update(timeEntriesTable)
      .set({ clockOutTime: null })
      .where(eq(timeEntriesTable.id, ctx.timeEntryId));
  });
});
