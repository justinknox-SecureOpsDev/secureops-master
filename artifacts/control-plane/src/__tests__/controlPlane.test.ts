/**
 * Control-plane unit tests — the security-critical primitives:
 *   - HMAC signing is deterministic and matches the customer verifier's scheme;
 *   - org codes are validated and backend URLs are reduced to a safe origin;
 *   - management-secret encryption round-trips (and rejects tampering);
 *   - operator credential checks accept the configured identity, reject others.
 *
 * These modules read only config (dev fallbacks) — no DB connection is opened.
 */

import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { signControlPlanePayload } from "../hmacClient";
import { isValidOrgCode, normalizeOrgCode, toSafeOrigin } from "../orgCode";
import { encryptSecret, decryptSecret } from "../crypto";
import { verifyOperatorCredentials } from "../auth";
import {
  buildRemoteChangesFilter,
  csvCell,
  summarizeBrand,
  summarizeFeatures,
  summarizePlanBilling,
  summarizeAgreement,
} from "../routes/remoteSettings";
import { OPERATOR_EMAIL, OPERATOR_PASSWORD } from "../config";

describe("HMAC signing", () => {
  it("is deterministic hex HMAC-SHA256 over the payload", () => {
    const secret = "shared";
    const payload = JSON.stringify({ companyName: "Acme" });
    const sig = signControlPlanePayload(payload, secret);
    const expected = createHmac("sha256", secret).update(payload, "utf8").digest("hex");
    expect(sig).toBe(expected);
    expect(sig).toHaveLength(64);
  });

  it("signs the empty body for GET requests", () => {
    const sig = signControlPlanePayload("", "secret");
    expect(sig).toBe(createHmac("sha256", "secret").update("", "utf8").digest("hex"));
  });
});

describe("org code validation", () => {
  it("normalizes case and whitespace", () => {
    expect(normalizeOrgCode("  ACME ")).toBe("acme");
  });

  it("accepts valid codes and rejects junk", () => {
    expect(isValidOrgCode("acme")).toBe(true);
    expect(isValidOrgCode("acme-east-1")).toBe(true);
    expect(isValidOrgCode("a")).toBe(false); // too short
    expect(isValidOrgCode("-acme")).toBe(false); // leading hyphen
    expect(isValidOrgCode("ACME!")).toBe(false);
    expect(isValidOrgCode("")).toBe(false);
  });
});

describe("safe origin reduction", () => {
  it("strips path / query / fragment to an origin", () => {
    expect(toSafeOrigin("https://acme.example.com/api/foo?x=1#z", true)).toBe(
      "https://acme.example.com",
    );
  });

  it("rejects non-https in prod but allows http in dev", () => {
    expect(toSafeOrigin("http://acme.example.com", true)).toBeNull();
    expect(toSafeOrigin("http://acme.example.com", false)).toBe("http://acme.example.com");
  });

  it("rejects garbage and non-http(s) schemes", () => {
    expect(toSafeOrigin("not a url", false)).toBeNull();
    expect(toSafeOrigin("ftp://acme.example.com", false)).toBeNull();
    expect(toSafeOrigin("", false)).toBeNull();
  });
});

describe("management-secret encryption", () => {
  it("round-trips a secret", () => {
    const secret = "customer-shared-secret-123";
    const enc = encryptSecret(secret);
    expect(enc.startsWith("v1:")).toBe(true);
    expect(enc).not.toContain(secret);
    expect(decryptSecret(enc)).toBe(secret);
  });

  it("produces a different ciphertext each time (random IV)", () => {
    expect(encryptSecret("same")).not.toBe(encryptSecret("same"));
  });

  it("rejects a tampered ciphertext", () => {
    const enc = encryptSecret("secret");
    const tampered = enc.slice(0, -2) + (enc.endsWith("AA") ? "BB" : "AA");
    expect(() => decryptSecret(tampered)).toThrow();
  });
});

describe("remote-change summaries", () => {
  it("summarizes a brand body by its changed keys", () => {
    expect(summarizeBrand({ companyName: "Acme", tagline: "Safe" })).toBe(
      "Updated brand: companyName, tagline",
    );
  });

  it("falls back gracefully for an empty or invalid brand body", () => {
    expect(summarizeBrand({})).toBe("Updated brand");
    expect(summarizeBrand(null)).toBe("Updated brand");
  });

  it("summarizes feature toggles with on/off state", () => {
    expect(
      summarizeFeatures({ updates: [{ key: "chat", enabled: true }, { key: "payroll", enabled: false }] }),
    ).toBe("Updated features: chat=on, payroll=off");
  });

  it("falls back gracefully for an empty or invalid features body", () => {
    expect(summarizeFeatures({ updates: [] })).toBe("Updated feature flags");
    expect(summarizeFeatures(null)).toBe("Updated feature flags");
  });

  it("summarizes a plan/billing body by its submitted values", () => {
    expect(
      summarizePlanBilling({
        planTier: "professional",
        monthlyPriceCents: 89900,
        officerCount: 42,
        processingFeeEnabled: true,
        processingFeeRate: "9.5",
        timeConfirmEditWindowHours: "3",
      }),
    ).toBe(
      "Updated plan & billing: plan professional, $899/mo, 42 officers, fee on 9.5%, time-edit 3h",
    );
  });

  it("shows fee off and explicit unset values for a plan/billing body", () => {
    expect(
      summarizePlanBilling({ planTier: null, monthlyPriceCents: null, processingFeeEnabled: false }),
    ).toBe("Updated plan & billing: plan unset, price unset, fee off");
  });

  it("falls back gracefully for an empty or invalid plan/billing body", () => {
    expect(summarizePlanBilling({})).toBe("Updated plan & billing");
    expect(summarizePlanBilling(null)).toBe("Updated plan & billing");
  });

  it("summarizes an agreement upload with the slot label and file name", () => {
    expect(summarizeAgreement("msa", { fileName: "wcsg-msa-signed.pdf" })).toBe(
      "Replaced MSA document: wcsg-msa-signed.pdf",
    );
    expect(summarizeAgreement("user_agreement", { fileName: "ua.pdf" })).toBe(
      "Replaced User Agreement document: ua.pdf",
    );
  });

  it("falls back gracefully when the agreement file name is missing", () => {
    expect(summarizeAgreement("msa", {})).toBe("Replaced MSA document");
    expect(summarizeAgreement("user_agreement", null)).toBe("Replaced User Agreement document");
  });
});

