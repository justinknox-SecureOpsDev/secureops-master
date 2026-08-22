import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

/**
 * Bookkeeper (non-owner with `finance.transactions`) access to the payroll and
 * invoice records.
 *
 * The aggregate boards stay owner-only, but a user the server now admits to
 * GET /payroll and GET /invoices must get a real list screen instead of the
 * "Owner access required" dead end — and that list must never render a
 * company-level total (the API already strips grossPay/netPay/subtotal/
 * totalAmount for this caller, so the UI simply must not invent them).
 */

const hoisted = vi.hoisted(() => ({
  user: {} as Record<string, unknown>,
  payrollCalls: [] as string[],
  invoiceCalls: [] as string[],
}));

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ user: hoisted.user }),
  useHasPermission: (key: string) =>
    Array.isArray(hoisted.user.permissions) && (hoisted.user.permissions as string[]).includes(key),
}));

// Sanitized shapes: exactly what the server returns to a non-owner caller
// (see financeVisibility.ts's DASHBOARD_FINANCE_FIELDS + its schema-drift
// test). hourlyRate IS included here on purpose — it is the one numeric
// field the server intentionally does NOT strip (a per-record officer rate,
// same class as shift payRate) — so this test proves the component still
// doesn't turn it into a rendered currency value, not just that the sanitized
// API happens to omit money fields.
const PAYROLL_ROW = {
  id: "pe1",
  employeeId: "emp1",
  employeeName: "Jane Doe",
  siteId: "s1",
  siteName: "Downtown Tower",
  periodStart: "2026-08-03",
  periodEnd: "2026-08-09",
  totalHours: "38.50",
  hourlyRate: "22.00",
  status: "pending",
  paidAt: null,
  paidMethod: null,
  paymentReference: null,
  createdAt: "2026-08-10T12:00:00.000Z",
};

const INVOICE_ROW = {
  id: "inv1",
  invoiceNumber: "WCSG-1001",
  clientName: "Acme Corp",
  siteName: "Downtown Tower",
  periodStart: "2026-08-03",
  periodEnd: "2026-08-09",
  status: "draft",
  dueDate: "2026-08-20",
  paidAt: null,
  createdAt: "2026-08-10T12:00:00.000Z",
};

vi.mock("@/lib/api", () => ({
  api: vi.fn(async (path: string) => {
    const p = new URL(path, "http://test.local").pathname;
    if (p === "/payroll") { hoisted.payrollCalls.push(path); return [PAYROLL_ROW]; }
    if (p === "/invoices") { hoisted.invoiceCalls.push(path); return [INVOICE_ROW]; }
    return [];
  }),
  fetchWithAuth: vi.fn(),
  getToken: () => "tok",
}));

import PayrollBoard from "@/pages/PayrollBoard";
import InvoiceBoard from "@/pages/InvoiceBoard";

beforeEach(() => {
  hoisted.payrollCalls = [];
  hoisted.invoiceCalls = [];
});

describe("bookkeeper payroll list", () => {
  it("renders the record list for a non-owner holding finance.transactions", async () => {
    hoisted.user = { id: "u1", role: "dispatcher", isCompanyOwner: false, permissions: ["finance.transactions"] };
    render(<PayrollBoard />);

    expect(await screen.findByTestId("payroll-transaction-list")).toBeTruthy();
    expect(await screen.findByText("Jane Doe")).toBeTruthy();
    expect(screen.getByText("Downtown Tower")).toBeTruthy();
    expect(screen.getByText("38.50h")).toBeTruthy();
    expect(screen.queryByTestId("owner-locked-state")).toBeNull();
    // Aggregate board endpoint must not be called on this path.
    expect(hoisted.payrollCalls.every((p) => !p.includes("/board"))).toBe(true);
  });

  it("shows no company totals and no owner-only pay-run actions", async () => {
    hoisted.user = { id: "u1", role: "dispatcher", isCompanyOwner: false, permissions: ["finance.transactions"] };
    const { container } = render(<PayrollBoard />);
    await screen.findByTestId("payroll-transaction-list");

    expect(container.textContent).not.toMatch(/\$\s?\d/);
    expect(screen.queryByRole("button", { name: /process selected/i })).toBeNull();
  });

  it("gives a non-admin bookkeeper the narrower single-record detail link, never the admin grid", async () => {
    hoisted.user = { id: "u1", role: "dispatcher", isCompanyOwner: false, permissions: ["finance.transactions"] };
    render(<PayrollBoard />);

    const openLink = await screen.findByTestId("link-open-payroll-pe1");
    expect(openLink.getAttribute("href")).toBe("/payroll/pe1");
    expect(openLink.getAttribute("href")).not.toContain("/tables/payroll_entries");
  });

  it("gives an admin non-owner the admin-grid deep link instead", async () => {
    hoisted.user = { id: "u3", role: "admin", isCompanyOwner: false, permissions: ["finance.transactions"] };
    render(<PayrollBoard />);

    const openLink = await screen.findByTestId("link-open-payroll-pe1");
    expect(openLink.getAttribute("href")).toContain("/tables/payroll_entries?focus=pe1");
  });

  it("still locks the board for a non-owner without the permission", async () => {
    hoisted.user = { id: "u2", role: "dispatcher", isCompanyOwner: false, permissions: [] };
    render(<PayrollBoard />);

    expect(await screen.findByTestId("owner-locked-state")).toBeTruthy();
    expect(screen.queryByTestId("payroll-transaction-list")).toBeNull();
    await waitFor(() => expect(hoisted.payrollCalls).toEqual([]));
  });

  // Task #778: a site_manager granted finance.transactions via Settings ->
  // Permissions must reach the exact same sanitized list a dispatcher with
  // the same grant does — the board itself never role-gates, only
  // permission-gates (App.tsx's top-level router is what used to block it).
  it("renders the same sanitized list for a site_manager holding finance.transactions", async () => {
    hoisted.user = { id: "u4", role: "site_manager", isCompanyOwner: false, permissions: ["finance.transactions"] };
    render(<PayrollBoard />);

    expect(await screen.findByTestId("payroll-transaction-list")).toBeTruthy();
    expect(await screen.findByText("Jane Doe")).toBeTruthy();
    expect(screen.queryByTestId("owner-locked-state")).toBeNull();
    const openLink = await screen.findByTestId("link-open-payroll-pe1");
    expect(openLink.getAttribute("href")).toBe("/payroll/pe1");
  });
});

