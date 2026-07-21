import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";

/**
 * Coverage for the single-payment "Re-check now" flow on the Pay Run page.
 *
 * The PNC raw-response modal has a "Re-check now" button that re-fetches ONE
 * customerReference and updates its inline badge plus the open modal in place.
 * Covered here:
 *   - success: exactly one request for that reference; badge label/style and
 *     modal JSON update in place,
 *   - HTTP error: badge flips to the error ("PNC: Unavailable") style,
 *   - network failure: same error badge, and the modal shows the message,
 *   - double-click guard: a second click while a re-check is in flight fires
 *     no second request.
 *
 * The real PayRunPage is mounted; only `@/lib/api` is stubbed.
 */

type Deferred = {
  resolve: (r: { ok: boolean; status: number; body: unknown }) => void;
  reject: (e: Error) => void;
};

const hoisted = vi.hoisted(() => ({
  // Every fetchWithAuth URL, in order.
  calls: [] as string[],
  // Response bodies for the initial batch pnc-status fetch, keyed by ref.
  initialStatus: {} as Record<string, unknown>,
  // When set, the NEXT pnc-status request for this ref is left pending and its
  // controls are pushed here so the test can settle it manually.
  deferNextStatus: false,
  deferred: [] as Deferred[],
}));

vi.mock("@/lib/api", () => ({
  fetchWithAuth: vi.fn(async (url: string) => {
    hoisted.calls.push(url);
    const mk = (body: unknown, ok = true, status = 200) => ({
      ok,
      status,
      json: async () => body,
    });
    if (url.startsWith("/api/admin/system/status")) {
      return mk({ pncConfigured: true });
    }
    if (url.startsWith("/api/payroll/pay-run/pnc-status")) {
      const ref = new URL(url, "http://test.local").searchParams.get("customerReference") ?? "";
      if (hoisted.deferNextStatus) {
        return new Promise((resolve, reject) => {
          hoisted.deferred.push({
            resolve: ({ ok, status, body }) => resolve(mk(body, ok, status)),
            reject,
          });
        });
      }
      return mk(hoisted.initialStatus[ref] ?? { paymentStatus: "PENDING" });
    }
    if (url.startsWith("/api/payroll")) {
      return mk([
        {
          id: "pr-1",
          employeeId: "emp-1",
          employeeName: "Alice Officer",
          siteId: "site-1",
          siteName: "Main Gate",
          periodStart: "2026-07-13",
          periodEnd: "2026-07-19",
          totalHours: "40",
          hourlyRate: "20",
          grossPay: "800",
          tax: "0",
          netPay: "800",
          status: "processed",
          paidAt: null,
          paidMethod: "pnc_api",
          paymentReference: "REF-1",
        },
      ]);
    }
    return mk({});
  }),
}));

import PayRunPage from "@/pages/PayRun";

const STATUS_URL = "/api/payroll/pay-run/pnc-status?customerReference=REF-1";

const statusCalls = () => hoisted.calls.filter((c) => c === STATUS_URL);

/** Render the page, wait for the initial pending badge, and open the modal. */
async function renderAndOpenModal() {
  render(<PayRunPage />);
  const badge = await screen.findByRole("button", {
    name: /PNC: Pending — view full PNC response/,
  });
  fireEvent.click(badge);
  const modal = await screen.findByRole("dialog", { name: "PNC Payment Status" });
  return { modal };
}

function recheckButton(modal: HTMLElement) {
  return within(modal).getByRole("button", {
    name: "Re-check this payment's PNC status now",
  });
}

beforeEach(() => {
  hoisted.calls = [];
  hoisted.initialStatus = { "REF-1": { paymentStatus: "PENDING" } };
  hoisted.deferNextStatus = false;
  hoisted.deferred = [];
  vi.clearAllMocks();
  window.history.replaceState(null, "", "/payroll/pay-run");
});

