import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";

/**
 * Regression coverage for the "alert link opens the right table row" deep-link
 * behavior. A push/alert deep link lands on `/tables/<table>?focus=<id>`; the
 * grid must:
 *   - jump to the page that actually contains the row (even page 3+),
 *   - scroll it into view and flash it (`wcsg-deep-link-flash`),
 *   - and stay a quiet no-op when the id doesn't exist or is already on page 1.
 *
 * This mounts the real TablePage -> DataGrid -> useDeepLinkFocus stack so the
 * URL-param parsing, the position-based page resolution, and the flash render
 * are all exercised together. The `@/lib/api` data source and the table
 * registry are the only things stubbed.
 */

const PAGE_SIZE = 25;

type FakeRow = { id: string; name: string };

const hoisted = vi.hoisted(() => ({
  rows: [] as { id: string; name: string }[],
  calls: [] as string[],
}));

vi.mock("@/lib/api", () => {
  // Mirror the real ApiError shape DataGrid inspects (`status` + `data.code`)
  // so the position fast-path's authoritative "row not in result set" 404 is
  // recognized as such.
  class ApiError extends Error {
    status: number;
    data: unknown;
    constructor(status: number, data?: unknown) {
      super("api error");
      this.status = status;
      this.data = data;
    }
  }
  return {
    // DataGrid + fk both call api(path) without the leading `/api` prefix.
    api: vi.fn(async (path: string) => {
      hoisted.calls.push(path);
      const url = new URL(path, "http://test.local");

      // Fast path: /admin/tables/<table>/<id>/position -> { index, page }.
      // Production uses this first to resolve a deep-linked row's page; only
      // falls back to a batch scan if it's unavailable.
      const posM = /\/admin\/tables\/([^/?]+)\/([^/?]+)\/position/.exec(
        url.pathname,
      );
      if (posM) {
        const [, table, id] = posM;
        if (table !== "widgets") {
          throw new ApiError(404, { code: "row_not_in_result_set" });
        }
        const index = hoisted.rows.findIndex((r) => r.id === id);
        if (index < 0) {
          throw new ApiError(404, { code: "row_not_in_result_set" });
        }
        const ps = Number(url.searchParams.get("pageSize") ?? String(PAGE_SIZE));
        return { index, page: Math.floor(index / ps) };
      }

      const m = /\/admin\/tables\/([^/?]+)/.exec(url.pathname);
      const table = m?.[1];
      if (table !== "widgets") return { rows: [], total: 0 };
      const limit = Number(url.searchParams.get("limit") ?? String(PAGE_SIZE));
      const offset = Number(url.searchParams.get("offset") ?? "0");
      return {
        rows: hoisted.rows.slice(offset, offset + limit),
        total: hoisted.rows.length,
      };
    }),
    getToken: () => null,
    ApiError,
  };
});

vi.mock("@/lib/tables", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tables")>();
  const descriptor = {
    name: "widgets",
    label: "Widgets",
    plural: "widgets",
    importSupported: false,
    primaryLabelField: "name",
    fields: [
      { key: "id", label: "ID", type: "text" },
      { key: "name", label: "Name", type: "text" },
    ],
  } as unknown as import("@/lib/tables").TableDescriptor;
  return {
    ...actual,
    TABLES: [descriptor],
    getTable: (name: string) => (name === "widgets" ? descriptor : undefined),
  };
});

// Imported after the mocks above so the mocked modules are picked up.
import { TablePage } from "@/pages/TablePage";

function makeRows(n: number): FakeRow[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `row-${i}`,
    name: `Widget ${i}`,
  }));
}

function renderTablePage(focusId: string) {
  const { hook, searchHook } = memoryLocation({
    path: "/tables/widgets",
    searchPath: `focus=${focusId}`,
    static: true,
  });
  return render(
    <Router hook={hook} searchHook={searchHook}>
      <TablePage />
    </Router>,
  );
}

function rowFor(name: string): HTMLTableRowElement {
  return screen.getByText(name).closest("tr") as HTMLTableRowElement;
}

