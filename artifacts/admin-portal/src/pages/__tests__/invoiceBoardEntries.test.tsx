import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";

/**
 * Invoice Board line-item drill-down (Task: show clock-in times in invoice
 * detail): expanding a line item inside an expanded invoice must fetch the
 * invoice's underlying work sessions once and render each session's date,
 * clock-in, clock-out and hours in the business timezone — with a
 * "Still clocked in" placeholder for an open session and an inline note
 * when the entries no longer reconcile with the stored line items.
 */

const hoisted = vi.hoisted(() => ({
  entriesCalls: [] as string[],
  entriesResult: {} as Record<string, unknown>,
}));

// The board's default date filter starts at the current week's UTC Monday,
// so the fixture invoice must live in the current week to be listed.
function currentMondayISO(): string {
  const now = new Date();
  const monday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  monday.setUTCDate(monday.getUTCDate() - ((now.getUTCDay() + 6) % 7));
  return monday.toISOString().slice(0, 10);
}
const PERIOD_START = currentMondayISO();
const PERIOD_END = (() => {
  const d = new Date(`${PERIOD_START}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + 6);
  return d.toISOString().slice(0, 10);
})();

const INVOICE = {
  id: "inv1",
  invoiceNumber: "WCSG-1001",
  clientId: "c1",
  siteId: "s1",
  siteName: "Downtown Tower",
  periodStart: PERIOD_START,
  periodEnd: PERIOD_END,
  clientName: "Acme Corp",
  clientEmail: "billing@acme.test",
  lineItems: [{ description: "Jane Doe", level: 2, hours: 8, rate: 42, amount: 336 }],
  subtotal: "336.00",
  taxAmount: "0.00",
  processingFeeAmount: null,
  processingFeeRate: null,
  totalAmount: "336.00",
  status: "draft",
  dueDate: "2026-08-02",
  paidAt: null,
  autoSynced: true,
  lockedAt: null,
  createdAt: "2026-07-20T12:00:00.000Z",
};

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ user: { id: "admin1", role: "admin" } }),
}));

vi.mock("@/lib/api", () => ({
  api: vi.fn(async (path: string) => {
    const url = new URL(path, "http://test.local");
    const p = url.pathname;
    if (p === "/invoices/inv1/entries") {
      hoisted.entriesCalls.push(p);
      return hoisted.entriesResult;
    }
    if (p.startsWith("/invoices")) return [INVOICE];
    if (p === "/sites") return [{ id: "s1", name: "Downtown Tower", clientId: "c1" }];
    if (p === "/clients") return [{ id: "c1", name: "Acme Corp", billingCycle: "weekly" }];
    return [];
  }),
  fetchWithAuth: vi.fn(),
  getToken: () => "tok",
}));

import InvoiceBoard from "@/pages/InvoiceBoard";

async function expandToSessions() {
  render(<InvoiceBoard />);
  // Week group auto-expands (≤4 groups); wait for the invoice row.
  const lineButton = await screen.findByRole("button", { name: /1 line/ });
  fireEvent.click(lineButton);
  // Line-item detail table appears with the description as a drill-down button.
  const liButton = await screen.findByRole("button", { name: /Jane Doe/ });
  fireEvent.click(liButton);
}

describe("Invoice Board — line-item work-session drill-down", () => {
  beforeEach(() => {
    INVOICE.lineItems = [{ description: "Jane Doe", level: 2, hours: 8, rate: 42, amount: 336 }];
    hoisted.entriesCalls = [];
    hoisted.entriesResult = {
      unresolved: false,
      reconciled: true,
      unpricedHours: 0,
      entries: [
        {
          kind: "officer",
          entryId: "e1",
          workerName: "Jane Doe",
          description: "Jane Doe",
          // 14:00Z = 09:00 Central (CDT), Wed Jul 15 2026.
          clockIn: "2026-07-15T14:00:00.000Z",
          clockOut: "2026-07-15T22:00:00.000Z",
          hours: 8,
          rate: 42,
          level: 2,
          unpriced: false,
          billable: true,
        },
        {
          kind: "officer",
          entryId: "e2",
          workerName: "Jane Doe",
          description: "Jane Doe",
          clockIn: "2026-07-16T14:00:00.000Z",
          clockOut: null,
          hours: 0,
          rate: 42,
          level: 2,
          unpriced: false,
          billable: false,
        },
      ],
    };
    vi.clearAllMocks();
  });

  it("renders session rows with business-timezone date, clock-in, clock-out and hours", async () => {
    await expandToSessions();

    await waitFor(() => expect(screen.getByText("Jul 15, 2026")).toBeTruthy());
    // 14:00Z / 22:00Z render as Central 09:00 / 17:00 (both sessions clock in
    // at 14:00Z, so two 09:00 cells).
    expect(screen.getAllByText("09:00").length).toBe(2);
    expect(screen.getByText("17:00")).toBeTruthy();
    // "8.00" appears in the line-item hours cell AND the session row.
    expect(screen.getAllByText("8.00").length).toBeGreaterThanOrEqual(2);
    // Open session shows the placeholder, not a blank/bogus time.
    expect(screen.getByText("Still clocked in")).toBeTruthy();
    // Entries fetched exactly once for the invoice.
    expect(hoisted.entriesCalls.length).toBe(1);
    // Reconciled invoice shows no mismatch note.
    expect(screen.queryByText(/no longer match the billed line items/)).toBeNull();
  });

  it("scopes each row to its own billed grouping when descriptions collide", async () => {
    // Two line items share the description "Jane Doe" but differ in
    // level/rate — the server's grouping key. Each expanded row must show
    // ONLY its own sessions.
    INVOICE.lineItems = [
      { description: "Jane Doe", level: 2, hours: 8, rate: 42, amount: 336 },
      { description: "Jane Doe", level: 3, hours: 4, rate: 55, amount: 220 },
    ];
    hoisted.entriesResult = {
      unresolved: false,
      reconciled: true,
      unpricedHours: 0,
      entries: [
        {
          kind: "officer", entryId: "e1", workerName: "Jane Doe", description: "Jane Doe",
          clockIn: "2026-07-15T14:00:00.000Z", clockOut: "2026-07-15T22:00:00.000Z",
          hours: 8, rate: 42, level: 2, unpriced: false, billable: true,
        },
        {
          kind: "officer", entryId: "e2", workerName: "Jane Doe", description: "Jane Doe",
          clockIn: "2026-07-17T14:00:00.000Z", clockOut: "2026-07-17T18:00:00.000Z",
          hours: 4, rate: 55, level: 3, unpriced: false, billable: true,
        },
      ],
    };
    render(<InvoiceBoard />);
    const lineButton = await screen.findByRole("button", { name: /2 lines/ });
    fireEvent.click(lineButton);
    const liButtons = await screen.findAllByRole("button", { name: /Jane Doe/ });
    expect(liButtons.length).toBe(2);

    // Expand the FIRST (level 2, $42) row: only the Jul 15 session shows.
    fireEvent.click(liButtons[0]);
    await waitFor(() => expect(screen.getByText("Jul 15, 2026")).toBeTruthy());
    expect(screen.queryByText("Jul 17, 2026")).toBeNull();

    // Expand the SECOND (level 3, $55) row too: its own session appears.
    fireEvent.click(liButtons[1]);
    await waitFor(() => expect(screen.getByText("Jul 17, 2026")).toBeTruthy());
  });

  it("shows the mismatch note when the entries no longer reconcile", async () => {
    hoisted.entriesResult = { ...hoisted.entriesResult, reconciled: false };
    await expandToSessions();
    await waitFor(() =>
      expect(screen.getByText(/no longer match the billed line items/)).toBeTruthy(),
    );
  });

  it("shows a plain flagged message for an invoice whose line items cannot be traced", async () => {
    hoisted.entriesResult = {
      unresolved: true,
      reason: "This invoice has no linked site, so its line items cannot be traced back to time entries.",
      reconciled: false,
      unpricedHours: 0,
      entries: [],
    };
    await expandToSessions();
    await waitFor(() => expect(screen.getByText(/no linked site/)).toBeTruthy());
  });
});
