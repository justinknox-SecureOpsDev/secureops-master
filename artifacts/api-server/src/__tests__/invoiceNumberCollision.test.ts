/**
 * Invoice-number collision tests.
 *
 * Verifies that invoice creation never fails with a 23505 duplicate-key
 * error on invoice_number, regardless of how many invoices already exist
 * for the current month.
 *
 * Two guarantees tested:
 *  1. generateInvoiceNumber() uses max(cast…integer)+1, not text-max, so
 *     it correctly steps from 9999 → 10000 → 10001 (text ordering would
 *     treat '9999' > '10000').
 *  2. The retry wrapper in the POST /invoices handler recovers from a
 *     23505 on invoice_number_unique: a vi.spyOn makes the first call
 *     return the already-occupied number so the INSERT hits the unique
 *     constraint; the catch retries, calls the real implementation, gets
 *     max+1, and succeeds.
 *
 * The spy works because routes/invoices.ts imports the generator through
 * the `invoiceSync` namespace object (`import * as invoiceSync`) and calls
 * `invoiceSync.generateInvoiceNumber()`.  In Vitest's CJS runtime both
 * the test and the route share the same module-cache object, so
 * vi.spyOn(invoiceSync, 'generateInvoiceNumber') intercepts the route's
 * call cleanly.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { eq, sql } from "drizzle-orm";
import {
  db,
  usersTable,
  clientsTable,
  sitesTable,
  invoicesTable,
} from "@workspace/db";
import app from "../app";
import { signToken } from "../middlewares/auth";
import * as invoiceSync from "../lib/invoiceSync";

const TAG = `invnum-${randomUUID().slice(0, 8)}`;
const passwordHash = bcrypt.hashSync("test-password", 4);

/** YYYY-MM prefix matching the current UTC month. */
function currentPrefix(): string {
  const now = new Date();
  return `INV-${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

type Ctx = {
  adminId: string;
  adminToken: string;
  clientId: string;
  siteId: string;
};
const ctx = {} as Ctx;

/** Insert a skeletal invoice row to occupy a given invoice_number. */
async function occupyNumber(num: string): Promise<string> {
  const [row] = await db
    .insert(invoicesTable)
    .values({
      invoiceNumber: num,
      clientName: `${TAG}-seed`,
      lineItems: [],
      subtotal: "0",
      taxAmount: "0",
      totalAmount: "0",
      status: "void",
      dueDate: "2099-12-31",
    })
    .returning({ id: invoicesTable.id });
  return row.id;
}

/**
 * Query the current max NUMERIC suffix for the given month prefix.
 * Uses sql.raw() for the position literal to avoid Drizzle parameterisation
 * issues (the same technique generateInvoiceNumber itself uses).
 */
async function currentMaxSuffix(prefix: string): Promise<number> {
  const posRaw = sql.raw(String(prefix.length + 2));
  const [row] = await db
    .select({
      maxSuffix: sql<number | null>`max(
        case when substring(invoice_number from ${posRaw}) ~ '^[0-9]+$'
             then cast(substring(invoice_number from ${posRaw}) as integer)
        end
      )`,
    })
    .from(invoicesTable)
    .where(sql`invoice_number like ${prefix + "-%"}`);
  return row?.maxSuffix ?? 0;
}

beforeAll(async () => {
  const [admin] = await db
    .insert(usersTable)
    .values({
      email: `${TAG}-admin@example.test`,
      passwordHash,
      firstName: "Admin",
      lastName: TAG,
      role: "admin",
      status: "active",
      tokensValidAfter: new Date(0),
    })
    .returning({ id: usersTable.id });
  ctx.adminId = admin.id;
  ctx.adminToken = signToken({ userId: ctx.adminId, email: `${TAG}-admin@example.test`, role: "admin" });

  // Officer not used in routes but added for completeness of the test user set.
  await db.insert(usersTable).values({
    email: `${TAG}-officer@example.test`,
    passwordHash,
    firstName: "Officer",
    lastName: TAG,
    role: "employee",
    status: "active",
    tokensValidAfter: new Date(0),
  });

  const [client] = await db
    .insert(clientsTable)
    .values({ name: `${TAG}-client`, paymentTermsDays: 14 })
    .returning({ id: clientsTable.id });
  ctx.clientId = client.id;

  const [site] = await db
    .insert(sitesTable)
    .values({
      clientId: ctx.clientId,
      name: `${TAG}-site`,
      address: "99 Test Ave",
      defaultBillRate: "50.00",
    })
    .returning({ id: sitesTable.id });
  ctx.siteId = site.id;
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.execute(sql`DELETE FROM invoices WHERE client_id = ${ctx.clientId}::uuid`);
  await db.execute(sql`DELETE FROM invoices WHERE client_name = ${TAG + "-seed"}`);
  await db.execute(sql`DELETE FROM invoices WHERE client_name = ${TAG + "-manual"}`);
  await db.execute(sql`DELETE FROM sites WHERE name LIKE ${TAG + "%"}`);
  await db.execute(sql`DELETE FROM clients WHERE name LIKE ${TAG + "%"}`);
  await db.execute(sql`DELETE FROM users WHERE last_name = ${TAG}`);
});

// ---------------------------------------------------------------------------
// Unit: generateInvoiceNumber()
// ---------------------------------------------------------------------------
describe("generateInvoiceNumber()", () => {
  it("returns max+1 within the current month using numeric (not text) ordering", async () => {
    const prefix = currentPrefix();
    const baseMax = await currentMaxSuffix(prefix);

    // Seed: baseMax+1, baseMax+3, baseMax+5 (gaps at +2 and +4).
    const seeded: string[] = [];
    for (const offset of [1, 3, 5]) {
      const id = await occupyNumber(`${prefix}-${String(baseMax + offset).padStart(4, "0")}`);
      seeded.push(id);
    }

    try {
      const next = await invoiceSync.generateInvoiceNumber();
      // max is now baseMax+5 → next must be baseMax+6
      const expected = `${prefix}-${String(baseMax + 6).padStart(4, "0")}`;
      expect(next).toBe(expected);
    } finally {
      await db.execute(
        sql`DELETE FROM invoices WHERE id = ANY(${sql.raw(`ARRAY['${seeded.join("','")}']::uuid[]`)})`,
      );
    }
  });

  it("steps correctly across the 9999→10000→10001 boundary (no lexical wrap)", async () => {
    const prefix = currentPrefix();
    const baseMax = await currentMaxSuffix(prefix);

    // Force the 4→5 digit boundary: seed two numbers just before and at 10000.
    // If the DB already has numbers above 9999 we still test the numeric-step
    // invariant by seeding at the current max boundary.
    const high = Math.max(baseMax, 9998);
    const num1 = `${prefix}-${String(high + 1).padStart(4, "0")}`; // e.g. "9999"
    const num2 = `${prefix}-${String(high + 2).padStart(4, "0")}`; // e.g. "10000"

    const seeded: string[] = [];
    for (const num of [num1, num2]) {
      try {
        seeded.push(await occupyNumber(num));
      } catch {
        // Already occupied — still satisfies the pre-condition.
      }
    }

    try {
      const next = await invoiceSync.generateInvoiceNumber();
      const suffix = parseInt(next.split("-").pop()!, 10);
      // Numeric max is high+2; next must be ≥ high+3.
      // Text max of '9999' > '10000' would erroneously yield high+1 instead.
      expect(suffix).toBeGreaterThanOrEqual(high + 3);
      expect(next).toMatch(/^INV-\d{6}-\d{4,}$/);
    } finally {
      if (seeded.length > 0) {
        await db.execute(
          sql`DELETE FROM invoices WHERE id = ANY(${sql.raw(`ARRAY['${seeded.join("','")}']::uuid[]`)})`,
        );
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Integration: 23505 retry path
// The route (POST /invoices) imports generateInvoiceNumber via the namespace
// object `invoiceSync`.  vi.spyOn intercepts at the property level, so the
// route's `invoiceSync.generateInvoiceNumber()` call sees the spy.
// ---------------------------------------------------------------------------
describe("23505 retry on invoice_number_unique", () => {
  it("POST /invoices (manual) succeeds when first generateInvoiceNumber() returns an already-taken number", async () => {
    const prefix = currentPrefix();

    // Capture what the NEXT number would be right now.
    const candidate = await invoiceSync.generateInvoiceNumber();
    expect(candidate.startsWith(prefix + "-")).toBe(true);

    // Pre-insert so any INSERT with `candidate` gets 23505 on invoice_number_unique.
    const blockerId = await occupyNumber(candidate);

    // Spy: first call returns the already-taken candidate; every subsequent
    // call invokes the real implementation (which now sees candidate in the
    // DB and returns max+1, i.e. candidate+1).
    const realFn = invoiceSync.generateInvoiceNumber;
    let firstCall = true;
    vi.spyOn(invoiceSync, "generateInvoiceNumber").mockImplementation(async () => {
      if (firstCall) {
        firstCall = false;
        return candidate; // forces 23505 on invoice_number_unique
      }
      return realFn(); // real max+1 logic
    });

    try {
      const res = await request(app)
        .post("/api/invoices")
        .set({ Authorization: `Bearer ${ctx.adminToken}` })
        .send({
          clientName: `${TAG}-manual`,
          lineItems: [{ description: "Security Guard", hours: 4, rate: 50, amount: 200 }],
          dueDate: "2099-12-31",
        });

      expect(res.status).toBe(201);
      expect(res.body.id).toBeTruthy();
      // Retry picked the next available slot — must differ from the blocked candidate.
      expect(res.body.invoiceNumber).not.toBe(candidate);
      expect(res.body.invoiceNumber).toMatch(/^INV-\d{6}-\d{4,}$/);
    } finally {
      await db.delete(invoicesTable).where(eq(invoicesTable.id, blockerId));
    }
  });
});