describe("bookkeeper invoice list", () => {
  it("renders the record list for a non-owner holding finance.transactions", async () => {
    hoisted.user = { id: "u1", role: "dispatcher", isCompanyOwner: false, permissions: ["finance.transactions"] };
    render(<InvoiceBoard />);

    expect(await screen.findByTestId("invoice-transaction-list")).toBeTruthy();
    expect(await screen.findByText("WCSG-1001")).toBeTruthy();
    expect(screen.getByText("Acme Corp")).toBeTruthy();
    expect(screen.queryByTestId("owner-locked-state")).toBeNull();
  });

  it("exposes no action that could return invoice totals or line items", async () => {
    hoisted.user = { id: "u1", role: "dispatcher", isCompanyOwner: false, permissions: ["finance.transactions"] };
    const { container } = render(<InvoiceBoard />);
    await screen.findByTestId("invoice-transaction-list");

    // The invoice PDF carries subtotal, tax, fees, total and every line item —
    // the exact detail this list is sanitized of. It must not be one click
    // away from a list that hands out every invoice id.
    expect(screen.queryByTestId("button-invoice-pdf-inv1")).toBeNull();
    expect(screen.queryByRole("button", { name: /pdf|download|export/i })).toBeNull();
    expect(screen.queryByRole("link", { name: /pdf|download|export/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /email to clients/i })).toBeNull();
    // The grid deep-link is admin-only (the grid API is requireAdmin); this
    // non-admin bookkeeper's Open link goes to the narrower single-record
    // detail page instead, never to the admin grid.
    const openLink = await screen.findByTestId("link-open-invoice-inv1");
    expect(openLink.getAttribute("href")).toBe("/invoices/inv1");
    expect(openLink.getAttribute("href")).not.toContain("/tables/invoices");
    // No money amount of any kind is rendered (the sanitized rows carry none).
    expect(container.textContent).not.toMatch(/\$\s?\d/);
  });

  it("gives an admin non-owner the record deep link", async () => {
    hoisted.user = { id: "u3", role: "admin", isCompanyOwner: false, permissions: ["finance.transactions"] };
    render(<InvoiceBoard />);

    const link = await screen.findByTestId("link-open-invoice-inv1");
    expect(link.getAttribute("href")).toContain("/tables/invoices?focus=inv1");
  });

  it("still locks the board for a non-owner without the permission", async () => {
    hoisted.user = { id: "u2", role: "dispatcher", isCompanyOwner: false, permissions: [] };
    render(<InvoiceBoard />);

    expect(await screen.findByTestId("owner-locked-state")).toBeTruthy();
    expect(screen.queryByTestId("invoice-transaction-list")).toBeNull();
    await waitFor(() => expect(hoisted.invoiceCalls).toEqual([]));
  });

  // Task #778: same invariant as the payroll list above — a site_manager
  // bookkeeper reaches the identical sanitized invoice list a dispatcher
  // bookkeeper does.
  it("renders the same sanitized list for a site_manager holding finance.transactions", async () => {
    hoisted.user = { id: "u4", role: "site_manager", isCompanyOwner: false, permissions: ["finance.transactions"] };
    render(<InvoiceBoard />);

    expect(await screen.findByTestId("invoice-transaction-list")).toBeTruthy();
    expect(await screen.findByText("WCSG-1001")).toBeTruthy();
    expect(screen.queryByTestId("owner-locked-state")).toBeNull();
    const openLink = await screen.findByTestId("link-open-invoice-inv1");
    expect(openLink.getAttribute("href")).toBe("/invoices/inv1");
  });
});