describe("Pay Run — single-payment PNC re-check", () => {
  it("re-checks exactly one reference and updates the badge + modal in place on success", async () => {
    const { modal } = await renderAndOpenModal();
    // Modal shows the cached raw payload from the batch fetch.
    expect(within(modal).getByText(/"paymentStatus": "PENDING"/)).toBeTruthy();

    const callsBefore = statusCalls().length;
    hoisted.deferNextStatus = true;
    fireEvent.click(recheckButton(modal));

    // In-flight state: button shows Checking… and exactly one new request.
    await within(modal).findByText("Checking…");
    expect(statusCalls().length).toBe(callsBefore + 1);
    // Only REF-1 was fetched — no other reference and no full-batch refetch.
    expect(
      hoisted.calls.filter((c) => c.includes("pnc-status") && c !== STATUS_URL),
    ).toEqual([]);

    hoisted.deferNextStatus = false;
    hoisted.deferred[0].resolve({
      ok: true,
      status: 200,
      body: { paymentStatus: "SETTLED", settledAt: "2026-07-21" },
    });

    // Badge updates in place to the settled label + green style.
    const settledBadge = await screen.findByRole("button", {
      name: /PNC: Settled — view full PNC response/,
    });
    expect(settledBadge.className).toContain("bg-green-100");
    // Old pending badge is gone.
    expect(
      screen.queryByRole("button", { name: /PNC: Pending — view full PNC response/ }),
    ).toBeNull();

    // The still-open modal's raw JSON updated in place too.
    expect(within(modal).getByText(/"paymentStatus": "SETTLED"/)).toBeTruthy();
    expect(within(modal).getByText(/"settledAt": "2026-07-21"/)).toBeTruthy();
    expect(within(modal).queryByText(/"paymentStatus": "PENDING"/)).toBeNull();
    // Button returns to its idle label.
    expect(within(modal).getByText("Re-check now")).toBeTruthy();
  });

  it("flips the badge to the error style on an HTTP error response", async () => {
    const { modal } = await renderAndOpenModal();

    hoisted.deferNextStatus = true;
    fireEvent.click(recheckButton(modal));
    await within(modal).findByText("Checking…");
    hoisted.deferNextStatus = false;
    hoisted.deferred[0].resolve({
      ok: false,
      status: 502,
      body: { message: "upstream unavailable" },
    });

    const errorBadge = await screen.findByRole("button", {
      name: /PNC: Unavailable — view full PNC response/,
    });
    expect(errorBadge.className).toContain("text-gray-500");
    // The modal shows the error payload returned by the server.
    expect(within(modal).getByText(/"message": "upstream unavailable"/)).toBeTruthy();
  });

  it("flips the badge to the error style on a network failure", async () => {
    const { modal } = await renderAndOpenModal();

    hoisted.deferNextStatus = true;
    fireEvent.click(recheckButton(modal));
    await within(modal).findByText("Checking…");
    hoisted.deferNextStatus = false;
    hoisted.deferred[0].reject(new Error("connection reset"));

    const errorBadge = await screen.findByRole("button", {
      name: /PNC: Unavailable — view full PNC response/,
    });
    expect(errorBadge.className).toContain("text-gray-500");
    // The synthesized { message } payload lands in the modal.
    expect(within(modal).getByText(/"message": "connection reset"/)).toBeTruthy();
  });

  it("ignores a second click while a re-check is already in flight", async () => {
    const { modal } = await renderAndOpenModal();
    const callsBefore = statusCalls().length;

    hoisted.deferNextStatus = true;
    const btn = recheckButton(modal);
    fireEvent.click(btn);
    await within(modal).findByText("Checking…");

    // Second (and third) click while in flight: the button is disabled and the
    // recheckPncStatus in-flight guard drops the call — no extra request.
    expect((btn as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(btn);
    fireEvent.click(btn);
    expect(statusCalls().length).toBe(callsBefore + 1);

    hoisted.deferNextStatus = false;
    hoisted.deferred[0].resolve({
      ok: true,
      status: 200,
      body: { paymentStatus: "ACCEPTED" },
    });
    await screen.findByRole("button", {
      name: /PNC: Accepted — view full PNC response/,
    });
    // Still only the single re-check request in total.
    expect(statusCalls().length).toBe(callsBefore + 1);
    // And the guard cleared: the button is usable again.
    await waitFor(() => expect((btn as HTMLButtonElement).disabled).toBe(false));
  });
});
