import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from "vitest";
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
 *   - an empty required field blocks submit (no request leaves the building),
 *   - dropdown (select / boolean) and linked-record (FK) fields serialize the
 *     correct value on create/update — these load options from the API and
 *     serialize differently from plain text, and many real tables (users,
 *     shifts, sites, employees) rely on them.
 *
 * Mounts the real DataGrid -> RowFormDialog stack so the dialog wiring, the
 * form-value (de)serialization, and the create/update request shapes are all
 * exercised together. The `@/lib/api` data source is the only thing stubbed
 * (synthetic `widgets` descriptor passed directly as a prop). FK options are
 * sourced from the same stubbed `@/lib/api` (`owners` table) so the select →
 * id serialization is exercised end-to-end.
 */

type Row = {
  id: string;
  name: string;
  color?: string;
  createdAt?: string;
  active?: boolean;
  tier?: string;
  ownerId?: string;
};

const hoisted = vi.hoisted(() => ({
  rows: [] as Row[],
  ownerRows: [] as { id: string; name: string }[],
  listCalls: 0,
  creates: [] as Record<string, unknown>[],
  updates: [] as { id: string; body: Record<string, unknown> }[],
}));

vi.mock("@/lib/api", () => ({
  api: vi.fn(async (path: string, init?: { method?: string; body?: unknown }) => {
    const method = (init?.method ?? "GET").toUpperCase();
    const url = new URL(path, "http://test.local");
    const m = /\/admin\/tables\/([^/?]+)(?:\/([^/?]+))?/.exec(url.pathname);
    if (!m) return { rows: [], total: 0 };
    const table = m[1];
    const id = m[2];
    // FK option source for the `ownerId` linked-record field. Read-only here:
    // the dialog only ever lists this table to populate its dropdown.
    if (table === "owners") {
      return { rows: hoisted.ownerRows, total: hoisted.ownerRows.length };
    }
    if (table !== "widgets") return { rows: [], total: 0 };
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
import { TABLES, type TableDescriptor } from "@/lib/tables";
import { invalidateFk } from "@/lib/fk";

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

// Descriptor that also exercises the dropdown (boolean / select) and
// linked-record (FK) branches of `FieldInput`.
const choiceDescriptor = {
  name: "widgets",
  label: "Widgets",
  plural: "widgets",
  importSupported: false,
  primaryLabelField: "name",
  fields: [
    { key: "id", label: "ID", type: "text", readonly: true, hiddenInGrid: true },
    { key: "name", label: "Name", type: "text", required: true },
    { key: "active", label: "Active", type: "boolean" },
    {
      key: "tier",
      label: "Tier",
      type: "select",
      options: [
        { label: "Bronze", value: "bronze" },
        { label: "Silver", value: "silver" },
        { label: "Gold", value: "gold" },
      ],
    },
    { key: "ownerId", label: "Owner", type: "fk", fkTable: "owners" },
  ],
} as unknown as TableDescriptor;

// FK target table descriptor. Registered in TABLES so `useFkOptions` resolves
// human-readable option labels (its `primaryLabelField`) instead of falling
// back to the raw id — keeps the "pick by name, submit the id" assertion honest.
const ownersTable = {
  name: "owners",
  label: "Owners",
  plural: "owners",
  importSupported: false,
  primaryLabelField: "name",
  fields: [
    { key: "id", label: "ID", type: "text", readonly: true },
    { key: "name", label: "Name", type: "text", required: true },
  ],
} as unknown as TableDescriptor;

function getDialog(): HTMLElement {
  return screen.getByRole("dialog");
}

/**
 * Open a Radix Select (combobox) and click one of its options. Radix relies on
 * pointer-capture + scrollIntoView APIs jsdom doesn't implement (polyfilled in
 * beforeAll); opening via keyboard sidesteps the missing pointer plumbing.
 */
async function chooseOption(trigger: HTMLElement, optionName: RegExp | string) {
  fireEvent.keyDown(trigger, { key: "ArrowDown" });
  const option = await screen.findByRole("option", { name: optionName });
  fireEvent.click(option);
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

describe("RowFormDialog dropdown (select / boolean) and linked-record (FK) fields", () => {
  beforeAll(() => {
    // Radix Select relies on pointer-capture + scrollIntoView APIs jsdom omits.
    const proto = window.HTMLElement.prototype as unknown as Record<string, unknown>;
    proto.hasPointerCapture = proto.hasPointerCapture ?? (() => false);
    proto.setPointerCapture = proto.setPointerCapture ?? (() => {});
    proto.releasePointerCapture = proto.releasePointerCapture ?? (() => {});
    proto.scrollIntoView = proto.scrollIntoView ?? (() => {});
    if (!("ResizeObserver" in globalThis)) {
      (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
        observe() {}
        unobserve() {}
        disconnect() {}
      };
    }
    // Register the FK target so its options resolve readable labels.
    TABLES.push(ownersTable);
  });

  afterAll(() => {
    const i = TABLES.indexOf(ownersTable);
    if (i >= 0) TABLES.splice(i, 1);
  });

  beforeEach(() => {
    hoisted.rows = [];
    hoisted.ownerRows = [
      { id: "o1", name: "Acme Holdings" },
      { id: "o2", name: "Globex Corp" },
    ];
    hoisted.listCalls = 0;
    hoisted.creates = [];
    hoisted.updates = [];
    invalidateFk("owners"); // module-level FK cache survives across tests
    vi.clearAllMocks();
  });

  it("Add: a select and a boolean serialize their chosen values on create", async () => {
    render(<DataGrid descriptor={choiceDescriptor} />);
    await waitFor(() => expect(hoisted.listCalls).toBeGreaterThanOrEqual(1));

    fireEvent.click(screen.getByRole("button", { name: /add widget/i }));
    const dialog = await screen.findByRole("dialog");

    fireEvent.change(within(dialog).getByLabelText(/^name/i), {
      target: { value: "Gadget" },
    });

    // Boolean dropdown: default is "No" (false); pick "Yes" -> true.
    await chooseOption(within(dialog).getByLabelText(/^active/i), "Yes");
    // Enum select: pick "Silver" -> "silver".
    await chooseOption(within(dialog).getByLabelText(/^tier/i), "Silver");

    fireEvent.click(within(dialog).getByRole("button", { name: "Create" }));

    await waitFor(() => expect(hoisted.creates).toHaveLength(1));
    // Boolean serializes to a real boolean, select to its option value.
    expect(hoisted.creates[0]).toMatchObject({
      name: "Gadget",
      active: true,
      tier: "silver",
    });
    expect(typeof hoisted.creates[0].active).toBe("boolean");
  });

  it("Add: picking an FK option submits the chosen id (not the label)", async () => {
    render(<DataGrid descriptor={choiceDescriptor} />);
    await waitFor(() => expect(hoisted.listCalls).toBeGreaterThanOrEqual(1));

    fireEvent.click(screen.getByRole("button", { name: /add widget/i }));
    const dialog = await screen.findByRole("dialog");

    fireEvent.change(within(dialog).getByLabelText(/^name/i), {
      target: { value: "Gizmo" },
    });

    // The FK dropdown lists owners by name; pick "Globex Corp" (id o2).
    await chooseOption(within(dialog).getByLabelText(/^owner/i), "Globex Corp");

    fireEvent.click(within(dialog).getByRole("button", { name: "Create" }));

    await waitFor(() => expect(hoisted.creates).toHaveLength(1));
    // The id is submitted, not the human-readable label.
    expect(hoisted.creates[0]).toMatchObject({ name: "Gizmo", ownerId: "o2" });
  });

  it("Edit: changing a boolean dropdown submits the new boolean on update", async () => {
    hoisted.rows = [{ id: "w1", name: "Widget One", active: false, tier: "bronze", ownerId: "o1" }];
    render(<DataGrid descriptor={choiceDescriptor} />);
    await waitFor(() => expect(screen.getByText("Widget One")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: /edit widget/i }));
    const dialog = await screen.findByRole("dialog");

    // Flip Active from No -> Yes.
    await chooseOption(within(dialog).getByLabelText(/^active/i), "Yes");

    fireEvent.click(within(dialog).getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(hoisted.updates).toHaveLength(1));
    expect(hoisted.updates[0].id).toBe("w1");
    expect(hoisted.updates[0].body).toMatchObject({ active: true });
    expect(hoisted.creates).toHaveLength(0);
  });
});
