import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor, fireEvent, within } from "@testing-library/react";

/**
 * Regression coverage for the generic Add/Edit row form (`RowFormDialog`) as it
 * is actually used: opened from the `DataGrid` toolbar / row actions for every
 * admin table. The grid's read-side controls (sort, search, pagination, delete)
 * are covered elsewhere; this exercises the *write* side end-to-end:
 *   - Add opens, a required field is filled, submit POSTs the new row, the list
 *     reloads,
 *   - Edit opens prefilled, a changed field is submitted as a PUT carrying the
 *     new value,
 *   - an empty required field blocks submit (no request leaves the building).
 *
 * Mounts the real DataGrid -> RowFormDialog stack so the dialog wiring, the
 * form-value (de)serialization, and the create/update request shapes are all
 * exercised together. The `@/lib/api` data source is the only thing stubbed
 * (synthetic `widgets` descriptor passed directly as a prop).
 */

type Row = { id: string; name: string; color?: string; createdAt?: string };

const hoisted = vi.hoisted(() => ({
  rows: [] as Row[],
  listCalls: 0,
  creates: [] as Record<string, unknown>[],
  updates: [] as { id: string; body: Record<string, unknown> }[],
}));

vi.mock("@/lib/api", () => ({
  api: vi.fn(async (path: string, init?: { method?: string; body?: unknown }) => {
    const method = (init?.method ?? "GET").toUpperCase();
    const url = new URL(path, "http://test.local");
    const m = /\/admin\/tables\/widgets(?:\/([^/?]+))?/.exec(url.pathname);
    if (!m) return { rows: [], total: 0 };
    const id = m[1];
    if (method === "GET") {
      hoisted.listCalls += 1;
      const limit = Number(url.searchParams.get("limit") ?? "25");
      const offset = Number(url.searchParams.get("offset") ?? "0");
      return { rows: hoisted.rows.slice(offset, offset + limit), total: hoisted.rows.length };
    }
    if (method === "POST") {
      hoisted.creates.push(init?.body as Record<string, unknown>);
      return {};
    }
    if (method === "PUT") {
      hoisted.updates.push({ id: id!, body: init?.body as Record<string, unknown> });
      return {};
    }
    return {};
  }),
  getToken: () => null,
  ApiError: class ApiError extends Error {},
}));

// Imported after the mock so the mocked module is picked up.
import { DataGrid } from "@/components/DataGrid";
import type { TableDescriptor } from "@/lib/tables";

const descriptor = {
  name: "widgets",
  label: "Widgets",
  plural: "widgets",
  importSupported: false,
  primaryLabelField: "name",
  fields: [
    { key: "id", label: "ID", type: "text", readonly: true, hiddenInGrid: true },
    { key: "name", label: "Name", type: "text", required: true },
    { key: "color", label: "Color", type: "text" },
    { key: "createdAt", label: "Created", type: "datetime", readonly: true },
  ],
} as unknown as TableDescriptor;

function getDialog(): HTMLElement {
  return screen.getByRole("dialog");
}

describe("RowFormDialog create/edit via the admin DataGrid", () => {
  beforeEach(() => {
    hoisted.rows = [];
    hoisted.listCalls = 0;
    hoisted.creates = [];
    hoisted.updates = [];
    vi.clearAllMocks();
  });

  it("Add: fills a required field, submits a create request, and reloads the list", async () => {
    render(<DataGrid descriptor={descriptor} />);

    // Initial list load.
    await waitFor(() => expect(hoisted.listCalls).toBeGreaterThanOrEqual(1));
    const loadsBeforeSave = hoisted.listCalls;

    fireEvent.click(screen.getByRole("button", { name: /add widget/i }));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Add Widget")).toBeTruthy();

    fireEvent.change(within(dialog).getByLabelText(/^name/i), {
      target: { value: "Gadget" },
    });

    fireEvent.click(within(dialog).getByRole("button", { name: "Create" }));

    // The create request carries the typed value...
    await waitFor(() => expect(hoisted.creates).toHaveLength(1));
    expect(hoisted.creates[0]).toMatchObject({ name: "Gadget" });
    // ...empty optional fields are not sent on create.
    expect(hoisted.creates[0]).not.toHaveProperty("color");

    // ...the dialog closes and the list reloads (onSaved -> load).
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(hoisted.listCalls).toBeGreaterThan(loadsBeforeSave);
  });

  it("Edit: changes a field and submits an update request carrying the new value", async () => {
    hoisted.rows = [{ id: "w1", name: "Old Name", color: "red", createdAt: "2026-01-01T00:00:00.000Z" }];
    render(<DataGrid descriptor={descriptor} />);

    await waitFor(() => expect(screen.getByText("Old Name")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: /edit widget/i }));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Edit Widget")).toBeTruthy();

    const nameInput = within(dialog).getByLabelText(/^name/i) as HTMLInputElement;
    // Form is prefilled from the existing row.
    expect(nameInput.value).toBe("Old Name");

    fireEvent.change(nameInput, { target: { value: "New Name" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(hoisted.updates).toHaveLength(1));
    expect(hoisted.updates[0].id).toBe("w1");
    expect(hoisted.updates[0].body).toMatchObject({ name: "New Name" });
    // No stray create on the edit path.
    expect(hoisted.creates).toHaveLength(0);
  });

  it("Validation: an empty required field blocks submit and surfaces an error", async () => {
    render(<DataGrid descriptor={descriptor} />);
    await waitFor(() => expect(hoisted.listCalls).toBeGreaterThanOrEqual(1));

    fireEvent.click(screen.getByRole("button", { name: /add widget/i }));
    const dialog = await screen.findByRole("dialog");

    // Leave the required Name field empty and try to save.
    fireEvent.click(within(dialog).getByRole("button", { name: "Create" }));

    // The required-field error is surfaced and no create request is sent.
    await waitFor(() =>
      expect(within(getDialog()).getByText(/name is required/i)).toBeTruthy(),
    );
    expect(hoisted.creates).toHaveLength(0);
    // Dialog stays open so the admin can correct it.
    expect(screen.queryByRole("dialog")).not.toBeNull();
  });
});
