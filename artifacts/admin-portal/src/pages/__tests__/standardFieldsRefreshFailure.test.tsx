/**
 * The application form builder's Standard fields manager must never make a
 * saved intake-field edit look undone.
 *
 * Same defect class as the permission-matrix and platform-settings fixes:
 * `saveEdit()`/`toggleHidden()` used to discard the PATCH reply and rely
 * entirely on a confirming `load()` re-fetch to update the UI — so a
 * successful save whose confirming reload failed kept showing the
 * pre-edit value, with only an error banner as evidence anything happened.
 *
 * Contract pinned here (see `.agents/memory/unknown-vs-empty-ui-state.md`):
 *   - the PATCH reply is authoritative even if the follow-up read fails;
 *   - a failed confirming reload is reported on the field row that produced
 *     it, without reverting the value the server just confirmed it stored;
 *   - a refused write (4xx) is reported as not saved; an unclear outcome
 *     (5xx / no answer) triggers a re-read instead of guessing.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  api: vi.fn(),
}));

import { api, ApiError } from "@/lib/api";
import { ApplicationBuilderPage } from "@/pages/ApplicationBuilder";

const apiMock = vi.mocked(api);

type Init = { method?: string; body?: unknown } | undefined;

const CITY = {
  key: "city",
  section: 0,
  label: "City",
  helpText: null,
  required: true,
  hidden: false,
  sortOrder: 1,
  locked: false,
};

function mockApp(opts: {
  fields: () => Promise<unknown>;
  onPatch?: (key: string, body: unknown) => Promise<unknown>;
}) {
  apiMock.mockImplementation((async (path: string, init: Init) => {
    const method = (init?.method ?? "GET").toUpperCase();
    if (method === "GET" && path === "/admin/application-fields") return opts.fields();
    if (method === "GET" && path === "/admin/application-questions") return [];
    if (method === "PATCH" && path.startsWith("/admin/application-fields/")) {
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

function fieldRow(label: string): HTMLElement {
  return screen.getByText(label).closest("li") as HTMLElement;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("Standard fields save reporting", () => {
  it("keeps the saved hidden-toggle when the confirming reload fails", async () => {
    mockApp({
      fields: thenFails([CITY]),
      onPatch: async (key, body) => {
        expect(key).toBe("city");
        expect(body).toEqual({ hidden: true });
        return { ...CITY, hidden: true };
      },
    });
    render(<ApplicationBuilderPage />);

    const hideBtn = await screen.findByRole("button", { name: 'Hide "City"' });
    fireEvent.click(hideBtn);

    // The PATCH reply is authoritative: the failed reload must not undo the
    // hide the server just confirmed it stored.
    expect(
      await within(fieldRow("City")).findByText(/Saved — this page couldn't refresh/i),
    ).toBeTruthy();
    await waitFor(() => expect(within(fieldRow("City")).getByText("Hidden")).toBeTruthy());
  });

  it("keeps a saved label edit visible when the confirming reload fails", async () => {
    mockApp({
      fields: thenFails([CITY]),
      onPatch: async (key, body) => {
        expect(key).toBe("city");
        expect(body).toMatchObject({ labelOverride: "Municipality" });
        return { ...CITY, label: "Municipality" };
      },
    });
    render(<ApplicationBuilderPage />);

    fireEvent.click(await screen.findByRole("button", { name: 'Edit "City"' }));
    const labelInput = await screen.findByLabelText("Field label");
    fireEvent.change(labelInput, { target: { value: "Municipality" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText("Municipality")).toBeTruthy();
    expect(
      await within(fieldRow("Municipality")).findByText(/Saved — this page couldn't refresh/i),
    ).toBeTruthy();
    // The pre-edit label must not reappear.
    expect(screen.queryByText("City")).toBeNull();
  });

  it("reports a refused hide-toggle on the row without applying it", async () => {
    mockApp({
      fields: async () => [CITY],
      onPatch: async () => {
        throw new ApiError(403, "Not allowed to change this field.");
      },
    });
    render(<ApplicationBuilderPage />);

    fireEvent.click(await screen.findByRole("button", { name: 'Hide "City"' }));

    expect(
      await within(fieldRow("City")).findByText(/Not saved — Not allowed to change this field\./i),
    ).toBeTruthy();
    expect(within(fieldRow("City")).queryByText("Hidden")).toBeNull();
  });

  it("claims neither outcome when the write gets no clean answer", async () => {
    let reads = 0;
    mockApp({
      fields: async () => {
        reads += 1;
        return [CITY]; // still the pre-change value
      },
      onPatch: async () => {
        throw new ApiError(503, "The server is temporarily unreachable.");
      },
    });
    render(<ApplicationBuilderPage />);

    fireEvent.click(await screen.findByRole("button", { name: 'Hide "City"' }));

    expect(
      await within(fieldRow("City")).findByText(/Couldn't confirm the change/i),
    ).toBeTruthy();
    expect(reads).toBeGreaterThan(1); // it re-read rather than guessing
    expect(within(fieldRow("City")).queryByText("Hidden")).toBeNull();
  });
});
