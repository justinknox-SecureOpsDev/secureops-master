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
  buildWithPlaceholder,
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

  it("accepts columns=1", () => {
    const raw = JSON.stringify({ columns: 1 });
    expect(parseStoredLayout(raw).columns).toBe(1);
  });

  it("accepts columns=3", () => {
    const raw = JSON.stringify({ columns: 3 });
    expect(parseStoredLayout(raw).columns).toBe(3);
  });

  it("accepts columns=2 (default value)", () => {
    const raw = JSON.stringify({ columns: 2 });
    expect(parseStoredLayout(raw).columns).toBe(2);
  });

  it("falls back to default columns when the stored value is unrecognized", () => {
    const raw = JSON.stringify({ columns: "wide" });
    expect(parseStoredLayout(raw).columns).toBe(DEFAULT_LAYOUT.columns);
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
      columns: 3,
      mapExpanded: true,
      mapTileLayer: "satellite",
      panelOrder: DEFAULT_PANEL_ORDER,
    };
    localStorage.setItem(dispatchLayoutKey("user-reload"), JSON.stringify(stored));

    const { result } = renderHook(() => useDispatchLayout("user-reload"));
    const [layout] = result.current;

    expect(layout.panels.incidents).toBe(false);
    expect(layout.panels.shiftClaims).toBe(false);
    expect(layout.columns).toBe(3);
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

  it("loads columns=1 from storage", () => {
    localStorage.setItem(
      dispatchLayoutKey("user-col-1"),
      JSON.stringify({ columns: 1 }),
    );
    const { result } = renderHook(() => useDispatchLayout("user-col-1"));
    expect(result.current[0].columns).toBe(1);
  });

  it("loads columns=3 from storage", () => {
    localStorage.setItem(
      dispatchLayoutKey("user-col-3"),
      JSON.stringify({ columns: 3 }),
    );
    const { result } = renderHook(() => useDispatchLayout("user-col-3"));
    expect(result.current[0].columns).toBe(3);
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

  it("persists columns to localStorage", () => {
    const { result } = renderHook(() => useDispatchLayout("user-split"));

    act(() => {
      result.current[1]((prev) => ({ ...prev, columns: 3 }));
    });

    const stored = JSON.parse(localStorage.getItem(dispatchLayoutKey("user-split"))!);
    expect(stored.columns).toBe(3);
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
      columns: 3,
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

  it("returns visible unchanged when overId is not present in visible (hidden panel hover)", () => {
    // liveMap is not in visible — overId not found, so no placeholder is emitted
    const visible: PanelId[] = ["incidents", "statusBoard"];
    const result = buildColumnWithPlaceholder(
      visible,
      "incidents",
      { overId: "liveMap", position: "before" },
      LEFT_COLUMN,
    );
    expect(result).toBe(visible);
  });

  it("shows a placeholder when srcId is not in visible but overId is (free drag across positions)", () => {
    // Any non-null srcId + valid overId triggers a placeholder — column membership is irrelevant
    const visible: PanelId[] = ["incidents", "statusBoard"];
    const slots = buildColumnWithPlaceholder(
      visible,
      "liveMap",
      { overId: "statusBoard", position: "before" },
      LEFT_COLUMN,
    );
    expect(slots.includes(DRAG_PLACEHOLDER)).toBe(true);
    const phIdx = slots.indexOf(DRAG_PLACEHOLDER);
    const sbIdx = slots.indexOf("statusBoard");
    expect(phIdx).toBe(sbIdx - 1);
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

// ---------------------------------------------------------------------------
// Drag cancel / drag-end — placeholder must not linger after a mid-flight cancel
//
// When a dispatcher presses Escape or releases the mouse outside a valid drop
// zone, the drag state resets: dragInsert → null and/or dragSrcRef → null.
// buildColumnWithPlaceholder must return the original visible array (same
// reference, no DRAG_PLACEHOLDER) in both cancel paths.
// ---------------------------------------------------------------------------

describe("buildColumnWithPlaceholder — drag cancel / drag-end clears placeholder", () => {
  it("returns the original visible array (same reference) when insert is reset to null after an active drag", () => {
    const visible: PanelId[] = ["incidents", "statusBoard", "shiftClaims", "openShifts"];

    const duringSlotsWithPlaceholder = buildColumnWithPlaceholder(
      visible,
      "openShifts",
      { overId: "statusBoard", position: "before" },
      LEFT_COLUMN,
    );
    expect(duringSlotsWithPlaceholder.includes(DRAG_PLACEHOLDER)).toBe(true);

    const afterCancelSlots = buildColumnWithPlaceholder(visible, "openShifts", null, LEFT_COLUMN);
    expect(afterCancelSlots).toBe(visible);
    expect(afterCancelSlots.includes(DRAG_PLACEHOLDER)).toBe(false);
  });

  it("returns the original visible array (same reference) when srcId is reset to null (dragend fired without a drop)", () => {
    const visible: PanelId[] = ["incidents", "statusBoard", "shiftClaims", "openShifts"];

    const duringSlotsWithPlaceholder = buildColumnWithPlaceholder(
      visible,
      "openShifts",
      { overId: "shiftClaims", position: "after" },
      LEFT_COLUMN,
    );
    expect(duringSlotsWithPlaceholder.includes(DRAG_PLACEHOLDER)).toBe(true);

    const afterDragEndSlots = buildColumnWithPlaceholder(
      visible,
      null,
      { overId: "shiftClaims", position: "after" },
      LEFT_COLUMN,
    );
    expect(afterDragEndSlots).toBe(visible);
    expect(afterDragEndSlots.includes(DRAG_PLACEHOLDER)).toBe(false);
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

// ---------------------------------------------------------------------------
// Structural integrity — guards against a new PanelId being added without
// updating DEFAULT_PANEL_ORDER or column membership lists.
// ---------------------------------------------------------------------------

describe("PANEL_IDS structural integrity", () => {
  it("DEFAULT_PANEL_ORDER contains every PANEL_IDS entry exactly once", () => {
    for (const id of PANEL_IDS) {
      const count = DEFAULT_PANEL_ORDER.filter((p) => p === id).length;
      expect(count, `"${id}" must appear exactly once in DEFAULT_PANEL_ORDER, found ${count}`).toBe(1);
    }

    expect(
      DEFAULT_PANEL_ORDER.length,
      "DEFAULT_PANEL_ORDER must contain no extra entries beyond PANEL_IDS",
    ).toBe(PANEL_IDS.length);
  });

  it("DEFAULT_LAYOUT.columns is a valid column count (1, 2, or 3)", () => {
    expect([1, 2, 3]).toContain(DEFAULT_LAYOUT.columns);
  });
});

// ---------------------------------------------------------------------------
// Free drag — any panel can be dragged over any other panel
//
// There is no column-membership guard.  buildWithPlaceholder shows a
// placeholder whenever srcId is set and overId is present in visible,
// regardless of where the two panels happened to appear on screen.
// ---------------------------------------------------------------------------

describe("buildWithPlaceholder — any panel can be dragged over any other panel", () => {
  it("shows placeholder before 'liveMap' when 'incidents' is dragged over it", () => {
    const visible: PanelId[] = ["incidents", "statusBoard", "liveMap", "broadcast"];
    const slots = buildWithPlaceholder(
      visible,
      "incidents",
      { overId: "liveMap", position: "before" },
    );
    expect(slots.includes(DRAG_PLACEHOLDER)).toBe(true);
    const phIdx = slots.indexOf(DRAG_PLACEHOLDER);
    const mapIdx = slots.indexOf("liveMap");
    expect(phIdx).toBe(mapIdx - 1);
  });

  it("shows placeholder after 'statusBoard' when 'broadcast' is dragged over it", () => {
    const visible: PanelId[] = ["incidents", "statusBoard", "liveMap", "broadcast"];
    const slots = buildWithPlaceholder(
      visible,
      "broadcast",
      { overId: "statusBoard", position: "after" },
    );
    expect(slots.includes(DRAG_PLACEHOLDER)).toBe(true);
    const phIdx = slots.indexOf(DRAG_PLACEHOLDER);
    const sbIdx = slots.indexOf("statusBoard");
    expect(phIdx).toBe(sbIdx + 1);
  });

  it("shows placeholder before 'incidents' when 'liveMap' is dragged over it", () => {
    const visible: PanelId[] = ["incidents", "shiftClaims", "openShifts", "liveMap"];
    const slots = buildWithPlaceholder(
      visible,
      "liveMap",
      { overId: "incidents", position: "before" },
    );
    expect(slots[0]).toBe(DRAG_PLACEHOLDER);
    expect(slots[1]).toBe("incidents");
  });

  it("contains exactly one placeholder regardless of which pair of panels is involved", () => {
    const visible: PanelId[] = ["incidents", "statusBoard", "shiftClaims", "openShifts", "liveMap", "broadcast"];
    const slots = buildWithPlaceholder(
      visible,
      "broadcast",
      { overId: "incidents", position: "after" },
    );
    expect(slots.filter((s) => s === DRAG_PLACEHOLDER).length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Free drop — applyPanelReorder works across all panel pairs
//
// With no column-membership guard, any src+target combination is valid.
// ---------------------------------------------------------------------------

describe("applyPanelReorder — any panel can be reordered to any position", () => {
  const fullOrder: PanelId[] = [
    "incidents",
    "statusBoard",
    "shiftClaims",
    "openShifts",
    "liveMap",
    "broadcast",
  ];

  it("moves 'incidents' before 'liveMap' (first to middle-right position)", () => {
    const result = applyPanelReorder(fullOrder, "incidents", "liveMap", "before");
    expect(result).not.toBe(fullOrder);
    const liveIdx = result.indexOf("liveMap");
    expect(result[liveIdx - 1]).toBe("incidents");
  });

  it("moves 'broadcast' before 'shiftClaims' (last to early position)", () => {
    const result = applyPanelReorder(fullOrder, "broadcast", "shiftClaims", "before");
    expect(result).not.toBe(fullOrder);
    const scIdx = result.indexOf("shiftClaims");
    expect(result[scIdx - 1]).toBe("broadcast");
  });

  it("moves 'liveMap' after 'incidents' (right-side panel to first position)", () => {
    const result = applyPanelReorder(fullOrder, "liveMap", "incidents", "after");
    expect(result).not.toBe(fullOrder);
    expect(result[0]).toBe("incidents");
    expect(result[1]).toBe("liveMap");
  });

  it("moves 'openShifts' before 'incidents' (reorder across what were previously columns)", () => {
    const result = applyPanelReorder(fullOrder, "openShifts", "incidents", "before");
    expect(result[0]).toBe("openShifts");
    expect(result[1]).toBe("incidents");
    // All 6 panels still present
    expect(result).toHaveLength(6);
    expect([...result].sort()).toEqual([...fullOrder].sort());
  });
});

// ---------------------------------------------------------------------------
// Hidden-panel visibility — visible is a strict subset of columnSet
//
// When some panels are toggled off, `visible` is a subset of `columnSet`.
// `buildColumnWithPlaceholder` must insert the placeholder only among the
// visible slots and must never emit hidden panel IDs or silently skip a drop
// because the hovered panel is absent from the rendered column.
// ---------------------------------------------------------------------------

describe("buildColumnWithPlaceholder — visible is a strict subset of columnSet (panels hidden)", () => {
  it("inserts placeholder before a visible panel even when other left-column panels are hidden", () => {
    // statusBoard and openShifts are hidden; only incidents and shiftClaims are visible
    const visible: PanelId[] = ["incidents", "shiftClaims"];
    const slots = buildColumnWithPlaceholder(
      visible,
      "shiftClaims",
      { overId: "incidents", position: "before" },
      LEFT_COLUMN,
    );
    expect(slots).toEqual([DRAG_PLACEHOLDER, "incidents", "shiftClaims"]);
    // Hidden panel IDs must never appear in the output
    expect(slots).not.toContain("statusBoard" as PanelId);
    expect(slots).not.toContain("openShifts" as PanelId);
  });

  it("inserts placeholder after a visible panel even when a hidden panel exists in the column", () => {
    // openShifts is hidden; incidents, statusBoard, shiftClaims are visible
    const visible: PanelId[] = ["incidents", "statusBoard", "shiftClaims"];
    const slots = buildColumnWithPlaceholder(
      visible,
      "incidents",
      { overId: "shiftClaims", position: "after" },
      LEFT_COLUMN,
    );
    expect(slots).toEqual(["incidents", "statusBoard", "shiftClaims", DRAG_PLACEHOLDER]);
    expect(slots).not.toContain("openShifts" as PanelId);
  });

  it("produces no placeholder when overId is a hidden panel (not present in visible)", () => {
    // statusBoard is hidden — hovering its position would emit no visible overId,
    // but if a stale overId arrived for a hidden panel the result must be placeholder-free
    const visible: PanelId[] = ["incidents", "shiftClaims", "openShifts"];
    const slots = buildColumnWithPlaceholder(
      visible,
      "incidents",
      { overId: "statusBoard", position: "after" },
      LEFT_COLUMN,
    );
    expect(slots.includes(DRAG_PLACEHOLDER)).toBe(false);
    // The visible panels are still rendered in their original order
    const panelSlots = slots.filter((s) => s !== DRAG_PLACEHOLDER);
    expect(panelSlots).toEqual(visible);
  });
});

// ---------------------------------------------------------------------------
// applyPanelReorder with hidden panels in full panelOrder
//
// Hidden panels stay in `panelOrder` even when they are off.  Reordering
// among visible panels must never drop or duplicate hidden panel IDs — when
// a panel is re-enabled it must appear in the correct relative position.
// ---------------------------------------------------------------------------

describe("applyPanelReorder — full panelOrder preserved when some panels are hidden", () => {
  it("all panels (including hidden) remain after a visible-panel reorder — no panels lost or duplicated", () => {
    // statusBoard and openShifts are "hidden" but still part of panelOrder
    const fullOrder: PanelId[] = [
      "incidents",
      "statusBoard",
      "shiftClaims",
      "openShifts",
      "liveMap",
      "broadcast",
    ];
    // Drag visible panel "shiftClaims" before visible panel "incidents"
    const result = applyPanelReorder(fullOrder, "shiftClaims", "incidents", "before");
    // Result is a permutation of all 6 panels — no panel lost, none duplicated
    expect(result).toHaveLength(6);
    expect([...result].sort()).toEqual([...fullOrder].sort());
    // Hidden panels explicitly present
    expect(result).toContain("statusBoard" as PanelId);
    expect(result).toContain("openShifts" as PanelId);
  });

  it("re-enabling a hidden panel after a reorder places it directly adjacent to its updated neighbour", () => {
    // Initial full order: incidents, statusBoard (hidden), shiftClaims, openShifts, liveMap, broadcast
    const fullOrder: PanelId[] = [
      "incidents",
      "statusBoard",
      "shiftClaims",
      "openShifts",
      "liveMap",
      "broadcast",
    ];
    // Among visible left panels, drag "shiftClaims" before "incidents"
    // Expected result: [shiftClaims, incidents, statusBoard, openShifts, liveMap, broadcast]
    const reordered = applyPanelReorder(fullOrder, "shiftClaims", "incidents", "before");
    expect(reordered[0]).toBe("shiftClaims");
    expect(reordered[1]).toBe("incidents");
    // statusBoard was between incidents and shiftClaims in the original order; after the
    // reorder it lands at index 2, directly adjacent to incidents at index 1.
    // Enforcing strict adjacency (not just "somewhere after") confirms re-enabling it
    // shows it immediately after incidents, not floating elsewhere.
    const incidentsIdx = reordered.indexOf("incidents");
    const statusBoardIdx = reordered.indexOf("statusBoard");
    expect(statusBoardIdx).toBe(incidentsIdx + 1);
  });
});

describe("useDispatchLayout — user isolation (org switch)", () => {
  it("loads the correct layout for each user ID independently", () => {
    const layoutA: DispatchLayout = {
      ...DEFAULT_LAYOUT,
      columns: 1,
      mapExpanded: true,
    };
    const layoutB: DispatchLayout = {
      ...DEFAULT_LAYOUT,
      columns: 3,
      mapExpanded: false,
    };

    localStorage.setItem(dispatchLayoutKey("user-a"), JSON.stringify(layoutA));
    localStorage.setItem(dispatchLayoutKey("user-b"), JSON.stringify(layoutB));

    const { result: resultA } = renderHook(() => useDispatchLayout("user-a"));
    const { result: resultB } = renderHook(() => useDispatchLayout("user-b"));

    expect(resultA.current[0].columns).toBe(1);
    expect(resultA.current[0].mapExpanded).toBe(true);

    expect(resultB.current[0].columns).toBe(3);
    expect(resultB.current[0].mapExpanded).toBe(false);
  });

  it("a write for user-a does not affect user-b's storage key", () => {
    const { result: resultA } = renderHook(() => useDispatchLayout("user-a"));

    act(() => {
      resultA.current[1]((prev) => ({ ...prev, columns: 1 }));
    });

    expect(localStorage.getItem(dispatchLayoutKey("user-b"))).toBeNull();
  });

  it("switching from user-a to user-b (remount with new id) loads user-b's own stored layout", () => {
    const layoutB: DispatchLayout = {
      ...DEFAULT_LAYOUT,
      columns: 3,
      panels: { ...DEFAULT_LAYOUT.panels, broadcast: false },
    };
    localStorage.setItem(dispatchLayoutKey("user-b"), JSON.stringify(layoutB));

    // Simulate org switch: unmount old user's hook, mount new user's hook
    const { unmount: unmountA } = renderHook(() => useDispatchLayout("user-a"));
    unmountA();

    const { result: resultB } = renderHook(() => useDispatchLayout("user-b"));
    expect(resultB.current[0].columns).toBe(3);
    expect(resultB.current[0].panels.broadcast).toBe(false);
  });
});
