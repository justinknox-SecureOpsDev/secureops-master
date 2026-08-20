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
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { createHash, randomUUID } from "node:crypto";
import { PDFDocument } from "pdf-lib";

/**
 * In-memory stand-in for the agreement document objects. Uploaded documents
 * are re-read and re-hashed on every review/sign, so the tests need to be able
 * to delete or tamper with the stored bytes.
 */
const store = vi.hoisted(() => new Map<string, Buffer>());

vi.mock("../lib/objectStorage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/objectStorage")>();
  class FakeStorage extends actual.ObjectStorageService {
    async downloadObjectBuffer(key: string, opts?: { maxBytes?: number }) {
      const buffer = store.get(key);
      if (!buffer) throw new actual.ObjectNotFoundError();
      if (opts?.maxBytes && buffer.length > opts.maxBytes) {
        throw Object.assign(new Error("Object exceeds the maximum allowed size."), {
          __tooLarge: true,
        });
      }
      return {
        buffer,
        contentType: "application/pdf",
        filename: key.split("/").pop() ?? "document.pdf",
        size: buffer.length,
      };
    }
  }
  return { ...actual, ObjectStorageService: FakeStorage };
});
import bcrypt from "bcryptjs";
import { eq, inArray } from "drizzle-orm";
import {
  db,
  usersTable,
  platformCustomerConfigTable,
  platformAgreementSignaturesTable,
  platformAgreementDocsTable,
  type PlatformCustomerConfig,
} from "@workspace/db";
import app from "../app";
import { signToken } from "../middlewares/auth";
import { registerAgreementDoc } from "../lib/agreementDocs";
import { ObjectStorageService } from "../lib/objectStorage";

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

/** The slot used by the uploaded-document tests (kept off "msa" fixtures). */
const UPLOAD_SLOT = "user_agreement";

let adminId = "";
let adminToken = "";
let priorConfig: PlatformCustomerConfig | undefined;
let priorDocs: (typeof platformAgreementDocsTable.$inferSelect)[] = [];
const priorEnv: Record<string, string | undefined> = {};
const signatureIds: string[] = [];

type SlotCtx = {
  source?: "template" | "uploaded";
  template: string | null;
  document: { fileName: string; documentSha256: string } | null;
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
  priorDocs = await db.select().from(platformAgreementDocsTable);
});

beforeEach(async () => {
  // Every test starts from fully-set SOBBU terms and the bundled templates —
  // this deployment may have real uploaded documents on file.
  await setConfig({});
  await db.delete(platformAgreementDocsTable);
  store.clear();
});

/** A real (tiny) PDF, so the document can be loaded and merged like a live one. */
async function makePdf(text: string): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  pdf.addPage([300, 200]).drawText(text, { x: 20, y: 100, size: 12 });
  return Buffer.from(await pdf.save());
}

/**
 * Register an uploaded PDF for a slot the way the upload route does: the bytes
 * land in storage and the row records their hash.
 */
async function uploadDocument(
  fileName: string,
  fileKey: string,
  slot = UPLOAD_SLOT,
): Promise<{ sha: string; bytes: Buffer }> {
  const bytes = await makePdf(fileName);
  store.set(fileKey, bytes);
  const sha = createHash("sha256").update(bytes).digest("hex");
  await db
    .insert(platformAgreementDocsTable)
    .values({
      slot,
      fileKey,
      fileName,
      fileSize: bytes.length,
      documentSha256: sha,
      uploadedBy: "operator@sobbu.test",
    })
    .onConflictDoUpdate({
      target: platformAgreementDocsTable.slot,
      set: { fileKey, fileName, fileSize: bytes.length, documentSha256: sha },
    });
  return { sha, bytes };
}

