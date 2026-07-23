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
