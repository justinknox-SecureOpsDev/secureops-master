/**
 * Invoice send review gate.
 *
 * An invoice must not be able to reach a client until an admin has had the
 * actual email in front of them and pressed confirm. A dialog alone cannot
 * guarantee that — any caller can POST straight to the send endpoint — so the
 * rule is enforced server-side with a single-use ticket issued by
 * POST /invoices/send-preview and redeemed by POST /invoices/:id/send.
 *
 * The invariants that matter:
 *   (a) no ticket            → refused, invoice untouched
 *   (b) unknown/garbage      → refused
 *   (c) ticket already used  → refused (no accidental double-send)
 *   (d) ticket from admin A  → refused for admin B
 *   (e) numbers changed after the preview → refused (stale approval)
 *   (f) a refusal never mutates the invoice
 *   (g) the happy path still sends and marks the invoice sent
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { eq, inArray } from "drizzle-orm";
import { db, usersTable, clientsTable, sitesTable, invoicesTable } from "@workspace/db";
import app from "../app";
import { signToken } from "../middlewares/auth";

const TAG = `invsendgate-${randomUUID().slice(0, 8)}`;
const passwordHash = bcrypt.hashSync("test-password", 4);

type Ctx = {
  adminAId: string;
  adminBId: string;
  adminAToken: string;
  adminBToken: string;
  clientId: string;
  siteId: string;
};
const ctx = {} as Ctx;
const madeInvoices: string[] = [];

async function mkAdmin(suffix: string) {
  const email = `${TAG}-${suffix}@example.test`;
  const [row] = await db
    .insert(usersTable)
    .values({
      email,
      passwordHash,
      firstName: "Admin",
      lastName: TAG,
      role: "admin",
      status: "active",
      tokensValidAfter: new Date(0),
    })
    .returning({ id: usersTable.id });
  return { id: row.id, token: signToken({ userId: row.id, email, role: "admin" }) };
}

/** A sendable draft invoice with a client email and one priced line item. */
async function mkInvoice(status = "draft") {
  const [row] = await db
    .insert(invoicesTable)
    .values({
      invoiceNumber: `${TAG}-${randomUUID().slice(0, 8)}`,
      clientId: ctx.clientId,
      siteId: ctx.siteId,
      periodStart: "2025-08-04",
      periodEnd: "2025-08-10",
      clientName: `${TAG}-client`,
      clientEmail: `${TAG}-billing@example.test`,
      lineItems: [{ description: "Officer One", level: 1, hours: 40, rate: 25, amount: 1000 }],
      subtotal: "1000.00",
      totalAmount: "1000.00",
      status,
      dueDate: "2025-08-24",
      // Hand-edited drafts are excluded from the one-active-auto-draft-per
      // (site, week) unique index, so the fixtures here can share a period.
      autoSynced: false,
    })
    .returning({ id: invoicesTable.id });
  madeInvoices.push(row.id);
  return row.id;
}

async function statusOf(id: string) {
  const [row] = await db
    .select({ status: invoicesTable.status })
    .from(invoicesTable)
    .where(eq(invoicesTable.id, id));
  return row?.status;
}

/** Ask for the review preview and return the single-use token. */
async function previewToken(invoiceId: string, token = ctx.adminAToken) {
  const res = await request(app)
    .post("/api/invoices/send-preview")
    .set("Authorization", `Bearer ${token}`)
    .send({ ids: [invoiceId] });
  expect(res.status).toBe(200);
  return res.body.previews[0];
}

beforeAll(async () => {
  const a = await mkAdmin("admin-a");
  const b = await mkAdmin("admin-b");
  ctx.adminAId = a.id;
  ctx.adminAToken = a.token;
  ctx.adminBId = b.id;
  ctx.adminBToken = b.token;

  const [client] = await db
    .insert(clientsTable)
    .values({ name: `${TAG}-client`, paymentTermsDays: 14 })
    .returning({ id: clientsTable.id });
  ctx.clientId = client.id;

  const [site] = await db
    .insert(sitesTable)
    .values({ name: `${TAG}-site`, address: "1 Test Way", clientId: ctx.clientId })
    .returning({ id: sitesTable.id });
  ctx.siteId = site.id;
});

