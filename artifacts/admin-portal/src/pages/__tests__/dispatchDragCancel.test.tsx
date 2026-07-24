import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";

/**
 * Component-level regression for the dispatch grid column-boundary drop zone
 * cleanup on drag cancel.
 *
 * The boundary zone is governed by two separate state values:
 *   - dragSrcId (useState<PanelId | null>) — set in handlePanelDragStart, cleared
 *     in handlePanelDragEnd.  showBoundary = dragSrcId !== null && columns >= 2.
 *     Using state (not just a ref) ensures dragEnd always triggers a re-render and
 *     removes the element from the DOM, even when the other state variables
 *     (dragInsert, dragOverBoundary) happen to already be cleared.
 *   - dragOverBoundary (useState<boolean>) — controls the hover highlight / label
 *     shown while the cursor is physically over the zone.
 *
 * Covered:
 *   1. "Escape / release outside" cancel: dragend fires without a matching drop
 *      → dragSrcId becomes null → showBoundary = false → zone leaves the DOM.
 *   2. "Stale drag-over" cancel: cursor entered the boundary zone (dragover),
 *      then left (dragleave) without dropping → dragOverBoundary clears, zone
 *      returns to its idle label; a subsequent dragend removes the zone entirely.
 *
 * These paths were previously exercised only in pure-helper unit tests (which
 * test buildWithPlaceholder in isolation).  This file tests the full React
 * state path — setDragInsert, setDragOverBoundary, and dragSrcId — as wired
 * together inside DispatchPage.
 */

// ---------------------------------------------------------------------------
// Mocks — must be declared before the import of the page under test.
// ---------------------------------------------------------------------------

const EMPTY_STATUS_BOARD = {
  onDuty: [], late: [], noShow: [], earlyOut: [], completed: [], scheduled: [],
};

vi.mock("@/lib/api", () => ({
  api: vi.fn(async (path: string) => {
    // StatusBoardPanel accesses data.onDuty.length etc. directly — needs an
    // object, not an array.
    if (typeof path === "string" && path.includes("status-board")) {
      return EMPTY_STATUS_BOARD;
    }
    // Everything else (open-shifts, active-incidents, active-officers, sites,
    // broadcast-rooms, shift-claims, geofence-radius, …) is happy with [].
    return [];
  }),
  getToken: vi.fn(() => null),        // keeps useIncidentWs from opening a WS
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
        // Prevent background refetches from interfering with assertions.
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
 * Wait for at least two draggable panel wrappers to appear.  The dispatch grid
 * renders each visible panel inside a div with `draggable` so we can fire HTML
 * drag events on them.
 *
 * We target the wrappers that carry a `data-tour` attribute (every panel except
 * liveMap has one) so we can be certain we have two distinct panel wrappers.
 */
async function waitForDraggablePanels(): Promise<[HTMLElement, HTMLElement]> {
  return waitFor(() => {
    const panels = Array.from(
      document.querySelectorAll<HTMLElement>("[data-tour]"),
    ).filter((el) => el.getAttribute("draggable") === "true");
    if (panels.length < 2) {
      throw new Error(`Expected ≥2 draggable panels, found ${panels.length}`);
    }
    return [panels[0], panels[1]] as [HTMLElement, HTMLElement];
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("dispatch grid — column boundary drop zone on drag cancel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("boundary zone disappears from the DOM when dragend fires mid-flight (drag cancelled without dropping)", async () => {
    renderDispatch();

    const [src] = await waitForDraggablePanels();

    // Start drag — handlePanelDragStart calls setDragSrcId(id), which triggers
    // a re-render where showBoundary = true → boundary zone enters the DOM.
    fireEvent.dragStart(src);

    await waitFor(() => {
      expect(
        screen.getByTestId("column-boundary-drop-1"),
        "boundary zone should be in the DOM while a drag is active",
      ).toBeTruthy();
    });

    // Cancel the drag (Escape / release outside any drop target).
    // The browser fires dragend on the drag source; handlePanelDragEnd calls
    // setDragSrcId(null) which always triggers a re-render (the value goes from
    // a PanelId string to null), so showBoundary = false and the element is
    // removed from the DOM even if the other state variables were already cleared.
    fireEvent.dragEnd(src);

    await waitFor(() => {
      expect(
        screen.queryByTestId("column-boundary-drop-1"),
        "boundary zone must not remain in the DOM after drag is cancelled",
      ).toBeNull();
    });
  });

  it("dragOverBoundary state clears when the cursor leaves the zone without dropping (stale drag-over scenario)", async () => {
    renderDispatch();

    const [src] = await waitForDraggablePanels();

    // Establish an active drag — boundary zone appears immediately.
    fireEvent.dragStart(src);

    const boundary = await screen.findByTestId("column-boundary-drop-1");

    // Move the cursor into the boundary zone — handleBoundaryDragOver fires,
    // sets dragOverBoundary = true, and the label changes to the active form.
    fireEvent.dragOver(boundary);

    await waitFor(() => {
      expect(
        boundary.textContent,
        "boundary label should update to the active 'Move … here' text while hovering",
      ).toMatch(/Move ".+?" here/);
    });

    // The cursor leaves the boundary zone without dropping.
    // handleBoundaryDragLeave fires → setDragOverBoundary(false).
    fireEvent.dragLeave(boundary);

    await waitFor(() => {
      expect(
        boundary.textContent,
        "boundary label should revert to idle text after dragleave without a drop",
      ).toContain("Drop to move to right column");
    });

    // The zone itself remains in the DOM — the drag has not ended yet.
    expect(
      screen.queryByTestId("column-boundary-drop-1"),
      "boundary zone must stay in the DOM while the drag is still active",
    ).not.toBeNull();

    // Drag ends (cancel or release elsewhere).
    // Because setDragSrcId(null) is always a real state change (id → null),
    // this re-render always fires even though dragOverBoundary and dragInsert
    // were already cleared by the previous dragleave — the state bail-out that
    // used to cause the zone to linger no longer applies.
    fireEvent.dragEnd(src);

    await waitFor(() => {
      expect(
        screen.queryByTestId("column-boundary-drop-1"),
        "boundary zone must leave the DOM once dragend fires",
      ).toBeNull();
    });
  });
});
