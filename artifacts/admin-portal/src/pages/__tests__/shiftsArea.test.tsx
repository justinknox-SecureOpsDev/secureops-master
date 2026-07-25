import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Router, useLocation, useSearch } from "wouter";
import { memoryLocation } from "wouter/memory-location";

/**
 * End-to-end coverage for the unified Shifts area (`/shifts`). Verifies the
 * URL-driven view toggle, the deep-link (?focus=) landing default, the legacy
 * route redirects, and the pending-claims approve/decline flow.
 *
 * The heavy child views (calendar / list / detail panel / dialogs) are stubbed
 * to lightweight markers so the test exercises ShiftsAreaPage's own routing,
 * view selection, and claim-decision logic — not the grids' internals. Only
 * `@/lib/api` is mocked as the data source.
 */

const hoisted = vi.hoisted(() => ({
  claims: [] as Array<{
    id: string;
    title: string;
    startTime: string;
    endTime: string;
    clientName: string | null;
    location: string | null;
    requiredLicenseLevel: number;
    assignments: Array<{ id: string; status: string; employeeName: string | null }>;
  }>,
  putCalls: [] as Array<{ path: string; body: unknown }>,
  putShouldFail: false,
}));

vi.mock("@/lib/api", () => ({
  api: vi.fn(async (path: string, opts?: { method?: string; body?: unknown }) => {
    if (opts?.method === "PUT") {
      hoisted.putCalls.push({ path, body: opts.body });
      if (hoisted.putShouldFail) throw new Error("Claim update rejected");
      return {};
    }
    if (path === "/sites") return [];
    if (path.startsWith("/shifts?status=upcoming")) return hoisted.claims;
    if (path === "/shifts") return [];
    if (path.startsWith("/shifts/")) {
      return {
        id: "shift-focus",
        title: "Focused shift",
        startTime: "2026-08-01T09:00:00.000Z",
        endTime: "2026-08-01T17:00:00.000Z",
        assignments: [],
      };
    }
    return [];
  }),
  getToken: () => null,
}));

// Stub the heavy child views/dialogs with markers that surface their props.
vi.mock("@/components/shifts/ShiftsCalendarView", () => ({
  ShiftsCalendarView: () => <div data-testid="calendar-view">calendar</div>,
}));
vi.mock("@/components/shifts/ShiftsListView", () => ({
  ShiftsListView: (props: { focusShiftId: string | null }) => (
    <div data-testid="list-view">list:{props.focusShiftId ?? "none"}</div>
  ),
}));
vi.mock("@/components/shifts/ShiftDetailPanel", () => ({
  ShiftDetailPanel: () => null,
}));
vi.mock("@/components/ShiftDialog", () => ({ ShiftDialog: () => null }));
vi.mock("@/components/RepeatingShiftDialog", () => ({ RepeatingShiftDialog: () => null }));
vi.mock("@/components/BulkEditSeriesDialog", () => ({ BulkEditSeriesDialog: () => null }));

import ShiftsAreaPage, {} from "@/pages/ShiftsArea";
import { LegacyShiftsRedirect } from "@/App";

function renderShifts(searchPath = "") {
  const { hook, searchHook } = memoryLocation({
    path: "/shifts",
    searchPath,
  });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const utils = render(
    <QueryClientProvider client={qc}>
      <Router hook={hook} searchHook={searchHook}>
        <ShiftsAreaPage />
      </Router>
    </QueryClientProvider>,
  );
  return utils;
}

beforeEach(() => {
  hoisted.claims = [];
  hoisted.putCalls = [];
  hoisted.putShouldFail = false;
  // localStorage/sessionStorage are reset globally in vitest.setup.ts before
  // each test, so persisted view/filter state can't leak between tests here.
  vi.clearAllMocks();
});