afterAll(async () => {
  if (madeInvoices.length > 0) {
    await db.delete(invoicesTable).where(inArray(invoicesTable.id, madeInvoices));
  }
  await db.delete(sitesTable).where(eq(sitesTable.id, ctx.siteId));
  await db.delete(clientsTable).where(eq(clientsTable.id, ctx.clientId));
  await db.delete(usersTable).where(inArray(usersTable.id, [ctx.adminAId, ctx.adminBId]));
});

describe("invoice send requires a reviewed preview", () => {
  it("refuses to send an invoice that was never previewed, and leaves it untouched", async () => {
    const id = await mkInvoice();

    const res = await request(app)
      .post(`/api/invoices/${id}/send`)
      .set("Authorization", `Bearer ${ctx.adminAToken}`)
      .send({});

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("preview_required");
    // The whole point: a blocked send is a no-op, not a partial one.
    expect(await statusOf(id)).toBe("draft");
  });

  it("refuses a made-up token", async () => {
    const id = await mkInvoice();

    const res = await request(app)
      .post(`/api/invoices/${id}/send`)
      .set("Authorization", `Bearer ${ctx.adminAToken}`)
      .send({ previewToken: randomUUID() });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("preview_required");
    expect(await statusOf(id)).toBe("draft");
  });

  it("previewing does not send or mutate anything", async () => {
    const id = await mkInvoice();
    const preview = await previewToken(id);

    expect(preview.sendable).toBe(true);
    expect(preview.previewToken).toBeTruthy();
    // The admin has to be shown the real message, not a placeholder.
    expect(preview.subject).toContain(preview.invoiceNumber);
    expect(preview.html).toBeTruthy();
    expect(preview.text).toBeTruthy();
    expect(preview.to).toBe(`${TAG}-billing@example.test`);
    expect(preview.attachmentFilename).toMatch(/\.pdf$/);
    expect(await statusOf(id)).toBe("draft");
  });

  it("sends once the previewed token is presented", async () => {
    const id = await mkInvoice();
    const preview = await previewToken(id);

    const res = await request(app)
      .post(`/api/invoices/${id}/send`)
      .set("Authorization", `Bearer ${ctx.adminAToken}`)
      .send({ previewToken: preview.previewToken });

    expect(res.status).toBe(200);
    expect(res.body.invoiceNumber).toBe(preview.invoiceNumber);
    expect(await statusOf(id)).toBe("sent");
  });

  it("refuses to reuse a token that already sent", async () => {
    const id = await mkInvoice();
    const preview = await previewToken(id);

    const first = await request(app)
      .post(`/api/invoices/${id}/send`)
      .set("Authorization", `Bearer ${ctx.adminAToken}`)
      .send({ previewToken: preview.previewToken });
    expect(first.status).toBe(200);

    const second = await request(app)
      .post(`/api/invoices/${id}/send`)
      .set("Authorization", `Bearer ${ctx.adminAToken}`)
      .send({ previewToken: preview.previewToken });
    expect(second.status).toBe(409);
    expect(second.body.code).toBe("preview_required");
  });

  it("refuses a token issued for a different invoice", async () => {
    const reviewed = await mkInvoice();
    const other = await mkInvoice();
    const preview = await previewToken(reviewed);

    const res = await request(app)
      .post(`/api/invoices/${other}/send`)
      .set("Authorization", `Bearer ${ctx.adminAToken}`)
      .send({ previewToken: preview.previewToken });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("preview_required");
    expect(await statusOf(other)).toBe("draft");
  });

  it("refuses a token issued to a different admin", async () => {
    const id = await mkInvoice();
    const preview = await previewToken(id, ctx.adminAToken);

    const res = await request(app)
      .post(`/api/invoices/${id}/send`)
      .set("Authorization", `Bearer ${ctx.adminBToken}`)
      .send({ previewToken: preview.previewToken });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("preview_required");
    expect(await statusOf(id)).toBe("draft");
  });

  it("refuses a token whose invoice changed after it was reviewed", async () => {
    const id = await mkInvoice();
    const preview = await previewToken(id);

    // Someone re-prices the invoice between review and confirm. What the admin
    // approved is no longer what would go out.
    await db
      .update(invoicesTable)
      .set({ subtotal: "2500.00", totalAmount: "2500.00" })
      .where(eq(invoicesTable.id, id));

    const res = await request(app)
      .post(`/api/invoices/${id}/send`)
      .set("Authorization", `Bearer ${ctx.adminAToken}`)
      .send({ previewToken: preview.previewToken });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("preview_required");
    expect(await statusOf(id)).toBe("draft");
  });

  it("refuses a token whose PDF-only fields changed after it was reviewed", async () => {
    // Notes and the billing address never appear in the email body, but they
    // are printed on the attached PDF — so they have to invalidate the review
    // too, or the client receives a document the admin never saw.
    const id = await mkInvoice();
    const preview = await previewToken(id);

    await db
      .update(invoicesTable)
      .set({ notes: "Late fee applies after 30 days." })
      .where(eq(invoicesTable.id, id));

    const res = await request(app)
      .post(`/api/invoices/${id}/send`)
      .set("Authorization", `Bearer ${ctx.adminAToken}`)
      .send({ previewToken: preview.previewToken });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("preview_required");
    expect(await statusOf(id)).toBe("draft");
  });

  it("refuses a token that has expired", async () => {
    const id = await mkInvoice();
    const preview = await previewToken(id);

    // A review left open overnight is not a review. Ticket TTL is 30 minutes.
    const realNow = Date.now();
    const spy = vi.spyOn(Date, "now").mockReturnValue(realNow + 31 * 60 * 1000);
    try {
      const res = await request(app)
        .post(`/api/invoices/${id}/send`)
        .set("Authorization", `Bearer ${ctx.adminAToken}`)
        .send({ previewToken: preview.previewToken });

      expect(res.status).toBe(409);
      expect(res.body.code).toBe("preview_required");
    } finally {
      spy.mockRestore();
    }
    expect(await statusOf(id)).toBe("draft");
  });

  it("changing only the recipient does not invalidate the review", async () => {
    // The To field is editable inside the confirmation dialog, so it is
    // deliberately outside the fingerprint — the admin is looking at the
    // preview when they change it.
    const id = await mkInvoice();
    const preview = await previewToken(id);

    const res = await request(app)
      .post(`/api/invoices/${id}/send`)
      .set("Authorization", `Bearer ${ctx.adminAToken}`)
      .send({ previewToken: preview.previewToken, email: `${TAG}-someone-else@example.test` });

    expect(res.status).toBe(200);
    expect(await statusOf(id)).toBe("sent");
  });

  it("marks a void invoice unsendable in the preview and blocks the send", async () => {
    const id = await mkInvoice("void");
    const preview = await previewToken(id);

    expect(preview.sendable).toBe(false);
    expect(preview.previewToken).toBeNull();
    expect(preview.blockedReason).toBeTruthy();

    const res = await request(app)
      .post(`/api/invoices/${id}/send`)
      .set("Authorization", `Bearer ${ctx.adminAToken}`)
      .send({ previewToken: randomUUID() });
    expect(res.status).toBe(409);
    expect(await statusOf(id)).toBe("void");
  });

  it("previews every invoice in a bulk request in one call", async () => {
    const a = await mkInvoice();
    const b = await mkInvoice();

    const res = await request(app)
      .post("/api/invoices/send-preview")
      .set("Authorization", `Bearer ${ctx.adminAToken}`)
      .send({ ids: [a, b] });

    expect(res.status).toBe(200);
    expect(res.body.previews).toHaveLength(2);
    const tokens = res.body.previews.map((p: { previewToken: string }) => p.previewToken);
    // Distinct tokens — one approval must never authorise a second invoice.
    expect(new Set(tokens).size).toBe(2);
    expect(await statusOf(a)).toBe("draft");
    expect(await statusOf(b)).toBe("draft");
  });
});