afterAll(async () => {
  await db.delete(platformAgreementDocsTable);
  if (priorDocs.length > 0) await db.insert(platformAgreementDocsTable).values(priorDocs);
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

/**
 * When the platform owner uploads a replacement PDF for a slot, that PDF —
 * not the bundled markdown — is the document reviewed, signed and archived.
 */
describe("uploaded agreement documents", () => {
  const KEY_A = "/objects/uploads/agreement-a";
  const KEY_B = "/objects/uploads/agreement-b";

  it("presents the uploaded document instead of the bundled template", async () => {
    const before = (await signingContext())[UPLOAD_SLOT]!;
    expect(before.source ?? "template").toBe("template");
    expect(before.template).toBeTruthy();

    const { sha } = await uploadDocument("Executed-User-Agreement.pdf", KEY_A);
    const after = (await signingContext())[UPLOAD_SLOT]!;

    expect(after.source).toBe("uploaded");
    // The bundled wording must not be offered as the document under review.
    expect(after.template).toBeNull();
    expect(after.fields).toEqual([]);
    expect(after.document).toMatchObject({
      fileName: "Executed-User-Agreement.pdf",
      documentSha256: sha,
    });
    expect(after.readyToSign).toBe(true);
    expect(after.termsDigest).not.toBe(before.termsDigest);
  });

  it("refuses a signature offered against the template it no longer serves", async () => {
    const template = (await signingContext())[UPLOAD_SLOT]!;
    await uploadDocument("Executed-User-Agreement.pdf", KEY_A);

    const res = await sign(UPLOAD_SLOT, { termsDigest: template.termsDigest, ...ACCEPTANCE });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("terms_changed");
  });

  it("archives the signature against the uploaded PDF, not the markdown", async () => {
    const { sha } = await uploadDocument("Executed-User-Agreement.pdf", KEY_A);
    const ctx = (await signingContext())[UPLOAD_SLOT]!;

    const res = await sign(UPLOAD_SLOT, { termsDigest: ctx.termsDigest, ...ACCEPTANCE });
    expect(res.status).toBe(201);
    expect(res.body.signature.documentSource).toBe("uploaded");
    expect(res.body.signature.documentSha256).toBe(sha);

    const [row] = await db
      .select()
      .from(platformAgreementSignaturesTable)
      .where(eq(platformAgreementSignaturesTable.id, res.body.signature.id));
    expect(row!.documentSource).toBe("uploaded");
    expect(row!.documentMarkdown).toBeNull();
    expect(row!.documentFileKey).toBe(KEY_A);
    expect(row!.documentFileName).toBe("Executed-User-Agreement.pdf");
    expect(row!.documentSha256).toBe(sha);
  });

  it("builds the signed copy from the document that was displayed", async () => {
    const { bytes } = await uploadDocument("Executed-User-Agreement.pdf", KEY_A);
    const ctx = (await signingContext())[UPLOAD_SLOT]!;
    expect((await sign(UPLOAD_SLOT, { termsDigest: ctx.termsDigest, ...ACCEPTANCE })).status).toBe(
      201,
    );

    const res = await request(app)
      .get(`/api/admin/platform/agreements/${UPLOAD_SLOT}/signed-pdf`)
      .set("Authorization", `Bearer ${adminToken}`)
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on("data", (c: Buffer) => chunks.push(c));
        r.on("end", () => cb(null, Buffer.concat(chunks)));
      });
    expect(res.status).toBe(200);

    // The uploaded pages come through, with the signature certificate appended.
    const original = await PDFDocument.load(bytes);
    const signedPdf = await PDFDocument.load(res.body as Buffer);
    expect(signedPdf.getPageCount()).toBeGreaterThan(original.getPageCount());
  });

  it("blocks signing when the uploaded document is no longer in storage", async () => {
    await uploadDocument("Executed-User-Agreement.pdf", KEY_A);
    const ctx = (await signingContext())[UPLOAD_SLOT]!;

    // The object disappears after the page was loaded.
    store.delete(KEY_A);

    const blocked = (await signingContext())[UPLOAD_SLOT]!;
    expect(blocked.readyToSign).toBe(false);
    expect(blocked.template).toBeNull(); // never quietly fall back to the template

    const res = await sign(UPLOAD_SLOT, { termsDigest: ctx.termsDigest, ...ACCEPTANCE });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("document_unavailable");
  });

  it("blocks signing when the stored bytes no longer match what was registered", async () => {
    await uploadDocument("Executed-User-Agreement.pdf", KEY_A);
    const ctx = (await signingContext())[UPLOAD_SLOT]!;

    // Same key, different content: the recorded hash no longer describes it.
    store.set(KEY_A, await makePdf("swapped wording"));

    const blocked = (await signingContext())[UPLOAD_SLOT]!;
    expect(blocked.readyToSign).toBe(false);

    const res = await sign(UPLOAD_SLOT, { termsDigest: ctx.termsDigest, ...ACCEPTANCE });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("document_unavailable");
  });

  it("keeps an existing signature pinned to the version it was taken against", async () => {
    const v1 = await uploadDocument("v1.pdf", KEY_A);
    const first = (await signingContext())[UPLOAD_SLOT]!;
    const signedFirst = await sign(UPLOAD_SLOT, { termsDigest: first.termsDigest, ...ACCEPTANCE });
    expect(signedFirst.status).toBe(201);

    // The operator replaces the document after it was signed.
    const v2 = await uploadDocument("v2.pdf", KEY_B);

    const [row] = await db
      .select()
      .from(platformAgreementSignaturesTable)
      .where(eq(platformAgreementSignaturesTable.id, signedFirst.body.signature.id));
    expect(row!.documentFileKey).toBe(KEY_A);
    expect(row!.documentSha256).toBe(v1.sha);

    // ...and the replacement is a different document to sign, not the old one.
    const second = (await signingContext())[UPLOAD_SLOT]!;
    expect(second.document?.documentSha256).toBe(v2.sha);
    expect(second.termsDigest).not.toBe(first.termsDigest);
    const stale = await sign(UPLOAD_SLOT, { termsDigest: first.termsDigest, ...ACCEPTANCE });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe("terms_changed");
  });

  it("restores the bundled wording end to end when the upload is reverted", async () => {
    const original = (await signingContext())[UPLOAD_SLOT]!;
    await uploadDocument("v1.pdf", KEY_A);
    await db
      .delete(platformAgreementDocsTable)
      .where(eq(platformAgreementDocsTable.slot, UPLOAD_SLOT));

    const reverted = (await signingContext())[UPLOAD_SLOT]!;
    expect(reverted.source).toBe("template");
    expect(reverted.template).toBe(original.template);
    expect(reverted.termsDigest).toBe(original.termsDigest);

    const res = await sign(UPLOAD_SLOT, { termsDigest: reverted.termsDigest, ...ACCEPTANCE });
    expect(res.status).toBe(201);

    const [row] = await db
      .select()
      .from(platformAgreementSignaturesTable)
      .where(eq(platformAgreementSignaturesTable.id, res.body.signature.id));
    expect(row!.documentSource).toBe("template");
    expect(row!.documentMarkdown).toBeTruthy();
    expect(row!.documentFileKey).toBeNull();
  });

  it("refuses to re-register a storage location a signature already points at", async () => {
    await uploadDocument("v1.pdf", KEY_A);
    const ctx = (await signingContext())[UPLOAD_SLOT]!;
    expect((await sign(UPLOAD_SLOT, { termsDigest: ctx.termsDigest, ...ACCEPTANCE })).status).toBe(
      201,
    );

    // Overwriting that object would break the archived signed copy, so the
    // replacement has to land somewhere new.
    store.set(KEY_A, await makePdf("replacement wording"));
    const reused = await registerAgreementDoc(new ObjectStorageService(), {
      slot: UPLOAD_SLOT,
      fileKey: KEY_A,
      fileName: "v2.pdf",
      editor: "operator@sobbu.test",
    });
    expect(reused.ok).toBe(false);
    expect(reused.ok === false && reused.status).toBe(409);

    store.set(KEY_B, await makePdf("replacement wording"));
    const fresh = await registerAgreementDoc(new ObjectStorageService(), {
      slot: UPLOAD_SLOT,
      fileKey: KEY_B,
      fileName: "v2.pdf",
      editor: "operator@sobbu.test",
    });
    expect(fresh.ok).toBe(true);
  });

  it("does not offer the bundled Exhibit C guaranty against an uploaded MSA", async () => {
    await uploadDocument("Executed-MSA.pdf", KEY_A, "msa");
    try {
      const ctx = (await signingContext())["msa"]!;
      expect(ctx.source).toBe("uploaded");
      expect(ctx.fields).toEqual([]);

      const res = await sign("msa", {
        termsDigest: ctx.termsDigest,
        ...ACCEPTANCE,
        guarantor: {
          name: "Jane Guarantor",
          title: "Member",
          address: "9 Guarantor Ln, Houston, TX",
          signature: "Jane Guarantor",
          consent: true,
        },
      });
      expect(res.status).toBe(400);
    } finally {
      await db.delete(platformAgreementDocsTable).where(eq(platformAgreementDocsTable.slot, "msa"));
    }
  });
});
