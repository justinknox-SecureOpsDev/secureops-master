import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import {
  DEFAULT_LAYOUT,
  PANEL_IDS,
  dispatchLayoutKey,
  parseStoredLayout,
  useDispatchLayout,
  type DispatchLayout,
} from "../dispatchLayout";

/**
 * Unit tests for useDispatchLayout.
 *
 * Verifies that dispatch layout customisation (panel visibility, column split,
 * map state) survives page reload by round-tripping correctly through
 * localStorage, and that separate users carry independent layout state so an
 * org switch does not bleed one user's preferences into another's.
 */

function clearDispatchStorage() {
  const keysToRemove: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith("wcsg.dispatch.layout.")) keysToRemove.push(k);
  }
  keysToRemove.forEach((k) => localStorage.removeItem(k));
}

beforeEach(() => {
  clearDispatchStorage();
});

afterEach(() => {
  clearDispatchStorage();
});

// ---------------------------------------------------------------------------
// parseStoredLayout — pure helper, no React needed
// ---------------------------------------------------------------------------

describe("parseStoredLayout", () => {
  it("merges stored panels over defaults, keeping unmentioned panels at their default", () => {
    const raw = JSON.stringify({ panels: { incidents: false } });
    const result = parseStoredLayout(raw);
    expect(result.panels.incidents).toBe(false);
    expect(result.panels.statusBoard).toBe(DEFAULT_LAYOUT.panels.statusBoard);
    expect(result.panels.liveMap).toBe(DEFAULT_LAYOUT.panels.liveMap);
  });

  it("clamps columnSplit below 20 up to 20", () => {
    const raw = JSON.stringify({ columnSplit: 5 });
    expect(parseStoredLayout(raw).columnSplit).toBe(20);
  });

  it("clamps columnSplit above 80 down to 80", () => {
    const raw = JSON.stringify({ columnSplit: 95 });
    expect(parseStoredLayout(raw).columnSplit).toBe(80);
  });

  it("accepts a valid columnSplit within [20, 80] unchanged", () => {
    const raw = JSON.stringify({ columnSplit: 50 });
    expect(parseStoredLayout(raw).columnSplit).toBe(50);
  });

  it("falls back to default columnSplit when the stored value is not a number", () => {
    const raw = JSON.stringify({ columnSplit: "wide" });
    expect(parseStoredLayout(raw).columnSplit).toBe(DEFAULT_LAYOUT.columnSplit);
  });

  it("reads mapExpanded correctly", () => {
    expect(parseStoredLayout(JSON.stringify({ mapExpanded: true })).mapExpanded).toBe(true);
    expect(parseStoredLayout(JSON.stringify({ mapExpanded: false })).mapExpanded).toBe(false);
  });

  it("falls back to default mapExpanded when the stored value is not a boolean", () => {
    const raw = JSON.stringify({ mapExpanded: "yes" });
    expect(parseStoredLayout(raw).mapExpanded).toBe(DEFAULT_LAYOUT.mapExpanded);
  });

  it("accepts satellite tile layer", () => {
    const raw = JSON.stringify({ mapTileLayer: "satellite" });
    expect(parseStoredLayout(raw).mapTileLayer).toBe("satellite");
  });

  it("normalises any non-satellite mapTileLayer to street", () => {
    expect(parseStoredLayout(JSON.stringify({ mapTileLayer: "hybrid" })).mapTileLayer).toBe("street");
    expect(parseStoredLayout(JSON.stringify({})).mapTileLayer).toBe("street");
  });
});

// ---------------------------------------------------------------------------
// useDispatchLayout — React hook
// ---------------------------------------------------------------------------

describe("useDispatchLayout — defaults", () => {
  it("returns DEFAULT_LAYOUT when no storage entry exists for the user", () => {
    const { result } = renderHook(() => useDispatchLayout("user-1"));
    const [layout] = result.current;
    expect(layout).toEqual(DEFAULT_LAYOUT);
  });

  it("returns DEFAULT_LAYOUT when userId is undefined (pre-auth state)", () => {
    const { result } = renderHook(() => useDispatchLayout(undefined));
    const [layout] = result.current;
    expect(layout).toEqual(DEFAULT_LAYOUT);
  });

  it("exposes all PANEL_IDS in the panels map", () => {
    const { result } = renderHook(() => useDispatchLayout("user-1"));
    const [layout] = result.current;
    PANEL_IDS.forEach((id) => {
      expect(id in layout.panels).toBe(true);
    });
  });
});

