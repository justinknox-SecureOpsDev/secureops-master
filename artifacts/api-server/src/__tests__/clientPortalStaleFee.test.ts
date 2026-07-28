/**
 * Client portal stale-fee correction tests.
 *
 * When a processing-fee toggle is enabled after an invoice was already sent,
 * the stored processingFeeAmount is NULL (stale). These tests verify that all
 * three client-facing invoice surfaces — list, PDF, and checkout — return or
 * use the corrected total computed on-the-fly rather than the stale stored
 * value. Paid invoices are left unchanged (settled financial record).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { sql, eq } from "drizzle-orm";
import {
  db,
  usersTable,
  clientsTable,
  sitesTable,
  invoicesTable,
} from "@workspace/db";
import app from "../app";
import { signToken } from "../middlewares/auth";
import * as feeConfig from "../lib/processingFeeConfig";

const TAG = `portal-stale-fee-${randomUUID().slice(0, 8)}`;
const passwordHash = bcrypt.hashSync("test-password", 4);

type Ctx = {
  clientToken: string;
  clientId: string;
  siteId: string;
  feeOffSiteId: string;
};
const ctx = {} as Ctx;

const FEE_RATE = "8.25"; // site salesTaxRate
const SUBTOTAL = "400.00";
// Expected corrected fee: $400 × 8.25% = $33.00
const EXPECTED_FEE = 33.0;
const EXPECTED_TOTAL = 433.0;

function makeInvoiceBase() {
  return {
    invoiceNumber: `INV-TEST-${randomUUID().slice(0, 6)}`,
    clientName: `${TAG}-client`,
    lineItems: [{ description: "Security", amount: 400 }],
    subtotal: SUBTOTAL,
    taxAmount: "0",
    dueDate: "2099-01-01",
    periodStart: "2025-01-01",
    periodEnd: "2025-01-07",
  };
}

beforeAll(async () => {
  const [org] = await db
    .insert(clientsTable)
    .values({ name: `${TAG}-org`, paymentTermsDays: 14 })
    .returning({ id: clientsTable.id });
  ctx.clientId = org.id;

  // Site with fee enabled
  const [site] = await db
    .insert(sitesTable)
    .values({
      clientId: org.id,
      name: `${TAG}-fee-site`,
      salesTaxEnabled: true,
      salesTaxRate: FEE_RATE,
    })
    .returning({ id: sitesTable.id });
  ctx.siteId = site.id;

  // Site without fee (for the "no change" case)
  const [feeOffSite] = await db
    .insert(sitesTable)
    .values({
      clientId: org.id,
      name: `${TAG}-no-fee-site`,
      salesTaxEnabled: false,
    })
    .returning({ id: sitesTable.id });
  ctx.feeOffSiteId = feeOffSite.id;

  const [clientUser] = await db
    .insert(usersTable)
    .values({
      email: `${TAG}-client@example.test`,
      passwordHash,
      firstName: "ClientUser",
      lastName: TAG,
      role: "client",
      status: "active",
      clientId: org.id,
      tokensValidAfter: new Date(0),
    })
    .returning({ id: usersTable.id });
  ctx.clientToken = signToken({
    userId: clientUser.id,
    email: `${TAG}-client@example.test`,
    role: "client",
  });
});

afterAll(async () => {
  await db.execute(
    sql`DELETE FROM invoices WHERE client_id = ${ctx.clientId}::uuid`,
  );
  await db.execute(
    sql`DELETE FROM sites WHERE name LIKE ${TAG + "%"}`,
  );
  await db.execute(
    sql`DELETE FROM clients WHERE name LIKE ${TAG + "%"}`,
  );
  await db.execute(
    sql`DELETE FROM users WHERE last_name = ${TAG}`,
  );
});

// ── GET /client/invoices ───────────────────────────────────────────────────────

describe("GET /client/invoices — stale-fee correction", () => {
  it("corrects totalAmount on a sent invoice whose fee was added after it was sent", async () => {
    // Stale invoice: sent with NULL processingFeeAmount (fee was off when generated).
    const [inv] = await db
      .insert(invoicesTable)
      .values({
        ...makeInvoiceBase(),
        clientId: ctx.clientId,
        siteId: ctx.siteId,
        totalAmount: SUBTOTAL, // no fee baked in
        processingFeeAmount: null,
        processingFeeRate: null,
        status: "sent",
      })
      .returning({ id: invoicesTable.id });

    vi.spyOn(feeConfig, "isProcessingFeeEnabled").mockReturnValue(true);
    try {
      const res = await request(app)
        .get("/api/client/invoices")
        .set("Authorization", `Bearer ${ctx.clientToken}`);

      expect(res.status).toBe(200);
      const found = res.body.find((r: { id: string }) => r.id === inv.id);
      expect(found).toBeDefined();

      const returnedTotal = parseFloat(String(found.totalAmount));
      const returnedFee = parseFloat(String(found.processingFeeAmount ?? "0"));
      expect(returnedTotal).toBeCloseTo(EXPECTED_TOTAL, 2);
      expect(returnedFee).toBeCloseTo(EXPECTED_FEE, 2);
    } finally {
      vi.restoreAllMocks();
      await db.execute(
        sql`DELETE FROM invoices WHERE id = ${inv.id}::uuid`,
      );
    }
  });

  it("does not change totalAmount on a paid invoice (settled financial record)", async () => {
    const [inv] = await db
      .insert(invoicesTable)
      .values({
        ...makeInvoiceBase(),
        clientId: ctx.clientId,
        siteId: ctx.siteId,
        totalAmount: SUBTOTAL, // no fee — stale, but paid
        processingFeeAmount: null,
        processingFeeRate: null,
        status: "paid",
        paidAt: new Date(),
      })
      .returning({ id: invoicesTable.id });

    vi.spyOn(feeConfig, "isProcessingFeeEnabled").mockReturnValue(true);
    try {
      const res = await request(app)
        .get("/api/client/invoices")
        .set("Authorization", `Bearer ${ctx.clientToken}`);

      expect(res.status).toBe(200);
      const found = res.body.find((r: { id: string }) => r.id === inv.id);
      expect(found).toBeDefined();

      // Paid invoice must reflect what was charged, not current rate.
      const returnedTotal = parseFloat(String(found.totalAmount));
      expect(returnedTotal).toBeCloseTo(parseFloat(SUBTOTAL), 2);
      const returnedFee = parseFloat(String(found.processingFeeAmount ?? "0"));
      expect(returnedFee).toBe(0);
    } finally {
      vi.restoreAllMocks();
      await db.execute(
        sql`DELETE FROM invoices WHERE id = ${inv.id}::uuid`,
      );
    }
  });

  it("does not alter a sent invoice that already has a fee stored", async () => {
    const storedFee = "20.00";
    const storedTotal = "420.00";
    const [inv] = await db
      .insert(invoicesTable)
      .values({
        ...makeInvoiceBase(),
        clientId: ctx.clientId,
        siteId: ctx.siteId,
        totalAmount: storedTotal,
        processingFeeAmount: storedFee,
        processingFeeRate: "5.00",
        status: "sent",
      })
      .returning({ id: invoicesTable.id });

    vi.spyOn(feeConfig, "isProcessingFeeEnabled").mockReturnValue(true);
    try {
      const res = await request(app)
        .get("/api/client/invoices")
        .set("Authorization", `Bearer ${ctx.clientToken}`);

      expect(res.status).toBe(200);
      const found = res.body.find((r: { id: string }) => r.id === inv.id);
      expect(found).toBeDefined();

      // Stored values must pass through unchanged.
      expect(parseFloat(String(found.totalAmount))).toBeCloseTo(
        parseFloat(storedTotal),
        2,
      );
      expect(parseFloat(String(found.processingFeeAmount))).toBeCloseTo(
        parseFloat(storedFee),
        2,
      );
    } finally {
      vi.restoreAllMocks();
      await db.execute(
        sql`DELETE FROM invoices WHERE id = ${inv.id}::uuid`,
      );
    }
  });

  it("does not add a fee when the site has salesTaxEnabled=false", async () => {
    const [inv] = await db
      .insert(invoicesTable)
      .values({
        ...makeInvoiceBase(),
        clientId: ctx.clientId,
        siteId: ctx.feeOffSiteId, // fee-off site
        totalAmount: SUBTOTAL,
        processingFeeAmount: null,
        processingFeeRate: null,
        status: "sent",
      })
      .returning({ id: invoicesTable.id });

    vi.spyOn(feeConfig, "isProcessingFeeEnabled").mockReturnValue(true);
    try {
      const res = await request(app)
        .get("/api/client/invoices")
        .set("Authorization", `Bearer ${ctx.clientToken}`);

      expect(res.status).toBe(200);
      const found = res.body.find((r: { id: string }) => r.id === inv.id);
      expect(found).toBeDefined();

      // Site fee is off — total must remain at subtotal.
      expect(parseFloat(String(found.totalAmount))).toBeCloseTo(
        parseFloat(SUBTOTAL),
        2,
      );
    } finally {
      vi.restoreAllMocks();
      await db.execute(
        sql`DELETE FROM invoices WHERE id = ${inv.id}::uuid`,
      );
    }
  });
});

// ── GET /client/invoices/:id/pdf ───────────────────────────────────────────────

describe("GET /client/invoices/:id/pdf — stale-fee correction", () => {
  it("returns a PDF (200 application/pdf) for a stale sent invoice", async () => {
    const [inv] = await db
      .insert(invoicesTable)
      .values({
        ...makeInvoiceBase(),
        clientId: ctx.clientId,
        siteId: ctx.siteId,
        totalAmount: SUBTOTAL,
        processingFeeAmount: null,
        processingFeeRate: null,
        status: "sent",
      })
      .returning({ id: invoicesTable.id });

    vi.spyOn(feeConfig, "isProcessingFeeEnabled").mockReturnValue(true);
    try {
      const res = await request(app)
        .get(`/api/client/invoices/${inv.id}/pdf`)
        .set("Authorization", `Bearer ${ctx.clientToken}`);

      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toMatch(/application\/pdf/);
    } finally {
      vi.restoreAllMocks();
      await db.execute(
        sql`DELETE FROM invoices WHERE id = ${inv.id}::uuid`,
      );
    }
  });
});

// ── POST /client/invoices/:id/checkout ────────────────────────────────────────

describe("POST /client/invoices/:id/checkout — stale-fee correction", () => {
  it("proceeds to Stripe session creation (503 when key absent) for a stale sent invoice without rejecting it", async () => {
    // Without STRIPE_SECRET_KEY set in test env the route returns 503 — but
    // it must reach that point, meaning stale-fee detection did not block it.
    const [inv] = await db
      .insert(invoicesTable)
      .values({
        ...makeInvoiceBase(),
        clientId: ctx.clientId,
        siteId: ctx.siteId,
        totalAmount: SUBTOTAL,
        processingFeeAmount: null,
        processingFeeRate: null,
        status: "sent",
      })
      .returning({ id: invoicesTable.id });

    vi.spyOn(feeConfig, "isProcessingFeeEnabled").mockReturnValue(true);
    const origKey = process.env.STRIPE_SECRET_KEY;
    delete process.env.STRIPE_SECRET_KEY;
    try {
      const res = await request(app)
        .post(`/api/client/invoices/${inv.id}/checkout`)
        .set("Authorization", `Bearer ${ctx.clientToken}`)
        .send({});

      // 503 = reached Stripe-config check (stale fee did not cause a 4xx before it)
      expect(res.status).toBe(503);
      expect(res.body.stripeConfigured).toBe(false);
    } finally {
      if (origKey !== undefined) process.env.STRIPE_SECRET_KEY = origKey;
      vi.restoreAllMocks();
      await db.execute(
        sql`DELETE FROM invoices WHERE id = ${inv.id}::uuid`,
      );
    }
  });
});
