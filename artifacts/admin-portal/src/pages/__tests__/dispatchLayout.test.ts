import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import {
  DEFAULT_LAYOUT,
  DEFAULT_PANEL_ORDER,
  PANEL_IDS,
  DRAG_PLACEHOLDER,
  dispatchLayoutKey,
  parseStoredLayout,
  useDispatchLayout,
  applyPanelReorder,
  buildColumnWithPlaceholder,
  type DispatchLayout,
  type PanelId,
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
      panelOrder: DEFAULT_PANEL_ORDER,
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

// ---------------------------------------------------------------------------
// applyPanelReorder — pure drag-drop reorder helper
// ---------------------------------------------------------------------------

describe("applyPanelReorder — before position", () => {
  const order: PanelId[] = ["incidents", "statusBoard", "shiftClaims", "openShifts"];

  it("moves a panel before the target (last → before second)", () => {
    const result = applyPanelReorder(order, "openShifts", "statusBoard", "before");
    expect(result).toEqual(["incidents", "openShifts", "statusBoard", "shiftClaims"]);
  });

  it("moves the first panel before the third", () => {
    const result = applyPanelReorder(order, "incidents", "shiftClaims", "before");
    expect(result).toEqual(["statusBoard", "incidents", "shiftClaims", "openShifts"]);
  });

  it("moves a middle panel before the first panel", () => {
    const result = applyPanelReorder(order, "shiftClaims", "incidents", "before");
    expect(result).toEqual(["shiftClaims", "incidents", "statusBoard", "openShifts"]);
  });
});

describe("applyPanelReorder — after position", () => {
  const order: PanelId[] = ["incidents", "statusBoard", "shiftClaims", "openShifts"];

  it("moves a panel after the target (first → after third)", () => {
    const result = applyPanelReorder(order, "incidents", "shiftClaims", "after");
    expect(result).toEqual(["statusBoard", "shiftClaims", "incidents", "openShifts"]);
  });

  it("moves the last panel after the first", () => {
    const result = applyPanelReorder(order, "openShifts", "incidents", "after");
    expect(result).toEqual(["incidents", "openShifts", "statusBoard", "shiftClaims"]);
  });

  it("moves a middle panel after the last panel", () => {
    const result = applyPanelReorder(order, "statusBoard", "openShifts", "after");
    expect(result).toEqual(["incidents", "shiftClaims", "openShifts", "statusBoard"]);
  });
});

describe("applyPanelReorder — edge cases", () => {
  const order: PanelId[] = ["incidents", "statusBoard", "shiftClaims", "openShifts"];

  it("returns original array when srcId is not found", () => {
    const result = applyPanelReorder(order, "liveMap", "incidents", "before");
    expect(result).toBe(order);
  });

  it("returns original array when targetId is not found after removal", () => {
    const result = applyPanelReorder(order, "incidents", "broadcast", "before");
    expect(result).toBe(order);
  });

  it("does not mutate the original array", () => {
    const original = [...order];
    applyPanelReorder(order, "openShifts", "incidents", "before");
    expect(order).toEqual(original);
  });

  it("two-panel array: move first before second is a no-op result when position=before", () => {
    const two: PanelId[] = ["incidents", "statusBoard"];
    const result = applyPanelReorder(two, "incidents", "statusBoard", "before");
    expect(result).toEqual(["incidents", "statusBoard"]);
  });

  it("two-panel array: swap with after", () => {
    const two: PanelId[] = ["incidents", "statusBoard"];
    const result = applyPanelReorder(two, "incidents", "statusBoard", "after");
    expect(result).toEqual(["statusBoard", "incidents"]);
  });
});

describe("applyPanelReorder — panelOrder round-trips through useDispatchLayout", () => {
  it("a reorder applied via setLayout persists to localStorage and reloads correctly", () => {
    const userId = "user-reorder-rt";
    const { result, unmount } = renderHook(() => useDispatchLayout(userId));

    act(() => {
      result.current[1]((prev) => ({
        ...prev,
        panelOrder: applyPanelReorder(prev.panelOrder, "openShifts", "incidents", "before"),
      }));
    });

    expect(result.current[0].panelOrder[0]).toBe("openShifts");
    expect(result.current[0].panelOrder[1]).toBe("incidents");

    unmount();

    const { result: result2 } = renderHook(() => useDispatchLayout(userId));
    expect(result2.current[0].panelOrder[0]).toBe("openShifts");
    expect(result2.current[0].panelOrder[1]).toBe("incidents");
  });
});

// ---------------------------------------------------------------------------
// buildColumnWithPlaceholder — placeholder slot helper
// ---------------------------------------------------------------------------

const LEFT_COLUMN: PanelId[] = ["incidents", "statusBoard", "shiftClaims", "openShifts"];
const RIGHT_COLUMN: PanelId[] = ["liveMap", "broadcast"];

describe("buildColumnWithPlaceholder — no placeholder cases", () => {
  it("returns visible unchanged when insert is null (no drag in progress)", () => {
    const visible: PanelId[] = ["incidents", "statusBoard", "shiftClaims"];
    const result = buildColumnWithPlaceholder(visible, null, null, LEFT_COLUMN);
    expect(result).toBe(visible);
  });

  it("returns visible unchanged when srcId is null", () => {
    const visible: PanelId[] = ["incidents", "statusBoard"];
    const result = buildColumnWithPlaceholder(
      visible,
      null,
      { overId: "statusBoard", position: "before" },
      LEFT_COLUMN,
    );
    expect(result).toBe(visible);
  });

  it("returns visible unchanged when the hovered panel is in a different column (cross-column drag)", () => {
    const visible: PanelId[] = ["incidents", "statusBoard"];
    const result = buildColumnWithPlaceholder(
      visible,
      "incidents",
      { overId: "liveMap", position: "before" },
      LEFT_COLUMN,
    );
    expect(result).toBe(visible);
  });

  it("returns visible unchanged when the source panel is in a different column (cross-column drag)", () => {
    const visible: PanelId[] = ["incidents", "statusBoard"];
    const result = buildColumnWithPlaceholder(
      visible,
      "liveMap",
      { overId: "statusBoard", position: "before" },
      LEFT_COLUMN,
    );
    expect(result).toBe(visible);
  });

  it("does not include the placeholder sentinel when no drag is active", () => {
    const visible: PanelId[] = ["incidents", "statusBoard", "shiftClaims"];
    const slots = buildColumnWithPlaceholder(visible, null, null, LEFT_COLUMN);
    expect(slots.includes(DRAG_PLACEHOLDER)).toBe(false);
  });
});

describe("buildColumnWithPlaceholder — before position", () => {
  it("inserts placeholder before the hovered panel", () => {
    const visible: PanelId[] = ["incidents", "statusBoard", "shiftClaims"];
    const slots = buildColumnWithPlaceholder(
      visible,
      "shiftClaims",
      { overId: "statusBoard", position: "before" },
      LEFT_COLUMN,
    );
    expect(slots).toEqual([
      "incidents",
      DRAG_PLACEHOLDER,
      "statusBoard",
      "shiftClaims",
    ]);
  });

  it("inserts placeholder before the first panel", () => {
    const visible: PanelId[] = ["incidents", "statusBoard", "shiftClaims"];
    const slots = buildColumnWithPlaceholder(
      visible,
      "shiftClaims",
      { overId: "incidents", position: "before" },
      LEFT_COLUMN,
    );
    expect(slots[0]).toBe(DRAG_PLACEHOLDER);
    expect(slots[1]).toBe("incidents");
  });

  it("contains exactly one placeholder in the output", () => {
    const visible: PanelId[] = ["incidents", "statusBoard", "shiftClaims", "openShifts"];
    const slots = buildColumnWithPlaceholder(
      visible,
      "openShifts",
      { overId: "shiftClaims", position: "before" },
      LEFT_COLUMN,
    );
    expect(slots.filter((s) => s === DRAG_PLACEHOLDER).length).toBe(1);
  });
});

describe("buildColumnWithPlaceholder — after position", () => {
  it("inserts placeholder after the hovered panel", () => {
    const visible: PanelId[] = ["incidents", "statusBoard", "shiftClaims"];
    const slots = buildColumnWithPlaceholder(
      visible,
      "incidents",
      { overId: "statusBoard", position: "after" },
      LEFT_COLUMN,
    );
    expect(slots).toEqual([
      "incidents",
      "statusBoard",
      DRAG_PLACEHOLDER,
      "shiftClaims",
    ]);
  });

  it("inserts placeholder after the last panel", () => {
    const visible: PanelId[] = ["incidents", "statusBoard", "shiftClaims"];
    const slots = buildColumnWithPlaceholder(
      visible,
      "incidents",
      { overId: "shiftClaims", position: "after" },
      LEFT_COLUMN,
    );
    expect(slots[slots.length - 1]).toBe(DRAG_PLACEHOLDER);
  });

  it("all non-placeholder slots are the original visible panel IDs in order", () => {
    const visible: PanelId[] = ["incidents", "statusBoard", "shiftClaims"];
    const slots = buildColumnWithPlaceholder(
      visible,
      "shiftClaims",
      { overId: "incidents", position: "after" },
      LEFT_COLUMN,
    );
    const panels = slots.filter((s) => s !== DRAG_PLACEHOLDER);
    expect(panels).toEqual(visible);
  });
});

describe("buildColumnWithPlaceholder — placeholder absent after drop (insert reset to null)", () => {
  it("returns panel IDs only (no placeholder) once insert is cleared", () => {
    const visible: PanelId[] = ["incidents", "statusBoard", "shiftClaims"];

    const duringSlotsWithPlaceholder = buildColumnWithPlaceholder(
      visible,
      "shiftClaims",
      { overId: "statusBoard", position: "before" },
      LEFT_COLUMN,
    );
    expect(duringSlotsWithPlaceholder.includes(DRAG_PLACEHOLDER)).toBe(true);

    const afterDropSlots = buildColumnWithPlaceholder(visible, null, null, LEFT_COLUMN);
    expect(afterDropSlots.includes(DRAG_PLACEHOLDER)).toBe(false);
    expect(afterDropSlots).toBe(visible);
  });
});

describe("buildColumnWithPlaceholder — right column", () => {
  it("works correctly for the right column panels", () => {
    const visible: PanelId[] = ["liveMap", "broadcast"];
    const slots = buildColumnWithPlaceholder(
      visible,
      "broadcast",
      { overId: "liveMap", position: "before" },
      RIGHT_COLUMN,
    );
    expect(slots).toEqual([DRAG_PLACEHOLDER, "liveMap", "broadcast"]);
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
