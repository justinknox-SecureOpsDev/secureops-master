import { useState, useCallback, useEffect } from "react";

export const PANEL_IDS = [
  "incidents",
  "statusBoard",
  "shiftClaims",
  "openShifts",
  "liveMap",
  "broadcast",
] as const;

export type PanelId = (typeof PANEL_IDS)[number];

export const DEFAULT_PANEL_ORDER: PanelId[] = [
  "incidents",
  "statusBoard",
  "shiftClaims",
  "openShifts",
  "liveMap",
  "broadcast",
];

export const LEFT_PANELS: readonly PanelId[] = [
  "incidents",
  "statusBoard",
  "shiftClaims",
  "openShifts",
] as const;

export const RIGHT_PANELS: readonly PanelId[] = [
  "liveMap",
  "broadcast",
] as const;

export interface DispatchLayout {
  panels: Record<PanelId, boolean>;
  /** Number of grid columns the dispatcher chose (1, 2, or 3). Default: 2. */
  columns: 1 | 2 | 3;
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
  columns: 2,
  mapExpanded: false,
  mapTileLayer: "street",
  panelOrder: DEFAULT_PANEL_ORDER,
};

export function dispatchLayoutKey(userId: string): string {
  return `wcsg.dispatch.layout.${userId}`;
}

function parseColumns(raw: unknown): 1 | 2 | 3 {
  if (raw === 1 || raw === 2 || raw === 3) return raw;
  return DEFAULT_LAYOUT.columns;
}

export function parseStoredLayout(raw: string): DispatchLayout {
  const parsed = JSON.parse(raw) as Partial<DispatchLayout> & {
    panels?: Partial<Record<PanelId, boolean>>;
    columnSplit?: unknown;
  };

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
    columns: parseColumns(parsed.columns),
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
 * id is missing.
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
 * Sentinel value used in `buildWithPlaceholder` output to mark where
 * the drop placeholder should be rendered.
 */
export const DRAG_PLACEHOLDER = "__drag-placeholder" as const;
export type ColumnSlot = PanelId | typeof DRAG_PLACEHOLDER;

/**
 * Sentinel that identifies the inter-column drop zone rendered between the
 * two columns so dispatchers can move a panel into an empty right column.
 */
export const COLUMN_BOUNDARY = "__column-boundary" as const;

/**
 * Pure function: move `srcId` to a target column boundary position.
 *
 * `targetVisibleIndex` is the 0-based visible position that srcId should
 * occupy after the drop (default 1 = beginning of the right column in a
 * 2-column layout).  For 3-column layouts pass 1 (col-start-2) or 2
 * (col-start-3).
 *
 * Steps:
 *   1. Builds the ordered list of visible panels (excluding srcId).
 *   2. If there are no other visible panels, returns panelOrder unchanged.
 *   3. If `targetVisibleIndex` >= the number of other visible panels, appends
 *      srcId after the last remaining visible panel.
 *   4. Otherwise inserts srcId immediately before the panel currently at
 *      `targetVisibleIndex` in the filtered visible list.
 *
 * Works on the full `panelOrder` array (hidden panels included), using
 * `visiblePanels` to identify which ids are currently shown.
 */
export function applyColumnBoundaryDrop(
  panelOrder: PanelId[],
  visiblePanels: Record<PanelId, boolean>,
  srcId: PanelId,
  targetVisibleIndex = 1,
): PanelId[] {
  const visibleWithout = panelOrder.filter(
    (id) => id !== srcId && visiblePanels[id],
  );

  if (visibleWithout.length === 0) {
    return panelOrder;
  }

  if (targetVisibleIndex >= visibleWithout.length) {
    return applyPanelReorder(
      panelOrder,
      srcId,
      visibleWithout[visibleWithout.length - 1],
      "after",
    );
  }

  return applyPanelReorder(
    panelOrder,
    srcId,
    visibleWithout[targetVisibleIndex],
    "before",
  );
}

/**
 * Pure function: given the visible ordered panel IDs and the current drag
 * state, returns an array of slots that should be rendered — panel IDs plus
 * an optional `DRAG_PLACEHOLDER` sentinel at the correct insertion point.
 *
 * Returns `visible` unchanged (no placeholder) when:
 *   - there is no active drag insert
 *   - `srcId` is null (no drag in progress)
 *   - `insert.overId` is not in `visible` (hidden panel hover)
 */
export function buildWithPlaceholder(
  visible: PanelId[],
  srcId: PanelId | null,
  insert: { overId: PanelId; position: "before" | "after" } | null,
): ColumnSlot[] {
  if (!insert || !srcId) return visible;
  const { overId, position } = insert;
  const slots: ColumnSlot[] = [];
  let placed = false;
  for (const id of visible) {
    if (id === overId && position === "before") { slots.push(DRAG_PLACEHOLDER); placed = true; }
    slots.push(id);
    if (id === overId && position === "after") { slots.push(DRAG_PLACEHOLDER); placed = true; }
  }
  return placed ? slots : visible;
}

/**
 * @deprecated Panels are no longer split into fixed columns, so the `columnSet`
 * argument is ignored.  Use `buildWithPlaceholder` for new code.
 */
export function buildColumnWithPlaceholder(
  visible: PanelId[],
  srcId: PanelId | null,
  insert: { overId: PanelId; position: "before" | "after" } | null,
  _columnSet?: PanelId[],
): ColumnSlot[] {
  return buildWithPlaceholder(visible, srcId, insert);
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

  // Re-hydrate when the user changes (e.g. org switch without page reload).
  useEffect(() => {
    if (!storageKey) { setLayoutRaw(DEFAULT_LAYOUT); return; }
    try {
      const raw = localStorage.getItem(storageKey);
      setLayoutRaw(raw ? parseStoredLayout(raw) : DEFAULT_LAYOUT);
    } catch {
      setLayoutRaw(DEFAULT_LAYOUT);
    }
  }, [storageKey]);

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