describe("fleet activity filters", () => {
  it("returns no clauses when nothing is filtered", () => {
    const { clauses, params } = buildRemoteChangesFilter({});
    expect(clauses).toEqual([]);
    expect(params).toEqual([]);
  });

  it("filters by customer id", () => {
    const { clauses, params } = buildRemoteChangesFilter({ customerId: "cust-1" });
    expect(clauses).toEqual(["rc.customer_id = $1"]);
    expect(params).toEqual(["cust-1"]);
  });

  it("filters by a known kind and ignores unknown kinds", () => {
    expect(buildRemoteChangesFilter({ kind: "brand" }).clauses).toEqual(["rc.kind = $1"]);
    expect(buildRemoteChangesFilter({ kind: "features" }).params).toEqual(["features"]);
    expect(buildRemoteChangesFilter({ kind: "bogus" }).clauses).toEqual([]);
  });

  it("accepts the plan_billing kind", () => {
    const f = buildRemoteChangesFilter({ kind: "plan_billing" });
    expect(f.clauses).toEqual(["rc.kind = $1"]);
    expect(f.params).toEqual(["plan_billing"]);
  });

  it("accepts the agreement kind", () => {
    const f = buildRemoteChangesFilter({ kind: "agreement" });
    expect(f.clauses).toEqual(["rc.kind = $1"]);
    expect(f.params).toEqual(["agreement"]);
  });

  it("treats a date-only until as inclusive of the whole day", () => {
    const { clauses, params } = buildRemoteChangesFilter({ until: "2026-06-20" });
    expect(clauses).toEqual(["rc.created_at < $1"]);
    expect(params).toEqual(["2026-06-21T00:00:00.000Z"]);
  });

  it("uses >= for since and a precise timestamp until", () => {
    const { clauses, params } = buildRemoteChangesFilter({
      since: "2026-06-01",
      until: "2026-06-20T12:00:00.000Z",
    });
    expect(clauses).toEqual(["rc.created_at >= $1", "rc.created_at <= $2"]);
    expect(params).toEqual(["2026-06-01T00:00:00.000Z", "2026-06-20T12:00:00.000Z"]);
  });

  it("drops unparseable dates silently and numbers params in order", () => {
    const { clauses, params } = buildRemoteChangesFilter({
      customerId: "c",
      kind: "brand",
      since: "not-a-date",
    });
    expect(clauses).toEqual(["rc.customer_id = $1", "rc.kind = $2"]);
    expect(params).toEqual(["c", "brand"]);
  });
});

describe("CSV cell escaping", () => {
  it("quotes plain values and doubles embedded quotes", () => {
    expect(csvCell("Acme")).toBe('"Acme"');
    expect(csvCell('She said "hi"')).toBe('"She said ""hi"""');
    expect(csvCell("a,b\nc")).toBe('"a,b\nc"');
  });

  it("neutralises spreadsheet formula injection", () => {
    expect(csvCell("=SUM(A1)")).toBe('"\'=SUM(A1)"');
    expect(csvCell("+1")).toBe('"\'+1"');
    expect(csvCell("-1")).toBe('"\'-1"');
    expect(csvCell("@cmd")).toBe('"\'@cmd"');
  });

  it("renders null/undefined as empty cells", () => {
    expect(csvCell(null)).toBe('""');
    expect(csvCell(undefined)).toBe('""');
    expect(csvCell(200)).toBe('"200"');
  });
});

describe("operator credentials", () => {
  it("accepts the configured operator", () => {
    expect(verifyOperatorCredentials(OPERATOR_EMAIL, OPERATOR_PASSWORD)).toBe(true);
  });

  it("rejects a wrong password or email", () => {
    expect(verifyOperatorCredentials(OPERATOR_EMAIL, "wrong")).toBe(false);
    expect(verifyOperatorCredentials("intruder@example.com", OPERATOR_PASSWORD)).toBe(false);
  });
});
