/**
 * The platform agreements' terms belong to SOBBU, not to the customer signing
 * them. Pricing, commercial/legal terms and SOBBU's own entity details are
 * resolved from platform configuration at signing time; the signer supplies
 * only the acceptance block (and, optionally, their own guarantor details).
 *
 * These tests pin the authorization boundary, not the wording:
 *  - posted field values are ignored, so a customer cannot rewrite the deal;
 *  - a signature is tied to the exact terms that were displayed;
 *  - signing is blocked (not silently completed) when SOBBU hasn't set a term.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { eq, inArray } from "drizzle-orm";
import {
  db,
  usersTable,
  platformCustomerConfigTable,
  platformAgreementSignaturesTable,
  type PlatformCustomerConfig,
} from "@workspace/db";
import app from "../app";
import { signToken } from "../middlewares/auth";

const TAG = `agr-authority-${randomUUID().slice(0, 8)}`;
const adminEmail = `${TAG}@example.com`;

const ENV: Record<string, string> = {
  ORG_CODE: "authtest",
  APP_BASE_URL: "https://authority-test.example.com",
  SOBBU_VENUE_COUNTY: "Harris",
  SOBBU_NOTICE_EMAIL: "notices@sobbu.test",
  SOBBU_PRINCIPAL_ADDRESS: "1 Provider Way, Houston, TX 77001",
  SOBBU_ARBITRATION_CITY: "Houston",
  SOBBU_CONTACT_EMAIL: "contact@sobbu.test",
  AGREEMENT_BILLING_CONTACT: "ap@customer.test",
};

const CONFIG = {
  customerName: `${TAG} Security LLC`,
  planTier: "professional",
  monthlyPriceCents: 89900,
};

let adminId = "";
let adminToken = "";
let priorConfig: PlatformCustomerConfig | undefined;
const priorEnv: Record<string, string | undefined> = {};
const signatureIds: string[] = [];

type SlotCtx = {
  termsDigest: string;
  readyToSign: boolean;
  missingProviderLabels: string[];
  fields: Array<{ key: string; group: string; authority: string; value: string }>;
};

function auth() {
  return { Authorization: `Bearer ${adminToken}` };
}

async function signingContext(): Promise<Record<string, SlotCtx>> {
  const res = await request(app)
    .get("/api/admin/platform/agreements/signing-context")
    .set(auth());
  expect(res.status).toBe(200);
  return res.body.slots as Record<string, SlotCtx>;
}

const ACCEPTANCE = {
  signerName: "Dana Owner",
  signerTitle: "Owner",
  signature: "Dana Owner",
  consent: true as const,
};

async function sign(slot: string, body: Record<string, unknown>) {
  const res = await request(app)
    .post(`/api/admin/platform/agreements/${slot}/sign`)
    .set(auth())
    .send(body);
  if (res.status === 201) signatureIds.push(res.body.signature.id);
  return res;
}

type ConfigOverrides = {
  customerName?: string | null;
  planTier?: string | null;
  monthlyPriceCents?: number | null;
};

async function setConfig(values: ConfigOverrides = {}) {
  await db
    .insert(platformCustomerConfigTable)
    .values({ id: "singleton", ...CONFIG, ...values })
    .onConflictDoUpdate({
      target: platformCustomerConfigTable.id,
      set: { ...CONFIG, ...values },
    });
}

beforeAll(async () => {
  for (const [key, value] of Object.entries(ENV)) {
    priorEnv[key] = process.env[key];
    process.env[key] = value;
  }

  const [row] = await db
    .insert(usersTable)
    .values({
      email: adminEmail,
      passwordHash: bcrypt.hashSync("test-password", 4),
      firstName: "Agreement",
      lastName: TAG,
      role: "admin",
      status: "active",
      tokensValidAfter: new Date(0),
    })
    .returning({ id: usersTable.id });
  adminId = row.id;
  adminToken = signToken({ userId: adminId, email: adminEmail, role: "admin" });

  [priorConfig] = await db
    .select()
    .from(platformCustomerConfigTable)
    .where(eq(platformCustomerConfigTable.id, "singleton"))
    .limit(1);
});

beforeEach(async () => {
  // Every test starts from fully-set SOBBU terms.
  await setConfig({});
});

afterAll(async () => {
  if (signatureIds.length > 0) {
    await db
      .delete(platformAgreementSignaturesTable)
      .where(inArray(platformAgreementSignaturesTable.id, signatureIds));
  }
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
  if (adminId) await db.delete(usersTable).where(eq(usersTable.id, adminId));
  for (const [key, value] of Object.entries(priorEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("agreement signing context", () => {
  it("marks every term provider-set and only the guarantor fields customer-completed", async () => {
    const msa = (await signingContext())["msa"]!;

    const terms = msa.fields.filter((f) => f.group !== "guaranty");
    expect(terms.length).toBeGreaterThan(0);
    expect(terms.every((f) => f.authority === "provider")).toBe(true);

    const guaranty = msa.fields.filter((f) => f.group === "guaranty");
    expect(guaranty.length).toBeGreaterThan(0);
    expect(guaranty.every((f) => f.authority === "customer")).toBe(true);
    // Customer-completed fields are never pre-supplied by the server.
    expect(guaranty.every((f) => f.value === "")).toBe(true);
  });

  it("prices the agreement from platform config and publishes a terms digest", async () => {
    const msa = (await signingContext())["msa"]!;
    expect(msa.fields.find((f) => f.key === "feeAmount")?.value).toBe("$899.00");
    expect(msa.fields.find((f) => f.key === "planTier")?.value).toBe("Professional");
    // Operator env, not the tenant-editable brand billing email.
    expect(msa.fields.find((f) => f.key === "billingContact")?.value).toBe(
      ENV["AGREEMENT_BILLING_CONTACT"],
    );
    expect(msa.termsDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(msa.readyToSign).toBe(true);
    expect(msa.missingProviderLabels).toEqual([]);
  });
});

describe("POST /admin/platform/agreements/:slot/sign", () => {
  it("ignores field values posted by the signer", async () => {
    const msa = (await signingContext())["msa"]!;

    const res = await sign("msa", {
      termsDigest: msa.termsDigest,
      // A tampered client trying to rewrite the deal it is signing.
      fields: {
        feeAmount: "$1.00",
        capMonths: "1",
        initialTerm: "1 day",
        customerLegalName: "Someone Else LLC",
        providerAddress: "Nowhere",
      },
      ...ACCEPTANCE,
    });
    expect(res.status).toBe(201);

    const [row] = await db
      .select()
      .from(platformAgreementSignaturesTable)
      .where(eq(platformAgreementSignaturesTable.id, res.body.signature.id));
    const stored = JSON.parse(row!.fieldsJson) as Record<string, string>;

    expect(stored["feeAmount"]).toBe("$899.00");
    expect(stored["capMonths"]).toBe("12");
    expect(stored["initialTerm"]).toBe("12 months");
    expect(stored["customerLegalName"]).toBe(CONFIG.customerName);
    expect(stored["providerAddress"]).toBe(ENV["SOBBU_PRINCIPAL_ADDRESS"]);
    expect(row!.documentMarkdown).not.toContain("Someone Else LLC");
    expect(row!.documentMarkdown).not.toContain("Nowhere");
  });

  it("rejects a signature offered against terms it never saw", async () => {
    const res = await sign("msa", {
      termsDigest: "f".repeat(64),
      ...ACCEPTANCE,
    });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("terms_changed");
  });

  it("rejects a signature whose terms changed after the page loaded", async () => {
    const msa = (await signingContext())["msa"]!;
    await setConfig({ monthlyPriceCents: 129900 });

    const res = await sign("msa", { termsDigest: msa.termsDigest, ...ACCEPTANCE });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("terms_changed");
  });

  it("blocks signing when SOBBU has not set a term, instead of letting the customer fill it", async () => {
    await setConfig({ monthlyPriceCents: null });

    const msa = (await signingContext())["msa"]!;
    expect(msa.readyToSign).toBe(false);
    expect(msa.missingProviderLabels).toContain("Subscription fee");

    const res = await sign("msa", {
      termsDigest: msa.termsDigest,
      fields: { feeAmount: "$1.00" },
      ...ACCEPTANCE,
    });
    expect(res.status).toBe(409);
    expect(res.body.message).toContain("Subscription fee");
    expect(res.body.message).toContain("SOBBU");
  });

  it("never falls back to tenant-editable branding for the customer legal name", async () => {
    // brand.companyName is editable by the customer's own super-admin, so an
    // unset legal name must block signing — not quietly borrow the branding.
    await setConfig({ customerName: null });

    const msa = (await signingContext())["msa"]!;
    expect(msa.fields.find((f) => f.key === "customerLegalName")?.value).toBe("");
    expect(msa.readyToSign).toBe(false);
    expect(msa.missingProviderLabels).toContain("Customer legal name");

    const res = await sign("msa", { termsDigest: msa.termsDigest, ...ACCEPTANCE });
    expect(res.status).toBe(409);
    expect(res.body.message).toContain("Customer legal name");

    await setConfig({});
  });

  it("still takes the guarantor's own details from the signer", async () => {
    const msa = (await signingContext())["msa"]!;

    const res = await sign("msa", {
      termsDigest: msa.termsDigest,
      ...ACCEPTANCE,
      guarantor: {
        name: "Jane Guarantor",
        title: "Member",
        address: "9 Guarantor Ln, Houston, TX",
        signature: "Jane Guarantor",
        consent: true,
      },
    });
    expect(res.status).toBe(201);
    expect(res.body.signature.guarantyExecuted).toBe(true);

    const [row] = await db
      .select()
      .from(platformAgreementSignaturesTable)
      .where(eq(platformAgreementSignaturesTable.id, res.body.signature.id));
    expect(row!.guarantorName).toBe("Jane Guarantor");
    expect(row!.documentMarkdown).toContain("Jane Guarantor");
  });

  it("signs the user agreement from SOBBU's configured values", async () => {
    const ua = (await signingContext())["user_agreement"]!;
    expect(ua.readyToSign).toBe(true);

    const res = await sign("user_agreement", { termsDigest: ua.termsDigest, ...ACCEPTANCE });
    expect(res.status).toBe(201);

    const [row] = await db
      .select()
      .from(platformAgreementSignaturesTable)
      .where(eq(platformAgreementSignaturesTable.id, res.body.signature.id));
    const stored = JSON.parse(row!.fieldsJson) as Record<string, string>;
    expect(stored["arbitrationCity"]).toBe(ENV["SOBBU_ARBITRATION_CITY"]);
    expect(stored["liabilityCap"]).toBe("$100");
  });
});
