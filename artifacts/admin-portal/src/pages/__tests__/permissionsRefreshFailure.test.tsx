/**
 * The permission matrix must never hide a save that failed.
 *
 * Same defect class as the Legal & Agreements upload report: the page drew
 * "couldn't read the matrix", "still loading" and "these are the roles" the
 * same way, so a successful toggle whose confirming refresh failed reverted
 * the checkbox, and an unreachable API rendered a hard-coded default role list
 * as if it were the stored configuration.
 *
 * Contract pinned here (see `.agents/memory/unknown-vs-empty-ui-state.md`):
 *   - the PATCH reply is authoritative even if the follow-up read fails;
 *   - a failed read is labelled with a retry, never drawn as defaults;
 *   - the outcome is reported on the permission row that produced it.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  api: vi.fn(),
}));

import { api, ApiError } from "@/lib/api";
import PermissionsPage from "@/pages/Permissions";

const apiMock = vi.mocked(api);

type Init = { method?: string; body?: unknown } | undefined;

const PERM = {
  key: "shifts.create",
  label: "Create shifts",
  description: "Add a shift to the schedule.",
  area: "Scheduling",
  allowedRoles: ["admin"],
  defaultAllowedRoles: ["admin"],
  isOverridden: false,
};

const MATRIX = {
  permissions: [PERM],
  assignableRoles: ["admin", "dispatcher", "employee", "site_manager"],
};

function mockPage(opts: {
  matrix: () => Promise<unknown>;
  onPatch?: (key: string, body: unknown) => Promise<unknown>;
}) {
  apiMock.mockImplementation((async (path: string, init: Init) => {
    const method = (init?.method ?? "GET").toUpperCase();
    if (method === "GET" && path === "/admin/permissions") return opts.matrix();
    if (method === "PATCH" && path.startsWith("/admin/permissions/")) {
      const key = path.split("/").pop() as string;
      if (!opts.onPatch) throw new Error("unexpected PATCH");
      return opts.onPatch(key, init?.body);
    }
    throw new Error(`unexpected ${method} ${path}`);
  }) as unknown as typeof api);
}

/** Supplier that answers once from `first`, then fails every later read. */
function thenFails(first: unknown) {
  let served = false;
  return async () => {
    if (served) throw new Error("Failed to fetch");
    served = true;
    return first;
  };
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <PermissionsPage />
    </QueryClientProvider>,
  );
}

/** The card row for the one permission under test. */
function permRow(): HTMLElement {
  return screen.getByText("Create shifts").closest("div.border.rounded-lg") as HTMLElement;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("Permission matrix save reporting", () => {
  it("keeps the saved roles when the confirming refresh fails", async () => {
    mockPage({
      matrix: thenFails(MATRIX),
      onPatch: async (key, body) => {
        expect(key).toBe("shifts.create");
        expect(body).toEqual({ allowedRoles: ["admin", "dispatcher"] });
        return {
          permission: { ...PERM, allowedRoles: ["admin", "dispatcher"], isOverridden: true },
        };
      },
    });
    renderPage();

    const dispatcher = await screen.findByTestId("checkbox-shifts.create-dispatcher");
    expect(dispatcher.getAttribute("data-state")).toBe("unchecked");

    fireEvent.click(dispatcher);

    // The PATCH reply is authoritative: the failed re-read must not untick the
    // box that the server confirmed it stored.
    expect(await within(permRow()).findByText(/Saved — this page couldn't re-read/i)).toBeTruthy();
    await waitFor(() =>
      expect(
        screen.getByTestId("checkbox-shifts.create-dispatcher").getAttribute("data-state"),
      ).toBe("checked"),
    );
  });

  it("reports a refused change on the row and undoes the tick", async () => {
    mockPage({
      matrix: async () => MATRIX,
      onPatch: async () => {
        throw new ApiError(403, "Not allowed to change this permission.");
      },
    });
    renderPage();

    const dispatcher = await screen.findByTestId("checkbox-shifts.create-dispatcher");
    fireEvent.click(dispatcher);

    const row = permRow();
    expect(
      await within(row).findByText(/Not saved — Not allowed to change this permission\./i),
    ).toBeTruthy();
    await waitFor(() =>
      expect(
        screen.getByTestId("checkbox-shifts.create-dispatcher").getAttribute("data-state"),
      ).toBe("unchecked"),
    );
  });

  it("claims neither outcome when the write gets no clean answer", async () => {
    let reads = 0;
    mockPage({
      matrix: async () => {
        reads += 1;
        return MATRIX; // still the pre-change value
      },
      onPatch: async () => {
        throw new ApiError(503, "The server is temporarily unreachable.");
      },
    });
    renderPage();

    fireEvent.click(await screen.findByTestId("checkbox-shifts.create-dispatcher"));

    expect(await within(permRow()).findByText(/Couldn't confirm the change/i)).toBeTruthy();
    expect(reads).toBeGreaterThan(1); // it re-read rather than guessing
    // …and the boxes were resynced to what is actually stored.
    await waitFor(() =>
      expect(
        screen.getByTestId("checkbox-shifts.create-dispatcher").getAttribute("data-state"),
      ).toBe("unchecked"),
    );
  });

  it("labels an unreadable matrix instead of drawing a default role list", async () => {
    mockPage({
      matrix: async () => {
        throw new Error("Failed to fetch");
      },
    });
    renderPage();

    await waitFor(() =>
      expect(screen.getByText(/Couldn't load the permission settings/i)).toBeTruthy(),
    );
    expect(screen.getByRole("button", { name: /try again/i })).toBeTruthy();
    expect(screen.queryByText("Dispatcher")).toBeNull();
  });
});
