import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

/**
 * Coverage for the client-side idempotency-key handling behind the
 * Subcontractor Pay Run "Mark Paid" button.
 *
 * A double-click / retry after a lost response must NOT be able to double
 * pay a vendor. The server-side replay protection (see
 * subcontractorMarkPaidIdempotency.test.ts in api-server) only works if the
 * client sends the SAME key for a retry of the same attempt — this suite
 * pins that client behaviour:
 *   - a network/transport failure (ambiguous outcome — the write may already
 *     have committed) keeps the SAME key for the next attempt,
 *   - a definite server-side refusal (>=400 — nothing was changed) rotates
 *     to a fresh key, since that key is dead and the middleware itself
 *     evicts it.
 */

type MarkPaidBehavior = "networkfail" | "badrequest" | "ok" | "inflight";

const hoisted = vi.hoisted(() => ({
  calls: [] as { url: string; body: Record<string, unknown> | undefined }[],
  markPaidBehavior: "networkfail" as MarkPaidBehavior,
}));

vi.mock("@/lib/api", () => ({
  fetchWithAuth: vi.fn(async (url: string, init?: { body?: string }) => {
    const body = init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
    hoisted.calls.push({ url, body });
    const mk = (b: unknown, ok = true, status = 200) => ({
      ok,
      status,
      json: async () => b,
      text: async () => JSON.stringify(b),
    });
    if (url.startsWith("/api/admin/tables/subcontractor_invoices")) {
      return mk({
        rows: [
          {
            id: "inv-1",
            subcontractorId: "sub-1",
            companyName: "Acme Vendor",
            invoiceNumber: "INV-001",
            description: null,
            issueDate: null,
            dueDate: null,
            totalAmount: "500.00",
            status: "approved",
            paidAt: null,
          },
        ],
      });
    }
    if (url === "/api/subcontractor-pay-run/mark-paid") {
      if (hoisted.markPaidBehavior === "networkfail") {
        throw new Error("network timeout");
      }
      if (hoisted.markPaidBehavior === "badrequest") {
        return mk({ error: "Bad Request", message: "ids[] required" }, false, 400);
      }
      if (hoisted.markPaidBehavior === "inflight") {
        return mk(
          { error: "Conflict", code: "idempotency_in_flight", message: "An identical request with this key is still being processed." },
          false,
          409,
        );
      }
      return mk({ marked: 1, skipped: 0, ids: ["inv-1"] });
    }
    return mk({});
  }),
}));

import SubcontractorPayRunPage from "@/pages/SubcontractorPayRun";

const markPaidCalls = () => hoisted.calls.filter((c) => c.url === "/api/subcontractor-pay-run/mark-paid");
const keyOf = (i: number) => markPaidCalls()[i]?.body?.idempotencyKey as string | undefined;

async function renderWithOneSelectedInvoice() {
  render(<SubcontractorPayRunPage />);
  await screen.findByText("Acme Vendor");
  fireEvent.click(screen.getByText(/Select all/));
}

beforeEach(() => {
  hoisted.calls = [];
  hoisted.markPaidBehavior = "networkfail";
  vi.clearAllMocks();
});

describe("Subcontractor Pay Run — Mark Paid idempotency key", () => {
  it("keeps the SAME key across a retry after a network/transport failure", async () => {
    await renderWithOneSelectedInvoice();
    const markPaidBtn = screen.getByRole("button", { name: /Mark Paid/i });

    fireEvent.click(markPaidBtn);
    await screen.findByText(/Mark paid failed/i);
    expect(markPaidCalls().length).toBe(1);
    const firstKey = keyOf(0);
    expect(typeof firstKey).toBe("string");

    // Retry after the ambiguous failure: the write may have already
    // committed on the server, so the retry must carry the SAME key so the
    // server can replay the original outcome instead of risking a second
    // write.
    fireEvent.click(markPaidBtn);
    await screen.findByText(/Mark paid failed/i);
    expect(markPaidCalls().length).toBe(2);
    expect(keyOf(1)).toBe(firstKey);
  });

  it("rotates to a fresh key after a definite server-side refusal", async () => {
    hoisted.markPaidBehavior = "badrequest";
    await renderWithOneSelectedInvoice();
    const markPaidBtn = screen.getByRole("button", { name: /Mark Paid/i });

    fireEvent.click(markPaidBtn);
    await screen.findByText(/Mark paid failed/i);
    const firstKey = keyOf(0);
    expect(typeof firstKey).toBe("string");

    // A confirmed 4xx means nothing was changed and that key is now dead
    // (the server's idempotency middleware evicts non-2xx outcomes too), so
    // a further attempt must mint a fresh key rather than reuse it.
    fireEvent.click(markPaidBtn);
    await screen.findByText(/Mark paid failed/i);
    expect(keyOf(1)).not.toBe(firstKey);
  });

  it("keeps the SAME key when the server reports the original attempt is still in flight (409 idempotency_in_flight)", async () => {
    await renderWithOneSelectedInvoice();
    const markPaidBtn = screen.getByRole("button", { name: /Mark Paid/i });

    // First click: network is lost after the request reaches the server —
    // ambiguous from the client's point of view.
    fireEvent.click(markPaidBtn);
    await screen.findByText(/Mark paid failed/i);
    const firstKey = keyOf(0);
    expect(typeof firstKey).toBe("string");

    // Retry: the server now reports the ORIGINAL request under that key is
    // still being processed. This 409 is not a refusal — nothing may have
    // failed at all — so the key must still not be rotated.
    hoisted.markPaidBehavior = "inflight";
    fireEvent.click(markPaidBtn);
    await screen.findByText(/still being processed/i);
    expect(keyOf(1)).toBe(firstKey);

    // A further retry must keep reusing the same key too, for the same
    // reason — only a definite refusal or a success may free it.
    fireEvent.click(markPaidBtn);
    await screen.findByText(/still being processed/i);
    expect(keyOf(2)).toBe(firstKey);
  });

  it("succeeds with the key it sent, and starts a new attempt with a fresh key next time", async () => {
    hoisted.markPaidBehavior = "ok";
    await renderWithOneSelectedInvoice();
    const markPaidBtn = screen.getByRole("button", { name: /Mark Paid/i });

    fireEvent.click(markPaidBtn);
    await screen.findByText(/Marked 1 as paid/i);
    const firstKey = keyOf(0);
    expect(typeof firstKey).toBe("string");
  });
});
