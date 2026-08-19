/**
 * Company legal name, plan tier and monthly price are printed verbatim into
 * the platform agreements (MSA / User Agreement) that the customer signs in
 * their own portal. They are therefore SOBBU's to set from the control plane.
 *
 * The customer's own first admin is a super-admin by design (they need the
 * branding screen), so "super-admin" is NOT the boundary here: the tenant-side
 * PUT /admin/platform/customer-config must refuse to change these three
 * fields, or a customer could set the price and legal name on the agreement
 * they then sign. Echoing the current values back — which the platform screen
 * does on every save — must still save normally.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import {
  db,
  usersTable,
  platformCustomerConfigTable,
  type PlatformCustomerConfig,
} from "@workspace/db";
import app from "../app";
import { signToken } from "../middlewares/auth";
import { brand } from "../lib/brandConfig";

const TAG = `provider-config-${randomUUID().slice(0, 8)}`;

// requireSuperAdmin reads SUPER_ADMIN_EMAILS at module load, falling back to
// the seeded brand-admin email. Resolve the same value so our token is let in.
const superEmail = (process.env["SUPER_ADMIN_EMAILS"] ?? brand.demoAdminEmail)
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean)[0]!;

const TERMS = {
  customerName: `${TAG} Security LLC`,
  planTier: "professional",
  monthlyPriceCents: 89900,
};

let superId = "";
let superToken = "";
let createdUser = false;
let priorConfig: PlatformCustomerConfig | undefined;

function putConfig(body: Record<string, unknown>) {
  return request(app)
    .put("/api/admin/platform/customer-config")
    .set({ Authorization: `Bearer ${superToken}` })
    .send(body);
}

async function storedConfig() {
  const [row] = await db
    .select()
    .from(platformCustomerConfigTable)
    .where(eq(platformCustomerConfigTable.id, "singleton"))
    .limit(1);
  return row;
}

beforeAll(async () => {
  const [existing] = await db
    .select({ id: usersTable.id })
    .from(usersTable)
    .where(eq(usersTable.email, superEmail))
    .limit(1);
  if (existing) {
    superId = existing.id;
  } else {
    const [row] = await db
      .insert(usersTable)
      .values({
        email: superEmail,
        passwordHash: bcrypt.hashSync("test-password", 4),
        firstName: "Super",
        lastName: TAG,
        role: "admin",
        status: "active",
        tokensValidAfter: new Date(0),
      })
      .returning({ id: usersTable.id });
    superId = row.id;
    createdUser = true;
  }
  superToken = signToken({ userId: superId, email: superEmail, role: "admin" });

  priorConfig = await storedConfig();
  // Terms as SOBBU would have set them (control plane / direct config).
  await db
    .insert(platformCustomerConfigTable)
    .values({ id: "singleton", ...TERMS, officerCount: null })
    .onConflictDoUpdate({
      target: platformCustomerConfigTable.id,
      set: { ...TERMS, officerCount: null },
    });
});

afterAll(async () => {
  if (priorConfig) {
    const { id: _id, ...rest } = priorConfig;
    await db
      .update(platformCustomerConfigTable)
      .set(rest)
      .where(eq(platformCustomerConfigTable.id, "singleton"));
  } else {
    await db
      .delete(platformCustomerConfigTable)
      .where(eq(platformCustomerConfigTable.id, "singleton"));
  }
  if (createdUser) await db.delete(usersTable).where(eq(usersTable.id, superId));
});

describe("PUT /admin/platform/customer-config — provider-owned terms", () => {
  it("refuses a tenant-side change to legal name, plan tier or price", async () => {
    const res = await putConfig({
      customerName: "Discount Security LLC",
      planTier: "starter",
      monthlyPriceCents: 100,
    });
    expect(res.status).toBe(403);
    expect(res.body.providerOwnedFields).toEqual(
      expect.arrayContaining(["customerName", "planTier", "monthlyPriceCents"]),
    );
    expect(res.body.message).toContain("SOBBU");

    const row = await storedConfig();
    expect(row?.customerName).toBe(TERMS.customerName);
    expect(row?.planTier).toBe(TERMS.planTier);
    expect(row?.monthlyPriceCents).toBe(TERMS.monthlyPriceCents);
  });

  it("rejects the whole save when one provider field changed — no partial write", async () => {
    const res = await putConfig({ ...TERMS, monthlyPriceCents: 100, officerCount: 42 });
    expect(res.status).toBe(403);
    expect(res.body.providerOwnedFields).toEqual(["monthlyPriceCents"]);

    const row = await storedConfig();
    expect(row?.monthlyPriceCents).toBe(TERMS.monthlyPriceCents);
    expect(row?.officerCount).not.toBe(42);
  });

  it("saves tenant-owned settings when the provider values are echoed back unchanged", async () => {
    const res = await putConfig({ ...TERMS, officerCount: 12 });
    expect(res.status).toBe(200);
    expect(res.body?.config?.officerCount).toBe(12);
    expect(res.body?.config?.monthlyPriceCents).toBe(TERMS.monthlyPriceCents);
    expect(res.body?.config?.customerName).toBe(TERMS.customerName);
  });
});
