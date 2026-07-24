import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";

/**
 * Component-level tests for the dispatch free-form panel layout.
 *
 * Covered:
 *   1. All 6 panels render with at least one move handle and one resize handle.
 *   2. Pointer-based move: pointerdown on the move handle, pointermove on
 *      window → the panel element's inline style.left and style.top update.
 *   3. Pointer-based resize (right edge): pointerdown on resize handle,
 *      pointermove on window → panel element's inline style.width updates.
 */

// ---------------------------------------------------------------------------
// Mocks — must be declared before the import of the page under test.
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
      id: "u1",
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

// Imported after the mocks so the mocked modules are resolved first.
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

/** Wait until at least one panel move handle is in the DOM. */
async function waitForMoveHandles() {
  return waitFor(() => {
    const handles = screen.getAllByTestId("panel-move-handle");
    if (handles.length === 0) throw new Error("No move handles found");
    return handles;
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("dispatch free-form layout — panel handles", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it("renders a move handle and at least one resize handle for each visible panel", async () => {
    renderDispatch();

    const moveHandles = await waitForMoveHandles();
    expect(moveHandles.length).toBeGreaterThanOrEqual(6);

    const resizeHandles = screen.getAllByTestId("panel-resize-handle");
    expect(resizeHandles.length).toBeGreaterThanOrEqual(6);
  });

  it("panels carry data-panel-id and data-column attributes", async () => {
    renderDispatch();

    await waitForMoveHandles();

    const panelWrappers = document.querySelectorAll("[data-panel-id]");
    expect(panelWrappers.length).toBeGreaterThanOrEqual(6);

    for (const el of Array.from(panelWrappers)) {
      expect(["left", "right"]).toContain(el.getAttribute("data-column"));
    }
  });
});

describe("dispatch free-form layout — pointer move", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it("pointermove on window after pointerdown on move handle translates the panel element", async () => {
    renderDispatch();

    const [moveHandle] = await waitForMoveHandles();

    // The panel wrapper is the ancestor with data-panel-id.
    const panelWrapper = moveHandle.closest("[data-panel-id]") as HTMLElement;
    expect(panelWrapper).toBeTruthy();

    // Simulate grabbing the handle at (200, 300).
    fireEvent.pointerDown(moveHandle, { clientX: 200, clientY: 300, pointerId: 1 });

    // Move 50 px right, 80 px down.
    fireEvent(
      window,
      new PointerEvent("pointermove", { clientX: 250, clientY: 380, bubbles: true }),
    );

    // The panel style.left / style.top should reflect the delta.
    await waitFor(() => {
      const left = parseFloat(panelWrapper.style.left);
      const top = parseFloat(panelWrapper.style.top);
      // DEFAULT_GEOMETRY for "incidents" has x=0, y=0, so after +50/+80 delta:
      // left ≥ 50, top ≥ 80 (or the panel's stored x+50, y+80).
      expect(left).toBeGreaterThan(0);
      expect(top).toBeGreaterThan(0);
    });

    // Release pointer — should not throw.
    fireEvent(
      window,
      new PointerEvent("pointerup", { bubbles: true }),
    );
  });

  it("pointermove after resize handle pointerdown adjusts the panel width", async () => {
    renderDispatch();

    await waitForMoveHandles();

    const [resizeHandle] = screen.getAllByTestId("panel-resize-handle");
    const panelWrapper = resizeHandle.closest("[data-panel-id]") as HTMLElement;
    expect(panelWrapper).toBeTruthy();

    const origWidth = parseFloat(panelWrapper.style.width) || 690;

    fireEvent.pointerDown(resizeHandle, { clientX: 100, clientY: 100, pointerId: 2 });

    // Drag 60 px to the right.
    fireEvent(
      window,
      new PointerEvent("pointermove", { clientX: 160, clientY: 100, bubbles: true }),
    );

    await waitFor(() => {
      const newWidth = parseFloat(panelWrapper.style.width);
      expect(newWidth).toBeGreaterThan(origWidth);
    });

    fireEvent(window, new PointerEvent("pointerup", { bubbles: true }));
  });
});
