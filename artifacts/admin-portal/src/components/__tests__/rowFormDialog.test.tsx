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
  shiftRows: [] as { id: string; name: string; siteId: string; payRate: number }[],
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
    // FK option source for the linked shift field. Each shift row carries a
    // `siteId` so the dependent dropdown can be filtered by the chosen site, and
    // a `payRate` so the autofill mapping has something to copy. Named
    // `siteshifts` to avoid colliding with the real `shifts` table in TABLES.
    if (table === "siteshifts") {
      return { rows: hoisted.shiftRows, total: hoisted.shiftRows.length };
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

// Descriptor exercising the *linked* FK behaviours that drive shift-assignment:
//  - `siteId` is the source select the dependent dropdown filters against.
//  - `shiftId` is a virtual FK whose options are narrowed to the chosen site
//    (`filterBy`) and which, on pick, copies values from the picked shift row
//    into real form fields (`autofill`). Being virtual it is never submitted and
//    is the field the dialog clears when the source (`siteId`) changes.
//  - `assignedShiftId` / `payRate` are the real fields the autofill targets.
const linkedDescriptor = {
  name: "widgets",
  label: "Widgets",
  plural: "widgets",
  importSupported: false,
  primaryLabelField: "name",
  fields: [
    { key: "id", label: "ID", type: "text", readonly: true, hiddenInGrid: true },
    { key: "name", label: "Name", type: "text", required: true },
    {
      key: "siteId",
      label: "Site",
      type: "select",
      options: [
        { label: "Site A", value: "site-a" },
        { label: "Site B", value: "site-b" },
      ],
    },
    {
      key: "shiftId",
      label: "Shift",
      type: "fk",
      fkTable: "siteshifts",
      virtual: true,
      filterBy: { fkRowKey: "siteId", formKey: "siteId" },
      autofill: { assignedShiftId: "id", payRate: "payRate" },
    },
    { key: "assignedShiftId", label: "Assigned Shift ID", type: "text" },
    { key: "payRate", label: "Pay Rate", type: "number" },
  ],
} as unknown as TableDescriptor;

// FK target table for the linked dropdown — registered so option labels resolve.
// Named `siteshifts` (not `shifts`) so it doesn't shadow the real shifts table
// already in TABLES, whose primaryLabelField wouldn't match these test rows.
const siteShiftsTable = {
  name: "siteshifts",
  label: "Site Shifts",
  plural: "siteshifts",
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

/**
 * Linked FK fields — the most error-prone part of the form, used by the
 * shift-assignment flows. `filterBy` narrows a dependent dropdown to rows
 * matching another field's value (pick a site -> only that site's shifts show),
 * changing the source clears the dependent virtual selection, and `autofill`
 * copies values from the picked FK row into other (real, submitted) fields.
 */
// The `filterBy` test drives the most Radix Select open/close + option-render
// cycles in this file (open site, pick, open shift, pick, change site, reopen
// shift). Under the full parallel `pnpm -r` workspace run, CPU contention can
// push it past vitest's 5s default per-test timeout even though it passes
// comfortably in isolation. A generous per-test timeout removes the flake
// without masking a real hang.
const FILTER_BY_TEST_TIMEOUT_MS = 20000;

describe("RowFormDialog linked FK fields (filterBy narrowing + clearing, autofill copy)", () => {
  beforeAll(() => {
    // Same Radix/jsdom polyfills the dropdown suite relies on.
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
    TABLES.push(siteShiftsTable);
  });

  afterAll(() => {
    const i = TABLES.indexOf(siteShiftsTable);
    if (i >= 0) TABLES.splice(i, 1);
  });

  beforeEach(() => {
    hoisted.rows = [];
    // Two shifts at site-a, one at site-b — lets us assert the dropdown is
    // narrowed to exactly the chosen site's shifts.
    hoisted.shiftRows = [
      { id: "sh1", name: "Mon Day Shift", siteId: "site-a", payRate: 25 },
      { id: "sh2", name: "Tue Night Shift", siteId: "site-a", payRate: 30 },
      { id: "sh3", name: "Wed Patrol", siteId: "site-b", payRate: 28 },
    ];
    hoisted.listCalls = 0;
    hoisted.creates = [];
    hoisted.updates = [];
    invalidateFk("siteshifts"); // module-level FK cache survives across tests
    vi.clearAllMocks();
  });

  it("filterBy: narrows the dependent dropdown to the chosen site and clears it when the site changes", async () => {
    render(<DataGrid descriptor={linkedDescriptor} />);
    await waitFor(() => expect(hoisted.listCalls).toBeGreaterThanOrEqual(1));

    fireEvent.click(screen.getByRole("button", { name: /add widget/i }));
    const dialog = await screen.findByRole("dialog");

    // Before a site is picked the dependent dropdown prompts for the source.
    expect(within(dialog).getByLabelText(/^shift/i).textContent).toMatch(/pick siteId first/i);

    // Pick Site A -> the dependent dropdown should only list site-a's shifts.
    await chooseOption(within(dialog).getByLabelText(/^site/i), "Site A");

    const shiftTrigger = within(dialog).getByLabelText(/^shift/i);
    fireEvent.keyDown(shiftTrigger, { key: "ArrowDown" });
    expect(await screen.findByRole("option", { name: "Mon Day Shift" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "Tue Night Shift" })).toBeTruthy();
    // Site B's shift is filtered out.
    expect(screen.queryByRole("option", { name: "Wed Patrol" })).toBeNull();

    // Select one of site-a's shifts; the trigger now shows that selection.
    fireEvent.click(screen.getByRole("option", { name: "Mon Day Shift" }));
    await waitFor(() =>
      expect(within(dialog).getByLabelText(/^shift/i).textContent).toMatch(/Mon Day Shift/),
    );

    // Change the source site -> the dependent selection is cleared...
    await chooseOption(within(dialog).getByLabelText(/^site/i), "Site B");
    await waitFor(() =>
      expect(within(dialog).getByLabelText(/^shift/i).textContent).not.toMatch(/Mon Day Shift/),
    );

    // ...and the dropdown is now narrowed to site-b's shift instead.
    fireEvent.keyDown(within(dialog).getByLabelText(/^shift/i), { key: "ArrowDown" });
    expect(await screen.findByRole("option", { name: "Wed Patrol" })).toBeTruthy();
    expect(screen.queryByRole("option", { name: "Mon Day Shift" })).toBeNull();
    expect(screen.queryByRole("option", { name: "Tue Night Shift" })).toBeNull();
  }, FILTER_BY_TEST_TIMEOUT_MS);

  it("autofill: picking a shift copies the mapped values into the target fields and submits them", async () => {
    render(<DataGrid descriptor={linkedDescriptor} />);
    await waitFor(() => expect(hoisted.listCalls).toBeGreaterThanOrEqual(1));

    fireEvent.click(screen.getByRole("button", { name: /add widget/i }));
    const dialog = await screen.findByRole("dialog");

    fireEvent.change(within(dialog).getByLabelText(/^name/i), {
      target: { value: "Assignment" },
    });

    // Pick a site, then a shift; the shift's id + payRate autofill the targets.
    await chooseOption(within(dialog).getByLabelText(/^site/i), "Site A");
    await chooseOption(within(dialog).getByLabelText(/^shift/i), "Tue Night Shift");

    // The autofill copied the picked shift's row values into the real fields.
    await waitFor(() =>
      expect((within(dialog).getByLabelText(/^assigned shift id/i) as HTMLInputElement).value).toBe("sh2"),
    );
    expect((within(dialog).getByLabelText(/^pay rate/i) as HTMLInputElement).value).toBe("30");

    fireEvent.click(within(dialog).getByRole("button", { name: "Create" }));

    await waitFor(() => expect(hoisted.creates).toHaveLength(1));
    // The autofilled values are submitted on the real fields...
    expect(hoisted.creates[0]).toMatchObject({
      name: "Assignment",
      siteId: "site-a",
      assignedShiftId: "sh2",
      payRate: "30",
    });
    // ...while the virtual `shiftId` helper field is never sent to the API.
    expect(hoisted.creates[0]).not.toHaveProperty("shiftId");
  });
});
