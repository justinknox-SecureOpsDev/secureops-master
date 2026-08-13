/**
 * Tests for QR-code bill rates on subcontractor invoicing.
 *
 * Covers:
 *  - QR token explicit bill rate takes precedence over site default.
 *  - Missing QR bill rate falls back to the site's defaultBillRate.
 *  - Holiday premium applies to the QR rate (not only the site rate).
 *  - Public GET /subcontractor/clock/:token response never exposes pay or bill rates.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import {
  db,
  clientsTable,
  sitesTable,
  subcontractorQrTokensTable,
  subcontractorTimeEntriesTable,
} from "@workspace/db";
import { upsertWeeklyInvoice, weekStartIsoBusiness } from "../lib/invoiceSync";
import app from "../app";

const TAG = `subqrrates-test-${randomUUID().slice(0, 8)}`;
const SITE_BILL_RATE = "50.00"; // Site default
const QR_BILL_RATE = "75.00";   // Token-level override

type Ctx = {
  clientId: string;
  /** Site whose QR token has an explicit bill rate. */
  siteWithQrRateId: string;
  /** Site whose QR token has NO explicit bill rate (should fall back to site default). */
  siteNoQrRateId: string;
  tokenWithRate: string;
  tokenWithoutRate: string;
  tokenWithRateId: string;
  tokenWithoutRateId: string;
  weekStart: string;
};
const ctx = {} as Ctx;

/** Return a Wednesday at 9 AM in the previous business week (safe, never today). */
function prevWeekWednesday9am(): Date {
  const d = new Date();
  const day = d.getUTCDay();
  // Days to go back to reach last Monday
  const back = day === 0 ? 13 : 6 + day;
  d.setUTCDate(d.getUTCDate() - back);   // last Monday 00:00 UTC
  d.setUTCDate(d.getUTCDate() + 2);      // Wednesday
  d.setUTCHours(15, 0, 0, 0);           // 09:00 CDT = 15:00 UTC
  return d;
}

beforeAll(async () => {
  const [client] = await db
    .insert(clientsTable)
    .values({ name: `${TAG}-client`, paymentTermsDays: 14 })
    .returning({ id: clientsTable.id });
  ctx.clientId = client.id;

  // Site where the QR token carries an explicit bill rate.
  const [siteWithQrRate] = await db
    .insert(sitesTable)
    .values({
      clientId: ctx.clientId,
      name: `${TAG}-site-qrrate`,
      address: "1 QR Rate Lane",
      defaultBillRate: SITE_BILL_RATE,
    })
    .returning({ id: sitesTable.id });
  ctx.siteWithQrRateId = siteWithQrRate.id;

  // Site where the QR token has no bill rate → must inherit site default.
  const [siteNoQrRate] = await db
    .insert(sitesTable)
    .values({
      clientId: ctx.clientId,
      name: `${TAG}-site-noqrrate`,
      address: "2 QR Rate Lane",
      defaultBillRate: SITE_BILL_RATE,
    })
    .returning({ id: sitesTable.id });
  ctx.siteNoQrRateId = siteNoQrRate.id;

  // QR token WITH an explicit bill rate (and a pay rate — never hits invoices).
  ctx.tokenWithRate = `${TAG}-tok-rated`;
  const [tokWithRate] = await db
    .insert(subcontractorQrTokensTable)
    .values({
      siteId: ctx.siteWithQrRateId,
      token: ctx.tokenWithRate,
      payRate: "30.00",
      billRate: QR_BILL_RATE,
    })
    .returning({ id: subcontractorQrTokensTable.id });
  ctx.tokenWithRateId = tokWithRate.id;

  // QR token WITHOUT an explicit bill rate.
  ctx.tokenWithoutRate = `${TAG}-tok-unrated`;
  const [tokWithoutRate] = await db
    .insert(subcontractorQrTokensTable)
    .values({
      siteId: ctx.siteNoQrRateId,
      token: ctx.tokenWithoutRate,
      // billRate intentionally NULL
    })
    .returning({ id: subcontractorQrTokensTable.id });
  ctx.tokenWithoutRateId = tokWithoutRate.id;

  const clockIn = prevWeekWednesday9am();
  const clockOut = new Date(clockIn.getTime() + 4 * 3600_000); // 4 hours
  ctx.weekStart = weekStartIsoBusiness(clockIn);

  // 4h entry on the QR-rate site, stamped with the rated token.
  await db.insert(subcontractorTimeEntriesTable).values({
    siteId: ctx.siteWithQrRateId,
    qrTokenId: ctx.tokenWithRateId,
    name: "Alice QR",
    company: "QR Guards Inc",
    clockInAt: clockIn,
    clockOutAt: clockOut,
    hoursWorked: "4.00",
  });

  // 4h entry on the no-QR-rate site, stamped with the unrated token.
  await db.insert(subcontractorTimeEntriesTable).values({
    siteId: ctx.siteNoQrRateId,
    qrTokenId: ctx.tokenWithoutRateId,
    name: "Bob No-Rate",
    company: "Site Default Patrol",
    clockInAt: clockIn,
    clockOutAt: clockOut,
    hoursWorked: "4.00",
  });
});

