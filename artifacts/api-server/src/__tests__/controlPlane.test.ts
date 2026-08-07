/**
 * Remote control-plane management surface — HMAC auth contract.
 *
 * Pins the security posture the master control plane relies on:
 *   - GET /api/version is public and reports build identity;
 *   - /api/control-plane/* is INERT (503) until CONTROL_PLANE_SHARED_SECRET set;
 *   - a missing / bad signature is rejected (401);
 *   - a valid signature can read settings and write brand + feature overrides,
 *     reusing the exact same zod validation as the in-app super-admin routes.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import {
  db,
  platformBrandConfigTable,
  platformFeatureOverridesTable,
  platformCustomerConfigTable,
  platformAgreementSignaturesTable,
} from "@workspace/db";
import app from "../app";
import { signControlPlanePayload, CONTROL_PLANE_SIGNATURE_HEADER } from "../lib/controlPlaneAuth";
import {
  getConfirmEditWindowOverride,
  applyConfirmEditWindowConfig,
} from "../lib/confirmEditWindowConfig";

const SECRET = "control-plane-integration-test-secret";
let prevSecret: string | undefined;

beforeAll(() => {
  prevSecret = process.env.CONTROL_PLANE_SHARED_SECRET;
});

afterAll(async () => {
  if (prevSecret === undefined) delete process.env.CONTROL_PLANE_SHARED_SECRET;
  else process.env.CONTROL_PLANE_SHARED_SECRET = prevSecret;
  // Clean up anything this suite wrote so it never leaks into other tests.
  await db.delete(platformBrandConfigTable).where(eq(platformBrandConfigTable.id, "singleton"));
  await db
    .delete(platformFeatureOverridesTable)
    .where(eq(platformFeatureOverridesTable.featureKey, "chat"));
  await db
    .delete(platformCustomerConfigTable)
    .where(eq(platformCustomerConfigTable.id, "singleton"));
  // Reset the in-memory live-apply singleton this suite mutated back to its
  // env default so later test files aren't polluted.
  applyConfirmEditWindowConfig(null);
});

afterEach(() => {
  // Default each test back to "configured" unless it opts out.
  process.env.CONTROL_PLANE_SHARED_SECRET = SECRET;
});

describe("GET /api/version", () => {
  it("is public and reports build identity", async () => {
    const res = await request(app).get("/api/version");
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("status", "ok");
    expect(typeof res.body.version).toBe("string");
    expect(typeof res.body.builtAt).toBe("string");
  });
});

describe("/api/control-plane (HMAC)", () => {
  it("returns 503 (inert) when no shared secret is configured", async () => {
    delete process.env.CONTROL_PLANE_SHARED_SECRET;
    const res = await request(app).get("/api/control-plane/settings");
    expect(res.status).toBe(503);
  });

  it("rejects a request with no signature (401)", async () => {
    process.env.CONTROL_PLANE_SHARED_SECRET = SECRET;
    const res = await request(app).get("/api/control-plane/settings");
    expect(res.status).toBe(401);
  });

  it("rejects a request with a bad signature (401)", async () => {
    process.env.CONTROL_PLANE_SHARED_SECRET = SECRET;
    const res = await request(app)
      .get("/api/control-plane/settings")
      .set(CONTROL_PLANE_SIGNATURE_HEADER, "0".repeat(64));
    expect(res.status).toBe(401);
  });

  it("reads settings with a valid signature over the empty body", async () => {
    process.env.CONTROL_PLANE_SHARED_SECRET = SECRET;
    const sig = signControlPlanePayload("", SECRET);
    const res = await request(app)
      .get("/api/control-plane/settings")
      .set(CONTROL_PLANE_SIGNATURE_HEADER, sig);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("features");
    expect(Array.isArray(res.body.features)).toBe(true);
    expect(res.body).toHaveProperty("version");
  });

  it("writes a brand override with a valid signature", async () => {
    process.env.CONTROL_PLANE_SHARED_SECRET = SECRET;
    const body = {
      companyName: "Remote-Managed Co",
      shortName: "RMC",
      tagline: "",
      appName: "",
      colorNavy: "#102030",
      colorGold: "",
      colorCream: "",
      billingEmail: "",
      hrEmail: "",
      adminNotifyEmail: "",
      logoDataUrl: "",
    };
    const payload = JSON.stringify(body);
    const sig = signControlPlanePayload(payload, SECRET);
    const res = await request(app)
      .put("/api/control-plane/brand")
      .set(CONTROL_PLANE_SIGNATURE_HEADER, sig)
      .set("Content-Type", "application/json")
      .send(payload);
    expect(res.status).toBe(200);
    expect(res.body.brand).toMatchObject({ companyName: "Remote-Managed Co", colorNavy: "#102030" });
  });

  it("rejects an invalid brand payload (400) even with a valid signature", async () => {
    process.env.CONTROL_PLANE_SHARED_SECRET = SECRET;
    const body = { colorNavy: "not-a-hex" };
    const payload = JSON.stringify(body);
    const sig = signControlPlanePayload(payload, SECRET);
    const res = await request(app)
      .put("/api/control-plane/brand")
      .set(CONTROL_PLANE_SIGNATURE_HEADER, sig)
      .set("Content-Type", "application/json")
      .send(payload);
    expect(res.status).toBe(400);
  });

  it("toggles a feature flag with a valid signature", async () => {
    process.env.CONTROL_PLANE_SHARED_SECRET = SECRET;
    const body = { updates: [{ key: "chat", enabled: false }] };
    const payload = JSON.stringify(body);
    const sig = signControlPlanePayload(payload, SECRET);
    const res = await request(app)
      .put("/api/control-plane/features")
      .set(CONTROL_PLANE_SIGNATURE_HEADER, sig)
      .set("Content-Type", "application/json")
      .send(payload);
    expect(res.status).toBe(200);
    const chat = res.body.features.find((f: { key: string }) => f.key === "chat");
    expect(chat).toBeTruthy();
    expect(chat.enabled).toBe(false);
  });

  describe("customer / commercial config", () => {
    it("includes the customer config in the settings read", async () => {
      process.env.CONTROL_PLANE_SHARED_SECRET = SECRET;
      const sig = signControlPlanePayload("", SECRET);
      const res = await request(app)
        .get("/api/control-plane/settings")
        .set(CONTROL_PLANE_SIGNATURE_HEADER, sig);
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("customerConfig");
    });

    it("rejects a customer-config write with no signature (401)", async () => {
      process.env.CONTROL_PLANE_SHARED_SECRET = SECRET;
      const res = await request(app)
        .put("/api/control-plane/customer-config")
        .set("Content-Type", "application/json")
        .send(JSON.stringify({ planTier: "professional" }));
      expect(res.status).toBe(401);
    });

    it("writes plan / pricing and applies the edit window live", async () => {
      process.env.CONTROL_PLANE_SHARED_SECRET = SECRET;
      const body = {
        customerName: "Remote Plan Co",
        planTier: "professional",
        monthlyPriceCents: 89900,
        officerCount: 42,
        billingNotes: "net-30",
        planStartDate: "2026-01-01",
        timeConfirmEditWindowHours: "3",
      };
      const payload = JSON.stringify(body);
      const sig = signControlPlanePayload(payload, SECRET);
      const res = await request(app)
        .put("/api/control-plane/customer-config")
        .set(CONTROL_PLANE_SIGNATURE_HEADER, sig)
        .set("Content-Type", "application/json")
        .send(payload);
      expect(res.status).toBe(200);
      expect(res.body.customerConfig).toMatchObject({
        customerName: "Remote Plan Co",
        planTier: "professional",
        monthlyPriceCents: 89900,
        officerCount: 42,
        timeConfirmEditWindowHours: "3",
      });
      // The live-apply hook runs without a restart.
      expect(getConfirmEditWindowOverride()).toBe(3);
    });

    it("leaves omitted keys unchanged (version-skew tolerance)", async () => {
      process.env.CONTROL_PLANE_SHARED_SECRET = SECRET;
      // Send ONLY officerCount — every previously-saved field must survive.
      const payload = JSON.stringify({ officerCount: 50 });
      const sig = signControlPlanePayload(payload, SECRET);
      const res = await request(app)
        .put("/api/control-plane/customer-config")
        .set(CONTROL_PLANE_SIGNATURE_HEADER, sig)
        .set("Content-Type", "application/json")
        .send(payload);
      expect(res.status).toBe(200);
      expect(res.body.customerConfig.officerCount).toBe(50);
      // planTier from the previous write survived because its key was omitted.
      expect(res.body.customerConfig.planTier).toBe("professional");
    });

    it("rejects an invalid customer-config payload (400) with a valid signature", async () => {
      process.env.CONTROL_PLANE_SHARED_SECRET = SECRET;
      // officerCount must be >= 1; 0 is rejected by the shared schema.
      const payload = JSON.stringify({ officerCount: 0 });
      const sig = signControlPlanePayload(payload, SECRET);
      const res = await request(app)
        .put("/api/control-plane/customer-config")
        .set(CONTROL_PLANE_SIGNATURE_HEADER, sig)
        .set("Content-Type", "application/json")
        .send(payload);
      expect(res.status).toBe(400);
    });
  });

  describe("GET /api/control-plane/agreements", () => {
    const SIGNER = "cp-agreements-test-signer@example.test";

    afterAll(async () => {
      await db
        .delete(platformAgreementSignaturesTable)
        .where(eq(platformAgreementSignaturesTable.signerEmail, SIGNER));
    });

    it("requires a valid signature (401 without)", async () => {
      process.env.CONTROL_PLANE_SHARED_SECRET = SECRET;
      const res = await request(app).get("/api/control-plane/agreements");
      expect(res.status).toBe(401);
    });

    it("reports signed status per slot, never document contents", async () => {
      process.env.CONTROL_PLANE_SHARED_SECRET = SECRET;
      await db.insert(platformAgreementSignaturesTable).values({
        slot: "msa",
        documentTitle: "Master Subscription Agreement",
        documentMarkdown: "SECRET DOCUMENT BODY",
        documentSha256: "a".repeat(64),
        fieldsJson: "{}",
        consentText: "consent",
        signerName: "Test Signer",
        signerTitle: "CEO",
        signerEmail: SIGNER,
        signatureText: "Test Signer",
        guarantorName: null,
      });

      const sig = signControlPlanePayload("", SECRET);
      const res = await request(app)
        .get("/api/control-plane/agreements")
        .set(CONTROL_PLANE_SIGNATURE_HEADER, sig);
      expect(res.status).toBe(200);
      const { agreements } = res.body;
      expect(agreements).toHaveProperty("msa");
      expect(agreements).toHaveProperty("user_agreement");
      expect(agreements.msa.signed).toBe(true);
      expect(agreements.msa.signerName).toBe("Test Signer");
      expect(agreements.msa.documentSha256).toBe("a".repeat(64));
      expect(agreements.msa.guarantyExecuted).toBe(false);
      expect(typeof agreements.user_agreement.signed).toBe("boolean");
      expect(agreements.user_agreement.guarantyExecuted).toBeNull();
      // Status metadata only — never the agreement text or fill values.
      expect(JSON.stringify(res.body)).not.toContain("SECRET DOCUMENT BODY");
    });
  });

  describe("agreement document upload (remote)", () => {
    it("exposes per-slot custom-document status in the settings read", async () => {
      process.env.CONTROL_PLANE_SHARED_SECRET = SECRET;
      const sig = signControlPlanePayload("", SECRET);
      const res = await request(app)
        .get("/api/control-plane/settings")
        .set(CONTROL_PLANE_SIGNATURE_HEADER, sig);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.agreementDocs)).toBe(true);
      const slots = res.body.agreementDocs.map((d: { slot: string }) => d.slot);
      expect(slots).toContain("msa");
      expect(slots).toContain("user_agreement");
    });

    it("is inert (503) with no shared secret configured", async () => {
      delete process.env.CONTROL_PLANE_SHARED_SECRET;
      const res = await request(app)
        .post("/api/control-plane/agreements/upload-url")
        .set("Content-Type", "application/json")
        .send(JSON.stringify({ name: "x.pdf", size: 1, contentType: "application/pdf" }));
      expect(res.status).toBe(503);
    });

    it("rejects an upload-url request with no signature (401)", async () => {
      process.env.CONTROL_PLANE_SHARED_SECRET = SECRET;
      const res = await request(app)
        .post("/api/control-plane/agreements/upload-url")
        .set("Content-Type", "application/json")
        .send(JSON.stringify({ name: "x.pdf", size: 1, contentType: "application/pdf" }));
      expect(res.status).toBe(401);
    });

    it("rejects a non-PDF upload-url request (415)", async () => {
      process.env.CONTROL_PLANE_SHARED_SECRET = SECRET;
      const body = { name: "notes.txt", size: 10, contentType: "text/plain" };
      const payload = JSON.stringify(body);
      const sig = signControlPlanePayload(payload, SECRET);
      const res = await request(app)
        .post("/api/control-plane/agreements/upload-url")
        .set(CONTROL_PLANE_SIGNATURE_HEADER, sig)
        .set("Content-Type", "application/json")
        .send(payload);
      expect(res.status).toBe(415);
    });

    it("rejects an oversized upload-url request (413)", async () => {
      process.env.CONTROL_PLANE_SHARED_SECRET = SECRET;
      const body = { name: "big.pdf", size: 20 * 1024 * 1024, contentType: "application/pdf" };
      const payload = JSON.stringify(body);
      const sig = signControlPlanePayload(payload, SECRET);
      const res = await request(app)
        .post("/api/control-plane/agreements/upload-url")
        .set(CONTROL_PLANE_SIGNATURE_HEADER, sig)
        .set("Content-Type", "application/json")
        .send(payload);
      expect(res.status).toBe(413);
    });

    it("rejects registering an unknown slot (404)", async () => {
      process.env.CONTROL_PLANE_SHARED_SECRET = SECRET;
      const body = { fileKey: "/objects/uploads/x", fileName: "x.pdf" };
      const payload = JSON.stringify(body);
      const sig = signControlPlanePayload(payload, SECRET);
      const res = await request(app)
        .put("/api/control-plane/agreements/bogus")
        .set(CONTROL_PLANE_SIGNATURE_HEADER, sig)
        .set("Content-Type", "application/json")
        .send(payload);
      expect(res.status).toBe(404);
    });

    it("rejects an invalid register payload (400)", async () => {
      process.env.CONTROL_PLANE_SHARED_SECRET = SECRET;
      const body = { fileName: "x.pdf" }; // missing fileKey
      const payload = JSON.stringify(body);
      const sig = signControlPlanePayload(payload, SECRET);
      const res = await request(app)
        .put("/api/control-plane/agreements/msa")
        .set(CONTROL_PLANE_SIGNATURE_HEADER, sig)
        .set("Content-Type", "application/json")
        .send(payload);
      expect(res.status).toBe(400);
    });
  });
});