describe("deep-link focus on a paginated admin table", () => {
  let scrollSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    hoisted.rows = [];
    hoisted.calls = [];
    vi.clearAllMocks();
    scrollSpy = vi.spyOn(Element.prototype, "scrollIntoView");
  });

  it("advances to the page that holds the row, then scrolls + flashes it", async () => {
    // 60 rows, page size 25 -> row-40 (index 40) lives on page index 1 = "Page 2".
    hoisted.rows = makeRows(60);
    renderTablePage("row-40");

    // Grid jumps to the page containing the target.
    // Under the full parallel `pnpm -r` workspace run, CPU contention can push
    // the DOM update past waitFor's 1 s default; align with the outer timeout.
    await waitFor(() => expect(screen.getByText("Widget 40")).toBeTruthy(), {
      timeout: DEEP_LINK_TEST_TIMEOUT_MS,
    });
    expect(screen.getByText("Page 2 of 3")).toBeTruthy();

    // The target row is flashed and scrolled into view.
    await waitFor(
      () => expect(rowFor("Widget 40").className).toContain("wcsg-deep-link-flash"),
      { timeout: DEEP_LINK_TEST_TIMEOUT_MS },
    );
    expect(scrollSpy).toHaveBeenCalled();

    // A row that wasn't the target is not flashed.
    expect(rowFor("Widget 39").className).not.toContain("wcsg-deep-link-flash");
  }, DEEP_LINK_TEST_TIMEOUT_MS);

  it("is a quiet no-op when the focus id doesn't exist", async () => {
    hoisted.rows = makeRows(60);
    renderTablePage("row-does-not-exist");

    // First page renders normally and the grid never leaves page 1.
    await waitFor(() => expect(screen.getByText("Widget 0")).toBeTruthy(), {
      timeout: DEEP_LINK_TEST_TIMEOUT_MS,
    });
    expect(screen.getByText("Page 1 of 3")).toBeTruthy();

    // The position lookup runs and authoritatively reports the row is absent,
    // so the grid stays on page 1 (no batch scan / no page jump).
    await waitFor(
      () =>
        expect(
          hoisted.calls.some((c) => c.includes("/row-does-not-exist/position")),
        ).toBe(true),
      { timeout: DEEP_LINK_TEST_TIMEOUT_MS },
    );
    expect(screen.getByText("Page 1 of 3")).toBeTruthy();

    // Nothing on the page is flashed.
    expect(document.querySelector(".wcsg-deep-link-flash")).toBeNull();
    expect(scrollSpy).not.toHaveBeenCalled();
  }, DEEP_LINK_TEST_TIMEOUT_MS);

  it("flashes in place without advancing when the row is already on page 1", async () => {
    hoisted.rows = makeRows(60);
    renderTablePage("row-3");

    await waitFor(
      () => expect(rowFor("Widget 3").className).toContain("wcsg-deep-link-flash"),
      { timeout: DEEP_LINK_TEST_TIMEOUT_MS },
    );
    expect(scrollSpy).toHaveBeenCalled();
    // The grid never advances past page 1 — the row was already there.
    expect(screen.getByText("Page 1 of 3")).toBeTruthy();
  }, DEEP_LINK_TEST_TIMEOUT_MS);
});

// Under the full parallel `pnpm -r` workspace run, CPU contention can push
// these tests past vitest's 5 s default per-test timeout even though they pass
// comfortably in isolation. A generous per-test timeout removes the flake
// without masking a real hang.
const DEEP_LINK_TEST_TIMEOUT_MS = 20000;

// This suite forces the responsive grid into its single-render mobile (card)
// branch, which renders a full page of cards on top of the deep-link page
// resolution. It is the heaviest test in the file and shares the same generous
// timeout used by the desktop suite above.
const MOBILE_CARD_TEST_TIMEOUT_MS = 20000;

describe("deep-link focus on the mobile card layout", () => {
  let scrollSpy: ReturnType<typeof vi.spyOn>;
  let originalInnerWidth: number;
  let originalMatchMedia: typeof window.matchMedia;

  beforeEach(() => {
    hoisted.rows = [];
    hoisted.calls = [];
    vi.clearAllMocks();
    scrollSpy = vi.spyOn(Element.prototype, "scrollIntoView");

    // Force the responsive grid into its single-render mobile (card) branch:
    // useIsMobile() seeds from innerWidth and then subscribes via matchMedia.
    originalInnerWidth = window.innerWidth;
    originalMatchMedia = window.matchMedia;
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      writable: true,
      value: 375,
    });
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: true,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })) as unknown as typeof window.matchMedia;
  });

  afterEach(() => {
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      writable: true,
      value: originalInnerWidth,
    });
    window.matchMedia = originalMatchMedia;
  });

  it("renders rows as cards and still scrolls + flashes the focused row", async () => {
    // 60 rows, page size 25 -> row-40 lives on page index 1 = "Page 2".
    hoisted.rows = makeRows(60);
    renderTablePage("row-40");

    await waitFor(() => expect(screen.getByText("Widget 40")).toBeTruthy(), {
      timeout: MOBILE_CARD_TEST_TIMEOUT_MS,
    });

    // Mobile branch renders cards, not a <table>.
    expect(document.querySelector("table")).toBeNull();

    // The focused card (a div, not a tr) is scrolled into view and flashed.
    await waitFor(
      () => {
        const flashed = document.querySelector(".wcsg-deep-link-flash");
        expect(flashed).not.toBeNull();
        expect(flashed?.tagName).toBe("DIV");
        expect(flashed?.textContent).toContain("Widget 40");
      },
      { timeout: MOBILE_CARD_TEST_TIMEOUT_MS },
    );
    expect(scrollSpy).toHaveBeenCalled();
  }, MOBILE_CARD_TEST_TIMEOUT_MS);
});
