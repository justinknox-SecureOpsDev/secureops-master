import { useState, useCallback } from "react";

export const PANEL_IDS = [
  "incidents",
  "statusBoard",
  "shiftClaims",
  "openShifts",
  "liveMap",
  "broadcast",
] as const;

export type PanelId = (typeof PANEL_IDS)[number];

export const LEFT_PANELS: PanelId[] = [
  "incidents",
  "statusBoard",
  "shiftClaims",
  "openShifts",
];

export const RIGHT_PANELS: PanelId[] = ["liveMap", "broadcast"];

export const DEFAULT_PANEL_ORDER: PanelId[] = [
  "incidents",
  "statusBoard",
  "shiftClaims",
  "openShifts",
  "liveMap",
  "broadcast",
];

export interface DispatchLayout {
  panels: Record<PanelId, boolean>;
  columnSplit: number;
  mapExpanded: boolean;
  mapTileLayer: "street" | "satellite";
  panelOrder: PanelId[];
}

export const DEFAULT_LAYOUT: DispatchLayout = {
  panels: {
    incidents: true,
    statusBoard: true,
    shiftClaims: true,
    openShifts: true,
    liveMap: true,
    broadcast: true,
  },
  columnSplit: 67,
  mapExpanded: false,
  mapTileLayer: "street",
  panelOrder: DEFAULT_PANEL_ORDER,
};

export function dispatchLayoutKey(userId: string): string {
  return `wcsg.dispatch.layout.${userId}`;
}

export function parseStoredLayout(raw: string): DispatchLayout {
  const parsed = JSON.parse(raw) as Partial<DispatchLayout> & {
    panels?: Partial<Record<PanelId, boolean>>;
  };

  // Reconstruct panelOrder: keep only valid stored ids (in stored order),
  // then append any ids that were missing (e.g. newly-added panels).
  const storedOrder = Array.isArray(parsed.panelOrder)
    ? (parsed.panelOrder as unknown[])
    : [];
  const validStored = storedOrder.filter(
    (id): id is PanelId =>
      typeof id === "string" &&
      (PANEL_IDS as readonly string[]).includes(id),
  );
  const panelOrder: PanelId[] = [
    ...validStored,
    ...DEFAULT_PANEL_ORDER.filter((id) => !validStored.includes(id)),
  ];

  return {
    panels: { ...DEFAULT_LAYOUT.panels, ...parsed.panels },
    columnSplit:
      typeof parsed.columnSplit === "number"
        ? Math.max(20, Math.min(80, parsed.columnSplit))
        : DEFAULT_LAYOUT.columnSplit,
    mapExpanded:
      typeof parsed.mapExpanded === "boolean"
        ? parsed.mapExpanded
        : DEFAULT_LAYOUT.mapExpanded,
    mapTileLayer: parsed.mapTileLayer === "satellite" ? "satellite" : "street",
    panelOrder,
  };
}

/**
 * Pure function: apply a drag-to-reorder operation on `panelOrder`.
 *
 * Removes `srcId` from its current position and re-inserts it immediately
 * before or after `targetId`. Returns the original array unchanged if either
 * id is missing (defensive – callers should guard cross-column drops before
 * calling this).
 */
export function applyPanelReorder(
  panelOrder: PanelId[],
  srcId: PanelId,
  targetId: PanelId,
  position: "before" | "after",
): PanelId[] {
  const order = [...panelOrder];
  const fromIdx = order.indexOf(srcId);
  if (fromIdx === -1) return panelOrder;
  order.splice(fromIdx, 1);
  const toIdx = order.indexOf(targetId);
  if (toIdx === -1) return panelOrder;
  order.splice(position === "after" ? toIdx + 1 : toIdx, 0, srcId);
  return order;
}

/**
 * Sentinel value used in `buildColumnWithPlaceholder` output to mark where
 * the drop placeholder should be rendered.
 */
export const DRAG_PLACEHOLDER = "__drag-placeholder" as const;
export type ColumnSlot = PanelId | typeof DRAG_PLACEHOLDER;

/**
 * Pure function: given the visible ordered panel IDs for one column and the
 * current drag state, returns an array of slots that should be rendered —
 * panel IDs plus an optional `DRAG_PLACEHOLDER` sentinel at the correct
 * insertion point.
 *
 * Returns `visible` unchanged (no placeholder) when:
 *   - there is no active drag insert
 *   - `srcId` is null (no drag in progress)
 *   - `insert.overId` is not in `columnSet` (cross-column hover)
 *   - `srcId` is not in `columnSet` (source is a different column)
 */
export function buildColumnWithPlaceholder(
  visible: PanelId[],
  srcId: PanelId | null,
  insert: { overId: PanelId; position: "before" | "after" } | null,
  columnSet: PanelId[],
): ColumnSlot[] {
  if (!insert || !srcId || !columnSet.includes(insert.overId) || !columnSet.includes(srcId)) {
    return visible;
  }
  const { overId, position } = insert;
  const slots: ColumnSlot[] = [];
  for (const id of visible) {
    if (id === overId && position === "before") slots.push(DRAG_PLACEHOLDER);
    slots.push(id);
    if (id === overId && position === "after") slots.push(DRAG_PLACEHOLDER);
  }
  return slots;
}

export function useDispatchLayout(userId: string | undefined) {
  const storageKey = userId ? dispatchLayoutKey(userId) : null;

  const [layout, setLayoutRaw] = useState<DispatchLayout>(() => {
    if (!storageKey) return DEFAULT_LAYOUT;
    try {
      const raw = localStorage.getItem(storageKey);
      if (!raw) return DEFAULT_LAYOUT;
      return parseStoredLayout(raw);
    } catch {
      return DEFAULT_LAYOUT;
    }
  });

  const setLayout = useCallback(
    (updater: (prev: DispatchLayout) => DispatchLayout) => {
      setLayoutRaw((prev) => {
        const next = updater(prev);
        if (storageKey) {
          try {
            localStorage.setItem(storageKey, JSON.stringify(next));
          } catch {
            /* private / storage-full mode — best effort */
          }
        }
        return next;
      });
    },
    [storageKey],
  );

  return [layout, setLayout] as const;
}