describe("useDispatchLayout — hydration from localStorage", () => {
  it("loads a stored layout on mount (simulates page reload)", () => {
    const stored: DispatchLayout = {
      panels: {
        incidents: false,
        statusBoard: true,
        shiftClaims: false,
        openShifts: true,
        liveMap: false,
        broadcast: true,
      },
      columnSplit: 55,
      mapExpanded: true,
      mapTileLayer: "satellite",
    };
    localStorage.setItem(dispatchLayoutKey("user-reload"), JSON.stringify(stored));

    const { result } = renderHook(() => useDispatchLayout("user-reload"));
    const [layout] = result.current;

    expect(layout.panels.incidents).toBe(false);
    expect(layout.panels.shiftClaims).toBe(false);
    expect(layout.columnSplit).toBe(55);
    expect(layout.mapExpanded).toBe(true);
    expect(layout.mapTileLayer).toBe("satellite");
  });

  it("fills in missing panels from defaults when the stored object is partial", () => {
    localStorage.setItem(
      dispatchLayoutKey("user-partial"),
      JSON.stringify({ panels: { incidents: false } }),
    );
    const { result } = renderHook(() => useDispatchLayout("user-partial"));
    const [layout] = result.current;

    expect(layout.panels.incidents).toBe(false);
    expect(layout.panels.statusBoard).toBe(true);
    expect(layout.panels.liveMap).toBe(true);
  });

  it("clamps a stored columnSplit of 10 to 20 on load", () => {
    localStorage.setItem(
      dispatchLayoutKey("user-clamp-lo"),
      JSON.stringify({ columnSplit: 10 }),
    );
    const { result } = renderHook(() => useDispatchLayout("user-clamp-lo"));
    expect(result.current[0].columnSplit).toBe(20);
  });

  it("clamps a stored columnSplit of 90 to 80 on load", () => {
    localStorage.setItem(
      dispatchLayoutKey("user-clamp-hi"),
      JSON.stringify({ columnSplit: 90 }),
    );
    const { result } = renderHook(() => useDispatchLayout("user-clamp-hi"));
    expect(result.current[0].columnSplit).toBe(80);
  });

  it("returns DEFAULT_LAYOUT when the stored JSON is malformed", () => {
    localStorage.setItem(dispatchLayoutKey("user-bad-json"), "not-json{{");
    const { result } = renderHook(() => useDispatchLayout("user-bad-json"));
    expect(result.current[0]).toEqual(DEFAULT_LAYOUT);
  });
});

describe("useDispatchLayout — writes / round-trip", () => {
  it("persists a panel toggle to localStorage immediately", () => {
    const { result } = renderHook(() => useDispatchLayout("user-write"));

    act(() => {
      result.current[1]((prev) => ({
        ...prev,
        panels: { ...prev.panels, incidents: false },
      }));
    });

    expect(result.current[0].panels.incidents).toBe(false);

    const stored = JSON.parse(localStorage.getItem(dispatchLayoutKey("user-write"))!);
    expect(stored.panels.incidents).toBe(false);
  });

  it("persists columnSplit to localStorage", () => {
    const { result } = renderHook(() => useDispatchLayout("user-split"));

    act(() => {
      result.current[1]((prev) => ({ ...prev, columnSplit: 40 }));
    });

    const stored = JSON.parse(localStorage.getItem(dispatchLayoutKey("user-split"))!);
    expect(stored.columnSplit).toBe(40);
  });

  it("round-trips the full layout without data loss", () => {
    const userId = "user-roundtrip";
    const { result, unmount } = renderHook(() => useDispatchLayout(userId));

    const updated: DispatchLayout = {
      panels: {
        incidents: false,
        statusBoard: true,
        shiftClaims: false,
        openShifts: true,
        liveMap: false,
        broadcast: true,
      },
      columnSplit: 33,
      mapExpanded: true,
      mapTileLayer: "satellite",
    };

    act(() => {
      result.current[1](() => updated);
    });

    unmount();

    const { result: result2 } = renderHook(() => useDispatchLayout(userId));
    expect(result2.current[0]).toEqual(updated);
  });

  it("does not write to localStorage when userId is undefined", () => {
    const before = localStorage.length;
    const { result } = renderHook(() => useDispatchLayout(undefined));

    act(() => {
      result.current[1]((prev) => ({ ...prev, mapExpanded: true }));
    });

    expect(localStorage.length).toBe(before);
  });
});

describe("useDispatchLayout — user isolation (org switch)", () => {
  it("loads the correct layout for each user ID independently", () => {
    const layoutA: DispatchLayout = {
      ...DEFAULT_LAYOUT,
      columnSplit: 30,
      mapExpanded: true,
    };
    const layoutB: DispatchLayout = {
      ...DEFAULT_LAYOUT,
      columnSplit: 70,
      mapExpanded: false,
    };

    localStorage.setItem(dispatchLayoutKey("user-a"), JSON.stringify(layoutA));
    localStorage.setItem(dispatchLayoutKey("user-b"), JSON.stringify(layoutB));

    const { result: resultA } = renderHook(() => useDispatchLayout("user-a"));
    const { result: resultB } = renderHook(() => useDispatchLayout("user-b"));

    expect(resultA.current[0].columnSplit).toBe(30);
    expect(resultA.current[0].mapExpanded).toBe(true);

    expect(resultB.current[0].columnSplit).toBe(70);
    expect(resultB.current[0].mapExpanded).toBe(false);
  });

  it("a write for user-a does not affect user-b's storage key", () => {
    const { result: resultA } = renderHook(() => useDispatchLayout("user-a"));

    act(() => {
      resultA.current[1]((prev) => ({ ...prev, columnSplit: 25 }));
    });

    expect(localStorage.getItem(dispatchLayoutKey("user-b"))).toBeNull();
  });

  it("switching from user-a to user-b (remount with new id) loads user-b's own stored layout", () => {
    const layoutB: DispatchLayout = {
      ...DEFAULT_LAYOUT,
      columnSplit: 60,
      panels: { ...DEFAULT_LAYOUT.panels, broadcast: false },
    };
    localStorage.setItem(dispatchLayoutKey("user-b"), JSON.stringify(layoutB));

    // Simulate org switch: unmount old user's hook, mount new user's hook
    const { unmount: unmountA } = renderHook(() => useDispatchLayout("user-a"));
    unmountA();

    const { result: resultB } = renderHook(() => useDispatchLayout("user-b"));
    expect(resultB.current[0].columnSplit).toBe(60);
    expect(resultB.current[0].panels.broadcast).toBe(false);
  });
});
