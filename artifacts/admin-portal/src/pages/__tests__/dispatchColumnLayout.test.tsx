import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import { LEFT_PANELS, RIGHT_PANELS } from "../dispatchLayout";

/**
 * Render-level integration test: verifies that the DispatchPage assigns each
 * panel to the correct column container via `data-column` attribute, driven
 * by the shared LEFT_PANELS / RIGHT_PANELS exports from dispatchLayout.ts.
 *
 * Why this matters: the pure unit tests in dispatchLayout.test.ts confirm that
 * LEFT_PANELS / RIGHT_PANELS contain the right IDs, but they cannot catch a
 * developer wiring the page to a hardcoded local list instead of those exports.
 * This test renders the real DispatchPage and asserts the `data-column`
 * attribute on every panel wrapper, closing that gap.
 *
 * How it works:
 *   - Each panel wrapper in Dispatch.tsx carries `data-panel-id` (the PanelId)
 *     and `data-column` (set to "left" or "right" via LEFT_PANELS.includes(id)).
 *   - The test reads those attributes and asserts:
 *       1. Every panel whose id is in LEFT_PANELS has data-column="left".
 *       2. Every panel whose id is in RIGHT_PANELS has data-column="right".
 *       3. All six panels are present (none silently dropped).
 *
 * A developer who swaps LEFT_PANELS.includes() for a hardcoded local list
 * with wrong membership will cause assertions 1 or 2 to fail; one who drops a
 * panel entirely will fail assertion 3.
 */

// ---------------------------------------------------------------------------
// Mocks — declared before the page import so vitest hoisting resolves them.
// ---------------------------------------------------------------------------

const EMPTY_STATUS_BOARD = {
  onDuty: [], late: [], noShow: [], earlyOut: [], completed: [], scheduled: [],
};

vi.mock("@/lib/api", () => ({
  api: vi.fn(async (path: string) => {
    if (typeof path === "string" && path.includes("status-board")) {
      return EMPTY_STATUS_BOARD;
    }
    return [];
  }),
  getToken: vi.fn(() => null),
  fetchWithAuth: vi.fn(async () => ({ ok: true, status: 200, json: async () => [] })),
  setToken: vi.fn(),
  setUnauthorizedHandler: vi.fn(),
  ApiError: class ApiError extends Error {
    status: number;
    constructor(status: number) { super("api error"); this.status = status; }
  },
}));

vi.mock("@/lib/auth", () => ({
  useAuth: vi.fn(() => ({
    user: {
      id: "u-col-test",
      email: "admin@example.com",
      firstName: "Admin",
      lastName: "User",
      role: "admin",
    },
    loading: false,
    login: vi.fn(),
    loginTotp: vi.fn(),
    logout: vi.fn(),
    applySession: vi.fn(),
  })),
  AuthProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import DispatchPage from "@/pages/Dispatch";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeQc() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        refetchInterval: false,
        staleTime: Infinity,
      },
    },
  });
}

function renderDispatch() {
  const { hook, searchHook } = memoryLocation({
    path: "/dispatch",
    static: true,
  });
  return render(
    <QueryClientProvider client={makeQc()}>
      <Router hook={hook} searchHook={searchHook}>
        <DispatchPage />
      </Router>
    </QueryClientProvider>,
  );
}

/**
 * Wait until all seven panels have been mounted.
 * Returns an array of { panelId, column } objects extracted from
 * [data-panel-id] / [data-column] attributes in DOM order.
 */
async function waitForAllPanels(): Promise<{ panelId: string; column: string | null }[]> {
  return waitFor(() => {
    const els = Array.from(
      document.querySelectorAll<HTMLElement>("[data-panel-id]"),
    );
    if (els.length < 7) {
      throw new Error(`Expected 7 panel wrappers, found ${els.length}`);
    }
    return els.map((el) => ({
      panelId: el.getAttribute("data-panel-id") ?? "",
      column: el.getAttribute("data-column"),
    }));
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("dispatch page — column panel placement", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Clear any stored layout so the default order is always used.
    const keysToRemove: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith("wcsg.dispatch.")) keysToRemove.push(k);
    }
    keysToRemove.forEach((k) => localStorage.removeItem(k));
  });

  it("renders all seven panels in the DOM under the default layout", async () => {
    renderDispatch();
    const panels = await waitForAllPanels();
    expect(panels).toHaveLength(7);
  });

  it("every LEFT_PANELS id is rendered with data-column=\"left\"", async () => {
    renderDispatch();
    const panels = await waitForAllPanels();
    const byId = Object.fromEntries(panels.map(({ panelId, column }) => [panelId, column]));

    for (const id of LEFT_PANELS) {
      expect(
        byId[id],
        `Panel "${id}" is in LEFT_PANELS but its data-column is "${byId[id]}" — ` +
          `Dispatch.tsx must import LEFT_PANELS and use it to set data-column`,
      ).toBe("left");
    }
  });

  it("every RIGHT_PANELS id is rendered with data-column=\"right\"", async () => {
    renderDispatch();
    const panels = await waitForAllPanels();
    const byId = Object.fromEntries(panels.map(({ panelId, column }) => [panelId, column]));

    for (const id of RIGHT_PANELS) {
      expect(
        byId[id],
        `Panel "${id}" is in RIGHT_PANELS but its data-column is "${byId[id]}" — ` +
          `Dispatch.tsx must import RIGHT_PANELS (or its complement) and use it to set data-column`,
      ).toBe("right");
    }
  });

  it("every rendered panel has a data-column of exactly \"left\" or \"right\"", async () => {
    renderDispatch();
    const panels = await waitForAllPanels();

    for (const { panelId, column } of panels) {
      expect(
        column === "left" || column === "right",
        `Panel "${panelId}" has unexpected data-column="${column}" — ` +
          `all panels must belong to either the left or right column`,
      ).toBe(true);
    }
  });
});
