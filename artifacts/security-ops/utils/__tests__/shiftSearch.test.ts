import { describe, expect, it } from "vitest";
import {
  buildShiftSearchText,
  filterShiftsBySearch,
  matchesSearchTokens,
  tokenizeQuery,
  type SearchableShift,
} from "../shiftSearch";

const levelLabel = (lvl: number | null | undefined) =>
  lvl === 1 ? "Support" : lvl === 2 ? "Unarmed" : lvl === 3 ? "Armed" : "Unknown";

function shift(overrides: Partial<SearchableShift> = {}): SearchableShift {
  return {
    title: "Night Patrol",
    clientName: "Acme Logistics",
    location: "1200 Commerce St, Dallas TX",
    notes: "Bring a torch",
    // Constructed from local parts so the weekday assertions hold in any timezone.
    startTime: new Date(2026, 2, 6, 20, 0, 0).toISOString(), // Fri 6 March 2026
    requiredLicenseLevel: 2,
    ...overrides,
  };
}

describe("tokenizeQuery", () => {
  it("returns no tokens for empty or whitespace-only input", () => {
    expect(tokenizeQuery("")).toEqual([]);
    expect(tokenizeQuery("   ")).toEqual([]);
    expect(tokenizeQuery(null)).toEqual([]);
    expect(tokenizeQuery(undefined)).toEqual([]);
  });

  it("lowercases and collapses runs of whitespace", () => {
    expect(tokenizeQuery("  Night   DALLAS ")).toEqual(["night", "dallas"]);
  });
});

describe("matchesSearchTokens", () => {
  it("matches everything when there are no tokens", () => {
    expect(matchesSearchTokens("anything", [])).toBe(true);
  });

  it("requires every token to be present (AND, not OR)", () => {
    expect(matchesSearchTokens("night patrol dallas", ["night", "dallas"])).toBe(true);
    expect(matchesSearchTokens("night patrol dallas", ["night", "houston"])).toBe(false);
  });
});

describe("buildShiftSearchText", () => {
  it("includes the fields an officer can see on the card", () => {
    const text = buildShiftSearchText(shift(), levelLabel);
    expect(text).toContain("night patrol");
    expect(text).toContain("acme logistics");
    expect(text).toContain("commerce st");
    expect(text).toContain("bring a torch");
    expect(text).toContain("unarmed");
    expect(text).toContain("level 2");
  });

  it("includes weekday and month names from the start time", () => {
    const text = buildShiftSearchText(shift(), levelLabel);
    expect(text).toContain("friday");
    expect(text).toContain("march");
  });

  it("tolerates missing and null fields without throwing", () => {
    expect(() =>
      buildShiftSearchText({
        title: null,
        clientName: undefined,
        location: null,
        notes: null,
        startTime: null,
        requiredLicenseLevel: null,
      }, levelLabel),
    ).not.toThrow();
    expect(buildShiftSearchText({}, levelLabel)).toBe("");
  });

  it("ignores an unparseable start time instead of emitting NaN text", () => {
    const text = buildShiftSearchText({ title: "Gate", startTime: "not-a-date" }, levelLabel);
    expect(text).toBe("gate");
    expect(text).not.toContain("nan");
  });
});

describe("filterShiftsBySearch", () => {
  const shifts = [
    shift({ title: "Night Patrol", clientName: "Acme Logistics", location: "Dallas TX" }),
    shift({ title: "Front Desk", clientName: "Bellweather Tower", location: "Houston TX", notes: null }),
    shift({ title: "Event Security", clientName: "Acme Logistics", location: "Austin TX", requiredLicenseLevel: 3 }),
  ];

  it("returns the list untouched when nothing has been typed", () => {
    expect(filterShiftsBySearch(shifts, "", levelLabel)).toHaveLength(3);
    expect(filterShiftsBySearch(shifts, "   ", levelLabel)).toHaveLength(3);
  });

  it("matches on title regardless of case", () => {
    const found = filterShiftsBySearch(shifts, "FRONT desk", levelLabel);
    expect(found.map((s) => s.title)).toEqual(["Front Desk"]);
  });

  it("matches on client name", () => {
    expect(filterShiftsBySearch(shifts, "bellweather", levelLabel)).toHaveLength(1);
  });

  it("matches on location", () => {
    const found = filterShiftsBySearch(shifts, "austin", levelLabel);
    expect(found.map((s) => s.title)).toEqual(["Event Security"]);
  });

  it("narrows across different fields with multiple words", () => {
    const found = filterShiftsBySearch(shifts, "acme austin", levelLabel);
    expect(found.map((s) => s.title)).toEqual(["Event Security"]);
  });

  it("matches on the licence level label", () => {
    const found = filterShiftsBySearch(shifts, "armed", levelLabel);
    // "unarmed" contains "armed", so both licensed levels legitimately match.
    expect(found.map((s) => s.title)).toContain("Event Security");
  });

  it("returns an empty list when nothing matches", () => {
    expect(filterShiftsBySearch(shifts, "zzzz", levelLabel)).toEqual([]);
  });

  it("works without a levelLabel resolver", () => {
    expect(filterShiftsBySearch(shifts, "houston")).toHaveLength(1);
  });
});
