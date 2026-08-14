/**
 * StaffingRowsEditor — multi-position staffing rows used by both the New
 * Shift and Repeating Shift dialogs. Each row maps to one shift record.
 *
 * Pins the named-position behaviour: positions are picked BY NAME from the
 * site's rate card, a site can staff several positions at the SAME license
 * level (no per-level cap, no "Rate N" tier picker), duplicates are only
 * genuinely identical positions, and the warning names the position.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { useState } from "react";
import {
  StaffingRowsEditor, newStaffingRow, duplicateStaffingMessage, positionOptionLabel,
  rateName, type SiteRate, type StaffingRow,
} from "../StaffingRowsEditor";

const RATES: SiteRate[] = [
  { id: "r2", siteId: "s1", licenseLevel: 2, rateTier: 1, name: "Floor Guard", payRate: "20.00", billRate: "40.00", label: null },
  { id: "r3", siteId: "s1", licenseLevel: 3, rateTier: 1, name: "Armed Post", payRate: "28.00", billRate: "52.00", label: "Armed" },
];

/** Three named positions at ONE license level — the shape that used to be capped. */
const THREE_L2: SiteRate[] = [
  { id: "a", siteId: "s1", licenseLevel: 2, rateTier: 1, name: "Tier 1", payRate: "20.00", billRate: "40.00", label: null },
  { id: "b", siteId: "s1", licenseLevel: 2, rateTier: 2, name: "Floor Manager", payRate: "24.00", billRate: "46.00", label: null },
  { id: "c", siteId: "s1", licenseLevel: 2, rateTier: 3, name: "Overnight Supervisor", payRate: "27.00", billRate: "50.00", label: null },
  { id: "d", siteId: "s1", licenseLevel: 2, rateTier: 4, name: "Event Lead", payRate: "30.00", billRate: "56.00", label: null },
];

function Harness({
  initialRows,
  siteRates = RATES,
  isSiteManager = false,
  hasSite = true,
  onRows,
}: {
  initialRows?: StaffingRow[];
  siteRates?: SiteRate[];
  isSiteManager?: boolean;
  hasSite?: boolean;
  onRows?: (rows: StaffingRow[]) => void;
}) {
  const [rows, setRows] = useState<StaffingRow[]>(initialRows ?? [newStaffingRow(2, siteRates)]);
  return (
    <StaffingRowsEditor
      rows={rows}
      onChange={(r) => { setRows(r); onRows?.(r); }}
      siteRates={siteRates}
      ratesLoading={false}
      isSiteManager={isSiteManager}
      hasSite={hasSite}
    />
  );
}

/** Open a Radix Select via keyboard (jsdom lacks the pointer-capture APIs). */
async function chooseOption(trigger: HTMLElement, optionName: RegExp | string) {
  fireEvent.keyDown(trigger, { key: "ArrowDown" });
  const option = await screen.findByRole("option", { name: optionName });
  fireEvent.click(option);
}

beforeAll(() => {
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
});

