import { describe, it, expect, beforeEach } from "vitest";
import {
  EMPTY_FILTERS,
  SHIFTS_FILTERS_STORAGE_KEY,
  SHIFTS_VIEW_STORAGE_KEY,
  loadStoredFilterState,
  loadStoredView,
  filtersAreDefault,
} from "../shared";

describe("loadStoredView", () => {
  beforeEach(() => localStorage.clear());

  it("returns null when nothing is stored", () => {
    expect(loadStoredView()).toBeNull();
  });

  it("returns the stored view when valid", () => {
    localStorage.setItem(SHIFTS_VIEW_STORAGE_KEY, "list");
    expect(loadStoredView()).toBe("list");
    localStorage.setItem(SHIFTS_VIEW_STORAGE_KEY, "calendar");
    expect(loadStoredView()).toBe("calendar");
  });

  it("drops an unknown/malformed view value to null", () => {
    localStorage.setItem(SHIFTS_VIEW_STORAGE_KEY, "kanban");
    expect(loadStoredView()).toBeNull();
    localStorage.setItem(SHIFTS_VIEW_STORAGE_KEY, "");
    expect(loadStoredView()).toBeNull();
  });
});

describe("loadStoredFilterState", () => {
  beforeEach(() => localStorage.clear());

  it("returns defaults when nothing is stored", () => {
    expect(loadStoredFilterState()).toEqual({
      filters: EMPTY_FILTERS,
      jumpDate: null,
    });
  });

  it("returns defaults and never throws on malformed JSON", () => {
    localStorage.setItem(SHIFTS_FILTERS_STORAGE_KEY, "{not valid json");
    expect(() => loadStoredFilterState()).not.toThrow();
    expect(loadStoredFilterState()).toEqual({
      filters: EMPTY_FILTERS,
      jumpDate: null,
    });
  });

  it("returns defaults when the stored payload is not an object", () => {
    localStorage.setItem(SHIFTS_FILTERS_STORAGE_KEY, JSON.stringify("nope"));
    expect(() => loadStoredFilterState()).not.toThrow();
    const state = loadStoredFilterState();
    expect(state.filters).toEqual(EMPTY_FILTERS);
    expect(state.jumpDate).toBeNull();
  });

  it("restores a valid persisted filter state", () => {
    localStorage.setItem(
      SHIFTS_FILTERS_STORAGE_KEY,
      JSON.stringify({
        filters: {
          search: "acme",
          siteId: "site-1",
          client: "Acme Corp",
          status: "active",
          staffing: "open",
        },
        jumpDate: "2026-07-25",
      }),
    );
    expect(loadStoredFilterState()).toEqual({
      filters: {
        search: "acme",
        siteId: "site-1",
        client: "Acme Corp",
        status: "active",
        staffing: "open",
      },
      jumpDate: "2026-07-25",
    });
  });

  it("drops an unknown status value to the default", () => {
    localStorage.setItem(
      SHIFTS_FILTERS_STORAGE_KEY,
      JSON.stringify({ filters: { status: "archived" } }),
    );
    expect(loadStoredFilterState().filters.status).toBe(EMPTY_FILTERS.status);
  });

  it("drops an unknown staffing value to the default", () => {
    localStorage.setItem(
      SHIFTS_FILTERS_STORAGE_KEY,
      JSON.stringify({ filters: { staffing: "overstaffed" } }),
    );
    expect(loadStoredFilterState().filters.staffing).toBe(
      EMPTY_FILTERS.staffing,
    );
  });

  it("coerces non-string scalar fields to their defaults", () => {
    localStorage.setItem(
      SHIFTS_FILTERS_STORAGE_KEY,
      JSON.stringify({
        filters: { search: 42, siteId: null, client: false },
        jumpDate: 12345,
      }),
    );
    const state = loadStoredFilterState();
    expect(state.filters.search).toBe(EMPTY_FILTERS.search);
    expect(state.filters.siteId).toBe(EMPTY_FILTERS.siteId);
    expect(state.filters.client).toBe(EMPTY_FILTERS.client);
    expect(state.jumpDate).toBeNull();
  });

  it("fills defaults when the filters key is missing entirely", () => {
    localStorage.setItem(
      SHIFTS_FILTERS_STORAGE_KEY,
      JSON.stringify({ jumpDate: "2026-01-01" }),
    );
    const state = loadStoredFilterState();
    expect(state.filters).toEqual(EMPTY_FILTERS);
    expect(state.jumpDate).toBe("2026-01-01");
  });
});

describe("filtersAreDefault", () => {
  it("is true for the empty defaults with no jump date", () => {
    expect(filtersAreDefault(EMPTY_FILTERS, null)).toBe(true);
  });

  it("is false when a jump date is set", () => {
    expect(filtersAreDefault(EMPTY_FILTERS, "2026-07-25")).toBe(false);
  });

  it("is false when any filter field is customized", () => {
    expect(filtersAreDefault({ ...EMPTY_FILTERS, search: "x" }, null)).toBe(false);
    expect(filtersAreDefault({ ...EMPTY_FILTERS, siteId: "s1" }, null)).toBe(false);
    expect(filtersAreDefault({ ...EMPTY_FILTERS, client: "c" }, null)).toBe(false);
    expect(filtersAreDefault({ ...EMPTY_FILTERS, status: "all" }, null)).toBe(false);
    expect(filtersAreDefault({ ...EMPTY_FILTERS, staffing: "open" }, null)).toBe(false);
  });
});
