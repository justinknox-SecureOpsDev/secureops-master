import { describe, expect, it } from "vitest";
import { getTableColumns } from "drizzle-orm";
import { shiftsTable, timeEntriesTable } from "@workspace/db";
import { stripShiftFinanceForRole, stripTimeEntryBillRateForRole } from "../lib/financeVisibility";

// Task #785 — closes the schema-drift gap on the ROLE-based finance-visibility
// axis (stripShiftFinanceForRole / stripTimeEntryBillRateForRole), the
// counterpart to the OWNER-based DASHBOARD_FINANCE_FIELDS schema-drift test in
// companyOwnerAndPermissions.test.ts.
//
// Both strip functions destructure a hardcoded list of field names rather
// than checking against the shiftsTable/timeEntriesTable schema, so a new
// money-shaped numeric column (an overtime rate, a rate override, ...) added
// to either table would silently reach the external client role unless a
// developer remembered to also update these two functions. This test
// enumerates every `numeric` column on both tables and fails the moment one
// isn't accounted for by an explicit allowlist below OR proven, by actually
// invoking the real strip function, to be stripped for the client role.
function numericColumnKeys(table: Parameters<typeof getTableColumns>[0]): string[] {
  const columns = getTableColumns(table);
  return Object.entries(columns)
    .filter(([, col]) => (col as { columnType?: string }).columnType === "PgNumeric")
    .map(([key]) => key);
}

const shiftNumericKeys = numericColumnKeys(shiftsTable);
const timeEntryNumericKeys = numericColumnKeys(timeEntriesTable);

// Location coordinates are numeric but not money — they are never touched by
// either strip function and are fine for every role (incl. client, as
// defense in depth; clients don't reach these routes at all today via
// requireStaff) to see.
const SHIFT_NON_MONEY_ALLOWLIST = new Set(["locationLat", "locationLng"]);
const TIME_ENTRY_NON_MONEY_ALLOWLIST = new Set([
  "clockInLat",
  "clockInLng",
  "clockOutLat",
  "clockOutLng",
  "hoursWorked", // a duration, not a dollar figure
]);

it("shifts has at least one numeric column to check (sanity guard against a schema-introspection regression)", () => {
  expect(shiftNumericKeys.length).toBeGreaterThan(0);
});

it("time_entries has at least one numeric column to check (sanity guard against a schema-introspection regression)", () => {
  expect(timeEntryNumericKeys.length).toBeGreaterThan(0);
});

describe("Every numeric (money-shaped) column on shifts is either non-money or actually stripped for the client role", () => {
  // A synthetic row carrying every numeric column set to a distinct
  // sentinel value, so we can tell exactly which keys survive each role's
  // strip.
  const fullRow = Object.fromEntries(shiftNumericKeys.map((k) => [k, `sentinel-${k}`])) as Record<string, unknown>;

  it.each(shiftNumericKeys)("shifts.%s is either non-money or stripped for role=client", (key) => {
    if (SHIFT_NON_MONEY_ALLOWLIST.has(key)) return;
    const stripped = stripShiftFinanceForRole("client", { ...fullRow }) as Record<string, unknown>;
    expect(stripped).not.toHaveProperty(key);
  });

  it("admin keeps every numeric field (not over-stripped)", () => {
    const kept = stripShiftFinanceForRole("admin", { ...fullRow }) as Record<string, unknown>;
    for (const key of shiftNumericKeys) {
      expect(kept[key]).toBe(fullRow[key]);
    }
  });

  it("dispatcher keeps every numeric field (finance-bearing staff)", () => {
    const kept = stripShiftFinanceForRole("dispatcher", { ...fullRow }) as Record<string, unknown>;
    for (const key of shiftNumericKeys) {
      expect(kept[key]).toBe(fullRow[key]);
    }
  });

  it("non-admin internal staff (site_manager/officer) keep payRate/hourlyRate but never billRate/billableRate", () => {
    const out = stripShiftFinanceForRole("employee", { ...fullRow }) as Record<string, unknown>;
    for (const key of shiftNumericKeys) {
      if (SHIFT_NON_MONEY_ALLOWLIST.has(key)) continue;
      if (key === "billRate" || key === "billableRate") {
        expect(out).not.toHaveProperty(key);
      } else {
        expect(out[key]).toBe(fullRow[key]);
      }
    }
  });
});

describe("Every numeric (money-shaped) column on time_entries is either non-money or actually stripped for the client role", () => {
  const fullRow = Object.fromEntries(timeEntryNumericKeys.map((k) => [k, `sentinel-${k}`])) as Record<string, unknown>;

  it.each(timeEntryNumericKeys)("time_entries.%s is either non-money or stripped for role=client", (key) => {
    if (TIME_ENTRY_NON_MONEY_ALLOWLIST.has(key)) return;
    const stripped = stripTimeEntryBillRateForRole("client", { ...fullRow }) as Record<string, unknown>;
    expect(stripped).not.toHaveProperty(key);
  });

  it("admin keeps every numeric field (not over-stripped)", () => {
    const kept = stripTimeEntryBillRateForRole("admin", { ...fullRow }) as Record<string, unknown>;
    for (const key of timeEntryNumericKeys) {
      expect(kept[key]).toBe(fullRow[key]);
    }
  });

  it("dispatcher keeps every numeric field (finance-bearing staff)", () => {
    const kept = stripTimeEntryBillRateForRole("dispatcher", { ...fullRow }) as Record<string, unknown>;
    for (const key of timeEntryNumericKeys) {
      expect(kept[key]).toBe(fullRow[key]);
    }
  });

  // payRateOverride is the raw admin-set override input (see the schema
  // comment on timeEntriesTable.payRateOverride) — the same admin/dispatcher
  // -only class as billRate, never the officer-facing resolved `payRate`
  // computed field that routes/timeEntries.ts joins in from shiftsTable.
  it("non-admin internal staff (site_manager/officer) never see payRateOverride or billRate", () => {
    const out = stripTimeEntryBillRateForRole("employee", { ...fullRow }) as Record<string, unknown>;
    for (const key of timeEntryNumericKeys) {
      if (TIME_ENTRY_NON_MONEY_ALLOWLIST.has(key)) continue;
      expect(out).not.toHaveProperty(key);
    }
  });
});

describe("stripTimeEntryBillRateForRole regression: payRateOverride is stripped like billRate (Task #785 bonus fix)", () => {
  const row = { id: "x", payRate: "30", billRate: "55", payRateOverride: "45", hoursWorked: "4" };

  it("strips payRateOverride for role=client alongside payRate/billRate", () => {
    const out = stripTimeEntryBillRateForRole("client", { ...row }) as Record<string, unknown>;
    expect(out.payRate).toBeUndefined();
    expect(out.billRate).toBeUndefined();
    expect(out.payRateOverride).toBeUndefined();
    expect(out.hoursWorked).toBe("4");
  });

  it("strips payRateOverride for non-admin staff alongside billRate", () => {
    const out = stripTimeEntryBillRateForRole("employee", { ...row }) as Record<string, unknown>;
    expect(out.billRate).toBeUndefined();
    expect(out.payRateOverride).toBeUndefined();
    expect(out.payRate).toBe("30");
    expect(out.hoursWorked).toBe("4");
  });

  it("keeps payRateOverride for admin/dispatcher", () => {
    const admin = stripTimeEntryBillRateForRole("admin", { ...row }) as Record<string, unknown>;
    expect(admin.payRateOverride).toBe("45");
    const dispatcher = stripTimeEntryBillRateForRole("dispatcher", { ...row }) as Record<string, unknown>;
    expect(dispatcher.payRateOverride).toBe("45");
  });
});