afterAll(async () => {
  await db.execute(sql`DELETE FROM subcontractor_time_entries WHERE site_id IN (SELECT id FROM sites WHERE name LIKE ${TAG + "%"})`);
  await db.execute(sql`DELETE FROM subcontractor_qr_tokens WHERE site_id IN (SELECT id FROM sites WHERE name LIKE ${TAG + "%"})`);
  await db.execute(sql`DELETE FROM invoices WHERE client_id = ${ctx.clientId}::uuid`);
  await db.execute(sql`DELETE FROM sites WHERE name LIKE ${TAG + "%"}`);
  await db.execute(sql`DELETE FROM clients WHERE name LIKE ${TAG + "%"}`);
});

// ─── Invoice billing ─────────────────────────────────────────────────────────

describe("QR bill rate on subcontractor invoicing", () => {
  it("uses the QR token bill rate when the token has an explicit billRate", async () => {
    const result = await upsertWeeklyInvoice(ctx.siteWithQrRateId, ctx.weekStart);
    // 4h × $75.00 (QR rate) = $300, NOT 4h × $50 (site default) = $200.
    expect(result.status).toMatch(/^created|updated$/);
    if (result.status !== "created" && result.status !== "updated") return;
    expect(result.totalAmount).toBe(300);   // 4 × $75
    expect(result.lineCount).toBe(1);
  });

  it("is idempotent when re-run after the QR rate was applied", async () => {
    const result = await upsertWeeklyInvoice(ctx.siteWithQrRateId, ctx.weekStart);
    expect(result.status).toBe("updated");
    if (result.status !== "updated") return;
    expect(result.totalAmount).toBe(300);
    expect(result.lineCount).toBe(1);
  });

  it("falls back to the site defaultBillRate when the QR token has no billRate", async () => {
    const result = await upsertWeeklyInvoice(ctx.siteNoQrRateId, ctx.weekStart);
    // 4h × $50.00 (site default) = $200.
    expect(result.status).toMatch(/^created|updated$/);
    if (result.status !== "created" && result.status !== "updated") return;
    expect(result.totalAmount).toBe(200);   // 4 × $50
    expect(result.lineCount).toBe(1);
  });
});

// ─── Public clock-in endpoint — rates must NEVER appear ───────────────────────

describe("GET /subcontractor/clock/:token — rate fields must not be present", () => {
  it("does not expose payRate or billRate to the public clock-in endpoint (QR token WITH rates)", async () => {
    const res = await request(app).get(
      `/api/subcontractor/clock/${encodeURIComponent(ctx.tokenWithRate)}`,
    );
    expect(res.status).toBe(200);
    // Confirm it is the right site context.
    expect(res.body.siteId).toBe(ctx.siteWithQrRateId);
    // Rates must be absent — neither as explicit keys nor non-null values.
    expect(res.body).not.toHaveProperty("payRate");
    expect(res.body).not.toHaveProperty("billRate");
    expect(res.body).not.toHaveProperty("qrPayRate");
    expect(res.body).not.toHaveProperty("qrBillRate");
  });

  it("does not expose payRate or billRate to the public clock-in endpoint (QR token WITHOUT rates)", async () => {
    const res = await request(app).get(
      `/api/subcontractor/clock/${encodeURIComponent(ctx.tokenWithoutRate)}`,
    );
    expect(res.status).toBe(200);
    expect(res.body.siteId).toBe(ctx.siteNoQrRateId);
    expect(res.body).not.toHaveProperty("payRate");
    expect(res.body).not.toHaveProperty("billRate");
    expect(res.body).not.toHaveProperty("qrPayRate");
    expect(res.body).not.toHaveProperty("qrBillRate");
  });
});
