import { describe, it, expect } from "vitest";
import { extractOrgCodeFromDeepLink, decideOrgCodeAction } from "../orgCode";

describe("extractOrgCodeFromDeepLink", () => {
  describe("?code= query parameter (invite link / QR payload)", () => {
    it("extracts from a custom-scheme deep link", () => {
      expect(
        extractOrgCodeFromDeepLink("secureopscommand://connect?code=acme"),
      ).toBe("acme");
    });

    it("extracts from an https universal link", () => {
      expect(
        extractOrgCodeFromDeepLink("https://secureops-command.replit.app/connect?code=wcsg"),
      ).toBe("wcsg");
    });

    it("extracts when code is not the first query param", () => {
      expect(
        extractOrgCodeFromDeepLink("https://example.com/connect?ref=email&code=acme-2"),
      ).toBe("acme-2");
    });

    it("lowercases and trims the extracted code", () => {
      expect(
        extractOrgCodeFromDeepLink("  secureopscommand://connect?code=ACME  "),
      ).toBe("acme");
    });

    it("decodes a percent-encoded code", () => {
      expect(
        extractOrgCodeFromDeepLink("https://example.com/connect?code=acme%2Dwest"),
      ).toBe("acme-west");
    });

    it("ignores a fragment after the code", () => {
      expect(
        extractOrgCodeFromDeepLink("https://example.com/connect?code=acme#section"),
      ).toBe("acme");
    });
  });

  describe("bare code (manual paste)", () => {
    it("accepts a plain code string", () => {
      expect(extractOrgCodeFromDeepLink("acme")).toBe("acme");
    });

    it("accepts a code with hyphens", () => {
      expect(extractOrgCodeFromDeepLink("acme-security")).toBe("acme-security");
    });
  });

  describe("path-segment fallback", () => {
    it("uses the last path segment when there is no code param", () => {
      expect(
        extractOrgCodeFromDeepLink("secureopscommand://connect/acme"),
      ).toBe("acme");
    });

    it("does not treat the connect route segment as a code", () => {
      expect(
        extractOrgCodeFromDeepLink("secureopscommand://connect"),
      ).toBeNull();
    });
  });

  describe("invalid input", () => {
    it("returns null for empty / whitespace input", () => {
      expect(extractOrgCodeFromDeepLink("")).toBeNull();
      expect(extractOrgCodeFromDeepLink("   ")).toBeNull();
    });

    it("returns null when the code fails validation (too short)", () => {
      expect(extractOrgCodeFromDeepLink("https://example.com/connect?code=a")).toBeNull();
    });

    it("returns null when the code contains illegal characters", () => {
      expect(
        extractOrgCodeFromDeepLink("https://example.com/connect?code=acme_west!"),
      ).toBeNull();
    });

    it("returns null when the code starts with a hyphen", () => {
      expect(
        extractOrgCodeFromDeepLink("https://example.com/connect?code=-acme"),
      ).toBeNull();
    });
  });
});

describe("decideOrgCodeAction", () => {
  describe("no org selected yet (first run)", () => {
    it("returns connect with the raw code passed through", () => {
      expect(decideOrgCodeAction("acme", null)).toEqual({
        kind: "connect",
        code: "acme",
      });
    });

    it("still returns connect for junk codes (the first-run flow validates)", () => {
      // First-run validation/errors are surfaced inline by runConnectOrgFlow, so
      // the decision must not pre-reject — it just routes to connect.
      expect(decideOrgCodeAction("a", null)).toEqual({ kind: "connect", code: "a" });
      expect(decideOrgCodeAction("", undefined)).toEqual({ kind: "connect", code: "" });
    });
  });

  describe("already connected", () => {
    it("returns switch (normalized) for a DIFFERENT valid org", () => {
      expect(decideOrgCodeAction("  ACME-West ", "globex")).toEqual({
        kind: "switch",
        code: "acme-west",
      });
    });

    it("returns same when the code points at the current org", () => {
      expect(decideOrgCodeAction("ACME", "acme")).toEqual({ kind: "same" });
    });

    it("returns invalid for a junk / crafted code — NEVER a teardown path", () => {
      // Security regression guard: a connected device must not be re-pointed (and
      // must not be torn down / signed out) on the strength of a bad code.
      expect(decideOrgCodeAction("a", "acme")).toEqual({ kind: "invalid" });
      expect(decideOrgCodeAction("acme_west!", "acme")).toEqual({ kind: "invalid" });
      expect(decideOrgCodeAction("-acme", "acme")).toEqual({ kind: "invalid" });
      expect(decideOrgCodeAction("", "acme")).toEqual({ kind: "invalid" });
    });
  });
});