describe("StaffingRowsEditor", () => {
  it("renders one row by default with no remove button", () => {
    render(<Harness />);
    expect(screen.getByText(/Positions & staffing/i)).toBeTruthy();
    expect(screen.queryByLabelText("Remove position")).toBeNull();
  });

  it("adds a row carrying the next unused NAMED position", () => {
    const onRows = vi.fn();
    render(<Harness onRows={onRows} />);
    fireEvent.click(screen.getByRole("button", { name: /add position/i }));
    const rows = onRows.mock.calls.at(-1)![0] as StaffingRow[];
    expect(rows).toHaveLength(2);
    // First row snapped to "Floor Guard" (r2), so the next unused card is r3.
    expect(rows[1].siteRateId).toBe("r3");
    expect(rows[1].requiredLicenseLevel).toBe(3);
    expect(screen.getAllByLabelText("Remove position")).toHaveLength(2);
  });

  it("removes a row", () => {
    const onRows = vi.fn();
    render(<Harness onRows={onRows} />);
    fireEvent.click(screen.getByRole("button", { name: /add position/i }));
    fireEvent.click(screen.getAllByLabelText("Remove position")[1]);
    const rows = onRows.mock.calls.at(-1)![0] as StaffingRow[];
    expect(rows).toHaveLength(1);
  });

  it("staffs FOUR named positions at the same license level — no per-level cap", () => {
    const onRows = vi.fn();
    render(<Harness siteRates={THREE_L2} onRows={onRows} />);
    const add = screen.getByRole("button", { name: /add position/i }) as HTMLButtonElement;
    for (let i = 0; i < 3; i++) {
      expect(add.disabled).toBe(false);
      fireEvent.click(add);
    }
    const rows = onRows.mock.calls.at(-1)![0] as StaffingRow[];
    expect(rows).toHaveLength(4);
    expect(rows.map((r) => r.siteRateId)).toEqual(["a", "b", "c", "d"]);
    expect(rows.every((r) => r.requiredLicenseLevel === 2)).toBe(true);
    // Every row is a distinct position ⟹ no duplicate warning.
    expect(screen.queryByText(/duplicate position/i)).toBeNull();
  });

  it("keeps Add position enabled for admins even past the four license levels", () => {
    const initial = [1, 2, 3, 4].map((lvl) => ({ ...newStaffingRow(lvl, []), requiredLicenseLevel: lvl }));
    render(<Harness initialRows={initial} />);
    expect((screen.getByRole("button", { name: /add position/i }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("caps site managers at one row per license level (they pick levels, not positions)", () => {
    const initial = [1, 2, 3, 4].map((lvl) => ({ ...newStaffingRow(lvl, []), requiredLicenseLevel: lvl }));
    render(<Harness initialRows={initial} isSiteManager />);
    expect((screen.getByRole("button", { name: /add position/i }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("flags two rows on the SAME named position and names it in the warning", () => {
    const a = { ...newStaffingRow(2, RATES) };            // Floor Guard
    const b = { ...a, key: "row-dup" };                   // same position again
    render(<Harness initialRows={[a, b]} />);
    const warnings = screen.getAllByText(/duplicate position/i);
    expect(warnings.length).toBeGreaterThanOrEqual(2);
    expect(warnings[0].textContent).toContain("Floor Guard");
  });

  it("flags two custom rows at the same level with identical pay and bill", () => {
    const a = { ...newStaffingRow(2, []), requiredLicenseLevel: 2 };
    const b = { ...newStaffingRow(2, []), requiredLicenseLevel: 2 };
    render(<Harness initialRows={[a, b]} siteRates={[]} />);
    expect(screen.getAllByText(/duplicate position/i).length).toBeGreaterThanOrEqual(2);
  });

  it("does NOT flag two DIFFERENT named positions at the same license level", () => {
    const a = { ...newStaffingRow(2, THREE_L2) };                                        // "Tier 1"
    const b = { ...a, key: "row-b", payRate: "24.00", billRate: "46.00", siteRateId: "b" }; // "Floor Manager"
    render(<Harness initialRows={[a, b]} siteRates={THREE_L2} />);
    expect(screen.queryByText(/duplicate position/i)).toBeNull();
  });

  it("does NOT flag two rows with the same level but different custom rates", () => {
    const a = { ...newStaffingRow(3, []), payRate: "26.00", billRate: "48.00" };
    const b = { ...newStaffingRow(3, []), payRate: "30.00", billRate: "55.00" };
    render(<Harness initialRows={[a, b]} siteRates={[]} />);
    expect(screen.queryByText(/duplicate position/i)).toBeNull();
  });

  it("clamps staff count to a positive integer", () => {
    const onRows = vi.fn();
    render(<Harness onRows={onRows} />);
    const input = screen.getByLabelText(/staff count/i, { selector: "input" });
    fireEvent.change(input, { target: { value: "-4" } });
    let rows = onRows.mock.calls.at(-1)![0] as StaffingRow[];
    expect(rows[0].headcount).toBe(1);
    fireEvent.change(input, { target: { value: "3.7" } });
    rows = onRows.mock.calls.at(-1)![0] as StaffingRow[];
    expect(rows[0].headcount).toBe(3);
  });

  it("hides all rate UI for site managers and falls back to a license-level picker", () => {
    render(<Harness isSiteManager />);
    expect(screen.queryByText(/pay \(\$\/hr\)/i)).toBeNull();
    expect(screen.queryByText(/^Position$/)).toBeNull();
    expect(screen.getByText(/license level/i)).toBeTruthy();
  });

  it("picking a position by name pulls its license level and rates through", async () => {
    const onRows = vi.fn();
    render(<Harness onRows={onRows} />);
    await chooseOption(screen.getByRole("combobox"), /Armed Post/i);
    const rows = onRows.mock.calls.at(-1)![0] as StaffingRow[];
    expect(rows[0].siteRateId).toBe("r3");
    expect(rows[0].requiredLicenseLevel).toBe(3);
    expect(Number(rows[0].payRate)).toBe(28);
    expect(Number(rows[0].billRate)).toBe(52);
  });

  it("clears the position link when a rate is manually edited (custom)", () => {
    const onRows = vi.fn();
    const row = { ...newStaffingRow(2, RATES) }; // snapped to r2
    render(<Harness initialRows={[row]} onRows={onRows} />);
    const payInput = screen.getByLabelText(/pay \(\$\/hr\)/i, { selector: "input" });
    fireEvent.change(payInput, { target: { value: "22.50" } });
    const rows = onRows.mock.calls.at(-1)![0] as StaffingRow[];
    expect(rows[0].siteRateId).toBeNull();
    expect(rows[0].payRate).toBe("22.50");
  });

  it("newStaffingRow snaps to the site's default rate for the level", () => {
    const row = newStaffingRow(3, RATES);
    expect(row.siteRateId).toBe("r3");
    expect(row.payRate).toBe("28.00");
    expect(row.headcount).toBe(1);
  });
});

describe("position naming helpers", () => {
  it("falls back to the internal slot number for legacy unnamed rates", () => {
    expect(rateName({ name: null, rateTier: 2 })).toBe("Rate 2");
    expect(rateName({ name: "  ", rateTier: 1 })).toBe("Rate 1");
    expect(rateName({ name: "Floor Manager", rateTier: 3 })).toBe("Floor Manager");
  });

  it("labels an option by name first, then license level", () => {
    expect(positionOptionLabel(RATES[0])).toBe("Floor Guard — L2 Unarmed");
    expect(positionOptionLabel(RATES[1])).toBe("Armed Post — L3 Armed · Armed");
  });

  it("names the offending position in the duplicate message", () => {
    const a = { ...newStaffingRow(2, RATES) };
    const dup = duplicateStaffingMessage([a, { ...a, key: "x" }], RATES);
    expect(dup).toContain("Floor Guard");
    expect(dup).not.toMatch(/rate tier/i);
  });

  it("describes custom duplicates by level and rates, not tiers", () => {
    const a = { ...newStaffingRow(3, []), payRate: "26", billRate: "48" };
    const dup = duplicateStaffingMessage([a, { ...a, key: "x" }], []);
    expect(dup).toMatch(/L3 Armed/);
    expect(dup).not.toMatch(/rate tier/i);
  });
});
