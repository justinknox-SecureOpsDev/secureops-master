import { describe, it, expect } from "vitest";
import { derivePncSettlement } from "../pncSettlement";

describe("derivePncSettlement", () => {
  describe("pending bucket (default)", () => {
    it("returns pending for an empty object", () => {
      expect(derivePncSettlement({})).toBe("pending");
    });

    it("returns pending for null and undefined", () => {
      expect(derivePncSettlement(null)).toBe("pending");
      expect(derivePncSettlement(undefined)).toBe("pending");
    });

    it("returns pending for non-object primitives", () => {
      expect(derivePncSettlement("SETTLED")).toBe("pending");
      expect(derivePncSettlement(42)).toBe("pending");
    });

    it("returns pending when a PNC payload reports RECEIVED", () => {
      expect(
        derivePncSettlement({ paymentId: "abc", paymentStatus: "RECEIVED" }),
      ).toBe("pending");
    });

    it("returns pending for an unknown status value", () => {
      expect(derivePncSettlement({ status: "SOMETHING_NEW" })).toBe("pending");
    });

    it("ignores status-like values on non-status keys", () => {
      expect(derivePncSettlement({ note: "rejected by ops" })).toBe("pending");
    });

    it("ignores non-string values on status keys", () => {
      expect(derivePncSettlement({ status: 500, state: { code: 1 } })).toBe("pending");
    });
  });

  describe("accepted bucket", () => {
    it.each(["ACCEPTED", "Approved", "processing", "SUBMITTED"])(
      "maps %s to accepted",
      (s) => {
        expect(derivePncSettlement({ paymentStatus: s })).toBe("accepted");
      },
    );

    it("handles a realistic PNC accepted payload", () => {
      expect(
        derivePncSettlement({
          requestId: "req-1",
          payment: { id: "p1", status: "ACCEPTED_FOR_PROCESSING" },
        }),
      ).toBe("accepted");
    });
  });

  describe("settled bucket", () => {
    it.each(["SETTLED", "Settlement_Complete", "COMPLETED", "paid", "SUCCESS"])(
      "maps %s to settled",
      (s) => {
        expect(derivePncSettlement({ transactionState: s })).toBe("settled");
      },
    );
  });

  describe("rejected bucket", () => {
    it.each(["REJECTED", "FAILED", "RETURNED", "ERROR", "CANCELLED", "canceled"])(
      "maps %s to rejected",
      (s) => {
        expect(derivePncSettlement({ status: s })).toBe("rejected");
      },
    );

    it("handles an ACH return payload", () => {
      expect(
        derivePncSettlement({
          paymentStatus: "RETURN_RECEIVED",
          returnReason: "R01 Insufficient Funds",
        }),
      ).toBe("rejected");
    });
  });

  describe("precedence: rejected > settled > accepted > pending", () => {
    it("rejected wins over settled", () => {
      expect(
        derivePncSettlement({ status: "SETTLED", previousStatus: "REJECTED" }),
      ).toBe("rejected");
    });

    it("rejected wins over accepted and pending", () => {
      expect(
        derivePncSettlement({
          batchStatus: "ACCEPTED",
          items: [{ status: "RECEIVED" }, { status: "FAILED" }],
        }),
      ).toBe("rejected");
    });

    it("settled wins over accepted", () => {
      expect(
        derivePncSettlement({ status: "ACCEPTED", settlementState: "SETTLED" }),
      ).toBe("settled");
    });

    it("a rejected item anywhere in a mixed batch flags the whole payload", () => {
      expect(
        derivePncSettlement({
          payments: [
            { id: 1, status: "SETTLED" },
            { id: 2, status: "SETTLED" },
            { id: 3, status: "RETURNED" },
          ],
        }),
      ).toBe("rejected");
    });
  });

  describe("nested and array payloads", () => {
    it("finds status fields nested deep inside objects", () => {
      expect(
        derivePncSettlement({
          data: { payment: { detail: { currentState: "SETTLED" } } },
        }),
      ).toBe("settled");
    });

    it("finds status fields inside arrays of objects", () => {
      expect(
        derivePncSettlement([
          { meta: "x" },
          { transactions: [{ transactionStatus: "ACCEPTED" }] },
        ]),
      ).toBe("accepted");
    });

    it("matches case-insensitive status-like key names", () => {
      expect(derivePncSettlement({ PaymentSTATE: "settled" })).toBe("settled");
      expect(derivePncSettlement({ ACHStatus: "rejected" })).toBe("rejected");
    });

    it("treats status values case-insensitively", () => {
      expect(derivePncSettlement({ status: "Rejected" })).toBe("rejected");
      expect(derivePncSettlement({ status: "sEtTlEd" })).toBe("settled");
    });
  });
});
