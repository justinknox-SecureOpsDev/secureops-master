/**
 * StaffingRowsEditor — multi-position staffing rows used by both the New
 * Shift and Repeating Shift dialogs. Each row maps to one shift record.
 *
 * Pins: add/remove rows, duplicate-position warning, headcount clamping,
 * site-manager rate-blindness (no rate UI), and rate-card auto-fill.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { useState } from "react";
import {
  StaffingRowsEditor, newStaffingRow, type SiteRate, type StaffingRow,
} from "../StaffingRowsEditor";

const RATES: SiteRate[] = [
  { id: "r2", siteId: "s1", licenseLevel: 2, rateTier: 1, payRate: "20.00", billRate: "40.00", label: null },
  { id: "r3", siteId: "s1", licenseLevel: 3, rateTier: 1, payRate: "28.00", billRate: "52.00", label: "Armed" },
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

describe("StaffingRowsEditor", () => {
  it("renders one row by default with no remove button", () => {
    render(<Harness />);
    expect(screen.getByText(/Positions & staffing/i)).toBeTruthy();
    expect(screen.queryByLabelText("Remove position")).toBeNull();
  });

  it("adds a row with the next unused license level", () => {
    const onRows = vi.fn();
    render(<Harness onRows={onRows} />);
    fireEvent.click(screen.getByRole("button", { name: /add position/i }));
    const rows = onRows.mock.calls.at(-1)![0] as StaffingRow[];
    expect(rows).toHaveLength(2);
    // First row is level 2, so the new row picks level 1 (first unused).
    expect(rows[1].requiredLicenseLevel).toBe(1);
    // Remove buttons appear once there are 2+ rows.
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

  it("disables Add position when all 4 levels are used", () => {
    const initial = [1, 2, 3, 4].map((lvl) => ({ ...newStaffingRow(lvl, []), requiredLicenseLevel: lvl }));
    render(<Harness initialRows={initial} />);
    expect((screen.getByRole("button", { name: /add position/i }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows a duplicate warning when two rows share a license level", () => {
    const a = { ...newStaffingRow(2, []), requiredLicenseLevel: 2 };
    const b = { ...newStaffingRow(2, []), requiredLicenseLevel: 2 };
    render(<Harness initialRows={[a, b]} />);
    expect(screen.getAllByText(/duplicate position/i).length).toBeGreaterThanOrEqual(2);
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

  it("hides all rate UI for site managers", () => {
    render(<Harness isSiteManager />);
    expect(screen.queryByText(/rate card/i)).toBeNull();
    expect(screen.queryByText(/pay \(\$\/hr\)/i)).toBeNull();
  });

  it("shows rate card cards for admins and snaps rates when one is clicked", () => {
    const onRows = vi.fn();
    render(<Harness onRows={onRows} />);
    // Click the L3 rate card button.
    fireEvent.click(screen.getByText(/L3 Armed · Rate 1 — Armed/i));
    const rows = onRows.mock.calls.at(-1)![0] as StaffingRow[];
    expect(rows[0].siteRateId).toBe("r3");
    expect(rows[0].requiredLicenseLevel).toBe(3);
    expect(Number(rows[0].payRate)).toBe(28);
    expect(Number(rows[0].billRate)).toBe(52);
  });

  it("clears the rate-card link when a rate is manually edited (custom)", () => {
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