describe("ShiftsArea view selection", () => {
  it("defaults to the calendar view with no query params", async () => {
    renderShifts("");
    await waitFor(() => expect(screen.getByTestId("calendar-view")).toBeTruthy());
    expect(screen.queryByTestId("list-view")).toBeNull();
  });

  it("renders the list view when ?view=list", async () => {
    renderShifts("view=list");
    await waitFor(() => expect(screen.getByTestId("list-view")).toBeTruthy());
    expect(screen.queryByTestId("calendar-view")).toBeNull();
  });

  it("lands on the list view for a ?focus= deep link without an explicit view", async () => {
    renderShifts("focus=shift-focus");
    await waitFor(() => expect(screen.getByTestId("list-view")).toBeTruthy());
    expect(screen.getByTestId("list-view").textContent).toContain("shift-focus");
    expect(screen.queryByTestId("calendar-view")).toBeNull();
  });

  it("keeps the calendar view when ?focus= arrives with an explicit view=calendar", async () => {
    renderShifts("view=calendar&focus=shift-focus");
    await waitFor(() => expect(screen.getByTestId("calendar-view")).toBeTruthy());
    expect(screen.queryByTestId("list-view")).toBeNull();
  });

  it("toggles from calendar to list via the view tabs", async () => {
    renderShifts("");
    await waitFor(() => expect(screen.getByTestId("calendar-view")).toBeTruthy());
    fireEvent.click(screen.getByRole("tab", { name: /list/i }));
    await waitFor(() => expect(screen.getByTestId("list-view")).toBeTruthy());
  });
});

function LocationProbe() {
  const [loc] = useLocation();
  const search = useSearch();
  return <div data-testid="loc">{loc}{search ? `?${search}` : ""}</div>;
}

describe("LegacyShiftsRedirect", () => {
  it("redirects to /shifts preserving the query string", async () => {
    const { hook, searchHook } = memoryLocation({
      path: "/shifts/calendar",
      searchPath: "focus=abc&view=list",
    });
    // The component reads window.location.search directly (not wouter's search).
    const original = window.location.search;
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...window.location, search: "?focus=abc&view=list" },
    });
    try {
      render(
        <Router hook={hook} searchHook={searchHook}>
          <LegacyShiftsRedirect />
          <LocationProbe />
        </Router>,
      );
      await waitFor(() =>
        expect(screen.getByTestId("loc").textContent).toBe(
          "/shifts?focus=abc&view=list",
        ),
      );
    } finally {
      Object.defineProperty(window, "location", {
        configurable: true,
        value: { ...window.location, search: original },
      });
    }
  });
});

describe("ShiftsArea pending claims", () => {
  function seedOneClaim() {
    hoisted.claims = [
      {
        id: "shift-1",
        title: "Night patrol",
        startTime: "2026-08-01T22:00:00.000Z",
        endTime: "2026-08-02T06:00:00.000Z",
        clientName: "Acme Corp",
        location: "Downtown",
        requiredLicenseLevel: 2,
        assignments: [
          { id: "assign-1", status: "pending_approval", employeeName: "Jane Officer" },
        ],
      },
    ];
  }

  it("shows a pending claim and approves it via a PUT with status accepted", async () => {
    seedOneClaim();
    renderShifts("");
    await waitFor(() => expect(screen.getByText(/awaiting approval/i)).toBeTruthy());
    expect(screen.getByText("Jane Officer")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /approve/i }));

    await waitFor(() => expect(hoisted.putCalls.length).toBe(1));
    expect(hoisted.putCalls[0].path).toBe("/shifts/shift-1/assignments/assign-1");
    expect(hoisted.putCalls[0].body).toEqual({ status: "accepted" });
    await waitFor(() =>
      expect(screen.getByText(/claim approved/i)).toBeTruthy(),
    );
  });

  it("declines a claim via a PUT with status declined", async () => {
    seedOneClaim();
    renderShifts("");
    await waitFor(() => expect(screen.getByText(/awaiting approval/i)).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: /decline/i }));

    await waitFor(() => expect(hoisted.putCalls.length).toBe(1));
    expect(hoisted.putCalls[0].body).toEqual({ status: "declined" });
    await waitFor(() =>
      expect(screen.getByText(/slot is open again/i)).toBeTruthy(),
    );
  });

  it("surfaces an error toast when the claim decision fails", async () => {
    seedOneClaim();
    hoisted.putShouldFail = true;
    renderShifts("");
    await waitFor(() => expect(screen.getByText(/awaiting approval/i)).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: /approve/i }));

    await waitFor(() =>
      expect(screen.getByText(/Claim update rejected/i)).toBeTruthy(),
    );
  });

  it("shows no claims banner when there are no pending claims", async () => {
    hoisted.claims = [];
    renderShifts("");
    await waitFor(() => expect(screen.getByTestId("calendar-view")).toBeTruthy());
    expect(screen.queryByText(/awaiting approval/i)).toBeNull();
  });
});
