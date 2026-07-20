import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import {
  db,
  clientsTable,
  sitesTable,
  subcontractorTimeEntriesTable,
} from "@workspace/db";
import { upsertWeeklyInvoice, weekStartIsoUtc } from "../lib/invoiceSync";

const TAG = `subinv-test-${randomUUID().slice(0, 8)}`;

type Ctx = {
  clientId: string;
  ratedSiteId: string;
  unratedSiteId: string;
  weekStart: string;
};
const ctx = {} as Ctx;

function previousMonday(): Date {
  const d = new Date();
  const day = d.getUTCDay();
  const back = day === 0 ? 13 : 6 + day;
  d.setUTCDate(d.getUTCDate() - back);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

beforeAll(async () => {
  const [client] = await db
    .insert(clientsTable)
    .values({ name: `${TAG}-client`, paymentTermsDays: 14 })
    .returning({ id: clientsTable.id });
  ctx.clientId = client.id;

  const [ratedSite] = await db
    .insert(sitesTable)
    .values({
      clientId: ctx.clientId,
      name: `${TAG}-rated-site`,
      address: "100 Sub Way",
      defaultBillRate: "50.00",
    })
    .returning({ id: sitesTable.id });
  ctx.ratedSiteId = ratedSite.id;

  const [unratedSite] = await db
    .insert(sitesTable)
    .values({
      clientId: ctx.clientId,
      name: `${TAG}-unrated-site`,
      address: "200 Sub Way",
      // defaultBillRate intentionally NULL
    })
    .returning({ id: sitesTable.id });
  ctx.unratedSiteId = unratedSite.id;

  const monday = previousMonday();
  ctx.weekStart = weekStartIsoUtc(monday);
  const clockIn = new Date(monday.getTime() + 2 * 86400_000 + 9 * 3600_000);
  const clockOut = new Date(clockIn.getTime() + 6 * 3600_000);

  // Closed subcontractor entry on the rated site (6h).
  await db.insert(subcontractorTimeEntriesTable).values({
    siteId: ctx.ratedSiteId,
    name: "Jane Doe",
    company: "Acme Patrol",
    clockInAt: clockIn,
    clockOutAt: clockOut,
    hoursWorked: "6.00",
  });
  // A still-open entry on the rated site — must NOT be billed.
  await db.insert(subcontractorTimeEntriesTable).values({
    siteId: ctx.ratedSiteId,
    name: "Open Person",
    company: "Acme Patrol",
    clockInAt: clockIn,
    clockOutAt: null,
    hoursWorked: null,
  });
  // Closed subcontractor entry on the unrated site (no bill rate anywhere).
  await db.insert(subcontractorTimeEntriesTable).values({
    siteId: ctx.unratedSiteId,
    name: "Bob Roe",
    company: "Beta Guards",
    clockInAt: clockIn,
    clockOutAt: clockOut,
    hoursWorked: "6.00",
  });
});

afterAll(async () => {
  await db.execute(sql`DELETE FROM subcontractor_time_entries WHERE site_id IN (SELECT id FROM sites WHERE name LIKE ${TAG + "%"})`);
  await db.execute(sql`DELETE FROM invoices WHERE client_id = ${ctx.clientId}::uuid`);
  await db.execute(sql`DELETE FROM sites WHERE name LIKE ${TAG + "%"}`);
  await db.execute(sql`DELETE FROM clients WHERE name LIKE ${TAG + "%"}`);
});

describe("subcontractor hours on weekly invoices", () => {
  it("bills closed subcontractor entries at the site default bill rate", async () => {
    const result = await upsertWeeklyInvoice(ctx.ratedSiteId, ctx.weekStart);
    expect(result.status).toBe("created");
    if (result.status !== "created") return;
    // 6h * $50 = $300 (open entry excluded).
    expect(result.totalAmount).toBe(300);
    expect(result.lineCount).toBe(1);
  });

  it("is idempotent — re-running yields the same single line and total", async () => {
    const result = await upsertWeeklyInvoice(ctx.ratedSiteId, ctx.weekStart);
    expect(result.status).toBe("updated");
    if (result.status !== "updated") return;
    expect(result.totalAmount).toBe(300);
    expect(result.lineCount).toBe(1);
  });

  it("refuses (no priced entries) when the site has no bill rate for subcontractor hours", async () => {
    const result = await upsertWeeklyInvoice(ctx.unratedSiteId, ctx.weekStart);
    expect(result.status).toBe("skipped");
    if (result.status !== "skipped") return;
    expect(result.reason).toBe("no priced entries");
  });
});
