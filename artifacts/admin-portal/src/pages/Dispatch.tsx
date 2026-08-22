import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, getToken, isStillProcessing, STILL_SAVING_MESSAGE } from "@/lib/api";
import { useIdempotentIntent } from "@/lib/idempotentIntent";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Card, CardContent, CardHeader, CardTitle,
} from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";
import {
  AlertTriangle, CheckCircle2, Clock, MapPin, MessageCircle, Radio, Send,
  ShieldAlert, UserCheck, Users, Megaphone, Loader2, RefreshCw, Wifi, WifiOff,
  HelpCircle, X, Settings2, Maximize2, Minimize2, GripVertical, Timer,
} from "lucide-react";
import { useAuth } from "@/lib/auth";
import { useFirstQueryParam } from "@/hooks/useDeepLinkFocus";
import { AssignNearestDialog, candidateBlockReason, type Candidate, type AssignNearestResult } from "@/components/AssignNearestDialog";
import { RadioPanel } from "@/components/RadioPanel";
import {
  PANEL_IDS,
  DEFAULT_LAYOUT,
  DEFAULT_GEOMETRY,
  LEFT_PANELS,
  useDispatchLayout,
  applyPanelReorder,
  applyColumnBoundaryDrop,
  buildWithPlaceholder,
  DRAG_PLACEHOLDER,
  COLUMN_BOUNDARY,
  type PanelId,
  type DispatchLayout,
  type PanelGeometry,
} from "./dispatchLayout";

type StatusRow = {
  assignmentId: string;
  shiftId: string | null;
  shiftTitle: string | null;
  startTime: string | null;
  endTime: string | null;
  siteName: string | null;
  siteAddress: string | null;
  userId: string;
  officerName: string;
  lastLat: string | null;
  lastLng: string | null;
  lastLocationAt: string | null;
  minutesLate?: number;
  minutesEarly?: number;
  clockInTime?: string;
  clockOutTime?: string;
  timeEntryId?: string;
  // Only set on onDuty rows — see STUCK_SHIFT_GRACE_HOURS/STUCK_WALKUP_HOURS
  // in dispatch.ts. `stuck` flags an open entry the auto-clock-out sweep
  // should have already closed but didn't (e.g. the site has it disabled).
  stuck?: boolean;
  hoursOpen?: number;
};

type StatusBoard = {
  onDuty: StatusRow[];
  late: StatusRow[];
  noShow: StatusRow[];
  earlyOut: StatusRow[];
  completed: StatusRow[];
  scheduled: StatusRow[];
};

type OpenShift = {
  id: string;
  title: string | null;
  siteId: string | null;
  siteName: string | null;
  siteAddress: string | null;
  startTime: string;
  endTime: string;
  headcount: number;
  filled: number;
  requiredLicenseLevel: number;
  payRate: string | null;
  claimableFrom: string | null;
};

type Incident = {
  id: string;
  title: string;
  description: string | null;
  severity: "low" | "medium" | "high" | "critical";
  status: string;
  lat: string | null;
  lng: string | null;
  locationDescription: string | null;
  occurredAt: string | null;
  createdAt: string;
  adminNotes: string | null;
  employeeName: string | null;
  /** Officer contact info (staff-only payload from /dispatch/active-incidents).
   *  Rendered on the SOS map popup so a dispatcher can call/email in one tap. */
  employeePhone?: string | null;
  employeeEmail?: string | null;
};

type ActiveOfficer = {
  userId: string;
  firstName: string;
  lastName: string;
  lastLat: string | null;
  lastLng: string | null;
  lastLocationAt: string | null;
  shiftId: string | null;
  shiftTitle: string | null;
  siteId: string | null;
  siteName: string | null;
};

type Site = {
  id: string;
  name: string;
  address: string | null;
  locationLat: string | null;
  locationLng: string | null;
  geofenceRadiusMiles?: string | null;
  effectiveGeofenceRadiusMiles?: number;
};

type ChatRoom = { id: string; name: string; type: string };
type ChatMessage = { id: string; content: string | null; userName?: string | null; createdAt: string };

// Shape of the rows returned by GET /shifts — each carries its assignments
// inline (id/status/employeeName), so pending self-claims are derived
// client-side without a dedicated endpoint (mirrors the Shifts page panel).
type ShiftWithAssignments = {
  id: string;
  title: string | null;
  clientName: string | null;
  location: string | null;
  startTime: string;
  endTime: string;
  requiredLicenseLevel: number;
  assignments: { id: string; status: string; employeeName: string | null }[];
};

type PendingClaim = {
  shiftId: string;
  assignmentId: string;
  employeeName: string | null;
  shiftTitle: string | null;
  clientName: string | null;
  location: string | null;
  startTime: string;
  endTime: string;
  requiredLicenseLevel: number;
};


// WCSG operates on Central Time. All board dates/times render in Central
// regardless of the viewer's browser timezone, matching the server-side
// status-board day window (PAYROLL_TIMEZONE, default America/Chicago).
const WCSG_TZ = "America/Chicago";

function fmtTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
    timeZone: WCSG_TZ,
  });
}

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: WCSG_TZ,
  });
}

function fmtAgo(iso: string | null | undefined): string {
  if (!iso) return "no ping";
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

const SEV_STYLES: Record<Incident["severity"], string> = {
  critical: "bg-red-600 text-white border-red-700",
  high: "bg-orange-500 text-white border-orange-600",
  medium: "bg-yellow-500 text-black border-yellow-600",
  low: "bg-slate-400 text-white border-slate-500",
};

// =========================================================== LAYOUT STATE

const PANEL_LABELS: Record<PanelId, string> = {
  incidents: "Active Incidents",
  statusBoard: "Status Board",
  shiftClaims: "Shift Claims",
  openShifts: "Open Shifts",
  liveMap: "Live Map",
  broadcast: "Broadcast",
  radio: "Radio",
};

// data-tour anchor values for panels that participate in the coach-mark tour.
const PANEL_TOUR: Partial<Record<PanelId, string>> = {
  incidents: "incidents",
  statusBoard: "status-board",
  shiftClaims: "shift-claims",
  openShifts: "open-shifts",
  broadcast: "broadcast",
  radio: "radio",
};
// =========================================================== CUSTOMIZE POPOVER

function CustomizePopover({
  layout,
  onTogglePanel,
  onResetLayout,
}: {
  layout: DispatchLayout;
  onTogglePanel: (id: PanelId) => void;
  onResetLayout: () => void;
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" aria-label="Customize layout">
          <Settings2 className="w-4 h-4 mr-2" /> Customize
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64 p-3">
        {/* Panel visibility */}
        <div className="text-xs font-semibold uppercase tracking-wide opacity-60 mb-2">
          Show / hide panels
        </div>
        <div className="space-y-2">
          {PANEL_IDS.map((id) => {
            const visible = layout.panels[id];
            return (
              <div
                key={id}
                className={`flex items-center justify-between rounded px-2 py-1.5 transition-colors ${
                  visible ? "" : "opacity-40"
                }`}
              >
                <span className="text-sm">{PANEL_LABELS[id]}</span>
                <Switch
                  checked={visible}
                  onCheckedChange={() => onTogglePanel(id)}
                  aria-label={`${visible ? "Hide" : "Show"} ${PANEL_LABELS[id]}`}
                />
              </div>
            );
          })}
        </div>
        <div className="mt-3 pt-3 border-t">
          <button
            onClick={onResetLayout}
            className="w-full text-xs text-muted-foreground hover:text-foreground transition-colors text-left"
            aria-label="Reset panel positions to default"
          >
            Reset panel layout
          </button>
        </div>
        <p className="text-[11px] opacity-50 mt-2 leading-snug">
          Drag the grip handle to move panels. Drag edges or corner to resize.
        </p>
      </PopoverContent>
    </Popover>
  );
}

/**
 * Subscribe to the shared `/api/ws` channel so brand-new incidents (and
 * status edits) flush into the page without waiting on the 30s poll.
 * Returns the connection state so the panel header can flag a WS drop
 * (poll keeps working as a fallback). Server fans out `incident:changed`
 * to admins+dispatchers only — see `routes/incidents.ts`.
 */
function useIncidentWs(onChange: () => void): "connecting" | "open" | "closed" {
  const [state, setState] = useState<"connecting" | "open" | "closed">("connecting");
  const cbRef = useRef(onChange);
  cbRef.current = onChange;

  useEffect(() => {
    const token = getToken();
    if (!token) { setState("closed"); return; }
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${proto}//${window.location.host}/api/ws?token=${encodeURIComponent(token)}`;
    let ws: WebSocket | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let closed = false;

    const connect = () => {
      try {
        ws = new WebSocket(url);
      } catch {
        setState("closed");
        return;
      }
      setState("connecting");
      ws.onopen = () => setState("open");
      ws.onclose = () => {
        setState("closed");
        if (!closed) retry = setTimeout(connect, 5000);
      };
      ws.onerror = () => { /* onclose follows */ };
      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(typeof ev.data === "string" ? ev.data : "");
          if (msg && msg.type === "incident:changed") cbRef.current();
        } catch { /* ignore non-JSON / chat frames */ }
      };
    };
    connect();

    return () => {
      closed = true;
      if (retry) clearTimeout(retry);
      if (ws && ws.readyState <= 1) ws.close();
    };
  }, []);

  return state;
}

export default function DispatchPage() {
  const qc = useQueryClient();
  const { user } = useAuth();
  const [tourOpen, setTourOpen] = useState(false);
  const [layout, setLayout] = useDispatchLayout(user?.id);

  const togglePanel = useCallback((id: PanelId) => {
    setLayout((prev) => ({
      ...prev,
      panels: { ...prev.panels, [id]: !prev.panels[id] },
    }));
  }, [setLayout]);

  // ---- free-form move / resize ----
  type ActiveOp =
    | { kind: "move"; id: PanelId; startX: number; startY: number; origX: number; origY: number }
    | { kind: "resize"; id: PanelId; dir: "e" | "s" | "se"; startX: number; startY: number; origW: number; origH: number };

  const activeOpRef = useRef<ActiveOp | null>(null);
  const panelRefs = useRef<Map<PanelId, HTMLDivElement>>(new Map());

  const getGeo = useCallback(
    (id: PanelId): PanelGeometry => layout.panelGeometry[id] ?? DEFAULT_GEOMETRY[id],
    [layout.panelGeometry],
  );

  const bringToFront = useCallback(
    (id: PanelId) => {
      setLayout((prev) => {
        if (prev.panelOrder[prev.panelOrder.length - 1] === id) return prev;
        const order = prev.panelOrder.filter((p) => p !== id);
        return { ...prev, panelOrder: [...order, id] };
      });
    },
    [setLayout],
  );

  const handleMoveStart = useCallback(
    (id: PanelId, e: React.PointerEvent) => {
      e.preventDefault();
      e.stopPropagation();
      try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch { /* jsdom */ }
      const geo = getGeo(id);
      activeOpRef.current = { kind: "move", id, startX: e.clientX, startY: e.clientY, origX: geo.x, origY: geo.y };
      bringToFront(id);
    },
    [getGeo, bringToFront],
  );

  const handleResizeStart = useCallback(
    (id: PanelId, e: React.PointerEvent, dir: "e" | "s" | "se") => {
      e.preventDefault();
      e.stopPropagation();
      try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch { /* jsdom */ }
      const geo = getGeo(id);
      activeOpRef.current = { kind: "resize", id, dir, startX: e.clientX, startY: e.clientY, origW: geo.w, origH: geo.h };
      bringToFront(id);
    },
    [getGeo, bringToFront],
  );

  // Global pointer listeners drive live DOM updates (bypassing React state for
  // smooth dragging), then commit the final geometry on pointerup.
  useEffect(() => {
    const MIN_W = 280;
    const MIN_H = 160;

    const onMove = (e: PointerEvent) => {
      const op = activeOpRef.current;
      if (!op) return;
      const dx = e.clientX - op.startX;
      const dy = e.clientY - op.startY;
      const el = panelRefs.current.get(op.id);
      if (!el) return;
      if (op.kind === "move") {
        el.style.left = `${Math.max(0, op.origX + dx)}px`;
        el.style.top = `${Math.max(0, op.origY + dy)}px`;
      } else {
        if (op.dir === "e" || op.dir === "se") {
          el.style.width = `${Math.max(MIN_W, op.origW + dx)}px`;
        }
        if (op.dir === "s" || op.dir === "se") {
          el.style.height = `${Math.max(MIN_H, op.origH + dy)}px`;
        }
      }
    };

    const onUp = () => {
      const op = activeOpRef.current;
      if (!op) return;
      const el = panelRefs.current.get(op.id);
      if (el) {
        const newGeo: PanelGeometry = {
          x: parseFloat(el.style.left) || 0,
          y: parseFloat(el.style.top) || 0,
          w: parseFloat(el.style.width) || DEFAULT_GEOMETRY[op.id].w,
          h: parseFloat(el.style.height) || DEFAULT_GEOMETRY[op.id].h,
        };
        setLayout((prev) => ({
          ...prev,
          panelGeometry: { ...prev.panelGeometry, [op.id]: newGeo },
        }));
      }
      activeOpRef.current = null;
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [setLayout]);
  // Incident id that the Live Map asked to open. Lifted to the page so
  // the map (right column) can hand off to the IncidentsPanel (left
  // column) without either component leaving the Dispatch page — this
  // is the dispatcher-safe path, since /incidents/share-links is admin-
  // only. Cleared after the panel opens the matching dialog.
  const [focusedIncidentId, setFocusedIncidentId] = useState<string | null>(null);

  // Deep-link params (alert / notification / share link). An incidentId focuses
  // the matching active incident (scroll + open dialog); userId/siteId center
  // the live map on that officer/site — the web mirror of the mobile
  // emergency / geofence-breach deep links.
  const deepLinkIncidentId = useFirstQueryParam("incidentId", "focus");
  const deepLinkUserId = useFirstQueryParam("userId");
  const deepLinkSiteId = useFirstQueryParam("siteId");
  useEffect(() => {
    if (deepLinkIncidentId) setFocusedIncidentId(deepLinkIncidentId);
  }, [deepLinkIncidentId]);

  // First-run coach-mark tour. Per-user remembered flag (localStorage)
  // so each dispatcher only sees it once, but a "Show me again" link
  // in the header lets them re-open it any time.
  const tourStorageKey = user ? `wcsg.dispatch.tour.seen.${user.id}` : null;
  useEffect(() => {
    if (!tourStorageKey) return;
    try {
      if (!localStorage.getItem(tourStorageKey)) setTourOpen(true);
    } catch { /* private-mode / disabled storage — skip silently */ }
  }, [tourStorageKey]);
  const closeTour = () => {
    setTourOpen(false);
    if (tourStorageKey) {
      try { localStorage.setItem(tourStorageKey, "1"); } catch { /* ignore */ }
    }
  };

  const board = useQuery<StatusBoard>({
    queryKey: ["dispatch", "status-board"],
    queryFn: () => api<StatusBoard>("/dispatch/status-board"),
    refetchInterval: 30_000,
  });
  const openShifts = useQuery<OpenShift[]>({
    queryKey: ["dispatch", "open-shifts"],
    queryFn: () => api<OpenShift[]>("/dispatch/open-shifts?hours=72"),
    refetchInterval: 60_000,
  });
  const incidents = useQuery<Incident[]>({
    queryKey: ["dispatch", "active-incidents"],
    queryFn: () => api<Incident[]>("/dispatch/active-incidents"),
    refetchInterval: 30_000,
  });
  const officers = useQuery<ActiveOfficer[]>({
    queryKey: ["dispatch", "active-officers"],
    queryFn: () => api<ActiveOfficer[]>("/admin/active-officers"),
    refetchInterval: 30_000,
  });
  const sites = useQuery<Site[]>({
    queryKey: ["dispatch", "sites"],
    queryFn: () => api<Site[]>("/sites"),
    refetchInterval: 5 * 60_000,
  });
  const rooms = useQuery<ChatRoom[]>({
    queryKey: ["dispatch", "broadcast-rooms"],
    queryFn: () => api<ChatRoom[]>("/dispatch/broadcast-rooms"),
  });
  // Officer self-claims awaiting an approval decision. Derived from the
  // upcoming-shifts list (each row carries its assignments inline) so no
  // dedicated endpoint is needed — same source the Shifts page panel uses.
  const claims = useQuery<ShiftWithAssignments[]>({
    queryKey: ["dispatch", "shift-claims"],
    queryFn: () => api<ShiftWithAssignments[]>("/shifts?status=upcoming"),
    refetchInterval: 30_000,
  });
  const pendingClaims = useMemo<PendingClaim[]>(() => {
    const out: PendingClaim[] = [];
    for (const s of claims.data ?? []) {
      for (const a of s.assignments ?? []) {
        if (a.status !== "pending_approval") continue;
        out.push({
          shiftId: s.id,
          assignmentId: a.id,
          employeeName: a.employeeName,
          shiftTitle: s.title,
          clientName: s.clientName,
          location: s.location,
          startTime: s.startTime,
          endTime: s.endTime,
          requiredLicenseLevel: s.requiredLicenseLevel,
        });
      }
    }
    out.sort((a, b) => a.startTime.localeCompare(b.startTime));
    return out;
  }, [claims.data]);

  const refreshAll = () => {
    qc.invalidateQueries({ queryKey: ["dispatch"] });
  };

  // Real-time incident pulse — falls back to the 30s poll on WS drop.
  const wsState = useIncidentWs(() => {
    qc.invalidateQueries({ queryKey: ["dispatch", "active-incidents"] });
  });

  return (
    <div className="py-4 lg:py-6 space-y-4">
      <header className="px-4 lg:px-6 flex items-center justify-between flex-wrap gap-3 max-w-[1600px] mx-auto">
        <div>
          <h1 className="brand-wordmark text-2xl text-brand-navy">Dispatch Command Center</h1>
          <p className="text-sm opacity-70 flex items-center gap-2">
            Live operations roll-up. Auto-refreshes every 30–60 seconds.
            {wsState === "open" ? (
              <span className="inline-flex items-center gap-1 text-emerald-700 text-xs">
                <Wifi className="w-3 h-3" /> live
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 text-amber-700 text-xs">
                <WifiOff className="w-3 h-3" /> polling
              </span>
            )}
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <CustomizePopover
            layout={layout}
            onTogglePanel={togglePanel}
            onResetLayout={() =>
              setLayout((prev) => ({ ...prev, panelGeometry: DEFAULT_GEOMETRY }))
            }
          />
          <Button
            variant="ghost" size="sm"
            onClick={() => setTourOpen(true)}
            className="text-xs"
            data-testid="dispatch-tour-reopen"
          >
            <HelpCircle className="w-4 h-4 mr-1" /> Show me again
          </Button>
          <Button variant="outline" size="sm" onClick={refreshAll}>
            <RefreshCw className="w-4 h-4 mr-2" /> Refresh
          </Button>
        </div>
      </header>

      {/* ---- free-form canvas: panels are absolutely positioned ---- */}
      {(() => {
        const visible = layout.panelOrder.filter((id) => layout.panels[id]);

        // Canvas height: tall enough to contain all visible panels with a
        // comfortable bottom margin. Minimum 600 px.
        let canvasH = 600;
        for (const id of visible) {
          const geo = layout.panelGeometry[id] ?? DEFAULT_GEOMETRY[id];
          canvasH = Math.max(canvasH, geo.y + geo.h + 32);
        }

        const renderPanelContent = (id: PanelId) => {
          switch (id) {
            case "incidents":
              return (
                <IncidentsPanel
                  data={incidents.data ?? []}
                  loading={incidents.isLoading}
                  error={incidents.error}
                  updatedAt={incidents.dataUpdatedAt}
                  onChange={refreshAll}
                  wsState={wsState}
                  focusedIncidentId={focusedIncidentId}
                  onFocusConsumed={() => setFocusedIncidentId(null)}
                />
              );
            case "statusBoard":
              return (
                <StatusBoardPanel
                  data={board.data}
                  loading={board.isLoading}
                  error={board.error}
                  updatedAt={board.dataUpdatedAt}
                  isAdmin={user?.role === "admin"}
                  onChange={refreshAll}
                />
              );
            case "shiftClaims":
              return (
                <ShiftClaimsPanel
                  claims={pendingClaims}
                  loading={claims.isLoading}
                  error={claims.error}
                  updatedAt={claims.dataUpdatedAt}
                  onChange={() => qc.invalidateQueries({ queryKey: ["dispatch"] })}
                />
              );
            case "openShifts":
              return (
                <OpenShiftsPanel
                  data={openShifts.data ?? []}
                  loading={openShifts.isLoading}
                  error={openShifts.error}
                  updatedAt={openShifts.dataUpdatedAt}
                  onChange={refreshAll}
                />
              );
            case "liveMap":
              return (
                <LiveMapPanel
                  officers={officers.data ?? []}
                  sites={sites.data ?? []}
                  loading={officers.isLoading}
                  error={officers.error}
                  updatedAt={officers.dataUpdatedAt}
                  incidents={incidents.data ?? []}
                  onFocusIncident={setFocusedIncidentId}
                  focusUserId={deepLinkUserId}
                  focusSiteId={deepLinkSiteId}
                  mapExpanded={layout.mapExpanded}
                  onToggleExpand={() =>
                    setLayout((prev) => ({ ...prev, mapExpanded: !prev.mapExpanded }))
                  }
                  mapTileLayer={layout.mapTileLayer}
                  onTileLayerChange={(layer) =>
                    setLayout((prev) => ({ ...prev, mapTileLayer: layer }))
                  }
                />
              );
            case "broadcast":
              return <BroadcastPanel rooms={rooms.data ?? []} />;
            case "radio":
              return <RadioPanel />;
          }
        };

        return (
          <div className="relative w-full" style={{ height: canvasH }}>
            {visible.map((id, orderIdx) => {
              const geo = layout.panelGeometry[id] ?? DEFAULT_GEOMETRY[id];
              const zIdx = orderIdx + 1;
              const tourAttr = PANEL_TOUR[id];
              return (
                <div
                  key={id}
                  ref={(el) => {
                    if (el) panelRefs.current.set(id, el);
                    else panelRefs.current.delete(id);
                  }}
                  data-panel-id={id}
                  data-column={LEFT_PANELS.includes(id) ? "left" : "right"}
                  {...(tourAttr ? { "data-tour": tourAttr } : {})}
                  onPointerDown={() => bringToFront(id)}
                  className="absolute group rounded-lg min-w-0 overflow-visible"
                  style={{
                    left: geo.x,
                    top: geo.y,
                    width: geo.w,
                    height: geo.h,
                    zIndex: zIdx,
                  }}
                >
                  {/* ---- move handle (grip icon, top-right) ---- */}
                  <div
                    data-testid="panel-move-handle"
                    onPointerDown={(e) => handleMoveStart(id, e)}
                    className="absolute top-2 right-2 z-10 opacity-0 group-hover:opacity-100 transition-opacity cursor-grab active:cursor-grabbing text-muted-foreground/50 hover:text-muted-foreground touch-none"
                    aria-label={`Move ${PANEL_LABELS[id]} panel`}
                    title="Drag to move"
                  >
                    <GripVertical className="w-4 h-4" />
                  </div>

                  {/* ---- resize handles ---- */}
                  {/* Right edge */}
                  <div
                    data-testid="panel-resize-handle"
                    onPointerDown={(e) => handleResizeStart(id, e, "e")}
                    className="absolute top-0 right-0 w-2 h-full cursor-ew-resize touch-none opacity-0 group-hover:opacity-100 z-10"
                    aria-label={`Resize ${PANEL_LABELS[id]} panel width`}
                  />
                  {/* Bottom edge */}
                  <div
                    onPointerDown={(e) => handleResizeStart(id, e, "s")}
                    className="absolute bottom-0 left-0 h-2 w-full cursor-ns-resize touch-none opacity-0 group-hover:opacity-100 z-10"
                    aria-label={`Resize ${PANEL_LABELS[id]} panel height`}
                  />
                  {/* Bottom-right corner */}
                  <div
                    onPointerDown={(e) => handleResizeStart(id, e, "se")}
                    className="absolute bottom-0 right-0 w-4 h-4 cursor-se-resize touch-none opacity-0 group-hover:opacity-100 z-20 flex items-end justify-end p-0.5"
                    aria-label={`Resize ${PANEL_LABELS[id]} panel`}
                  >
                    <svg width="8" height="8" viewBox="0 0 8 8" className="text-muted-foreground/40 group-hover:text-muted-foreground/70">
                      <path d="M1 7L7 1M4 7L7 4M7 7L7 7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                    </svg>
                  </div>

                  {/* Panel content fills the wrapper */}
                  <div className="w-full h-full overflow-auto">
                    {renderPanelContent(id)}
                  </div>
                </div>
              );
            })}
          </div>
        );
      })()}

      {tourOpen && <DispatchTour onClose={closeTour} panels={layout.panels} />}
    </div>
  );
}

// =========================================================== COACH-MARK TOUR

/**
 * Mobile employee Chat tab name, referenced in the broadcast tour step body.
 * Must stay in sync with TAB_CHAT in security-ops/constants/tabNames.ts.
 * The tabNames test suite reads this file and validates the "X tab" phrase
 * against KNOWN_TAB_PREFIXES to catch stale references before they ship.
 */
const MOBILE_EMPLOYEE_CHAT_TAB = "Chat" as const;

type TourStep = {
  /** data-tour selector to spotlight */
  selector: string;
  /** Panel that must be visible for this step to appear */
  panelKey: PanelId;
  title: string;
  body: string;
};

const TOUR_STEPS: TourStep[] = [
  {
    selector: '[data-tour="incidents"]',
    panelKey: "incidents",
    title: "Active Incidents",
    body: "Every open incident lands here in real time. Critical ones flash red — click any row to update status and add dispatcher notes.",
  },
  {
    selector: '[data-tour="status-board"]',
    panelKey: "statusBoard",
    title: "Clock-In Status Board",
    body: "Today's shifts grouped by state: on duty, late (≥10m), no-show, early-out, and upcoming. Use it to spot coverage gaps at a glance.",
  },
  {
    selector: '[data-tour="open-shifts"]',
    panelKey: "openShifts",
    title: "Open Shifts & Assign Nearest",
    body: "Unfilled shifts in the next 72 hours. Hit \"Assign nearest\" to rank qualified officers by distance and one-tap fill the slot, or \"Notify\" to push the vacancy to everyone who qualifies.",
  },
  {
    selector: '[data-tour="broadcast"]',
    panelKey: "broadcast",
    title: "Broadcast Composer",
    body: `Pick a channel (📣 announcements goes org-wide), preview the thread if you want context, then send. Officers see it instantly in the ${MOBILE_EMPLOYEE_CHAT_TAB} tab and via push notification.`,
  },
];

function DispatchTour({
  onClose,
  panels,
}: {
  onClose: () => void;
  panels: Record<PanelId, boolean>;
}) {
  // Filter to only the steps whose panel is currently visible.
  const visibleSteps = useMemo(
    () => TOUR_STEPS.filter((s) => panels[s.panelKey]),
    [panels],
  );
  const noVisiblePanels = visibleSteps.length === 0;

  const [idx, setIdx] = useState(0);
  // If the user hid panels while the tour was open, clamp the index.
  const safeIdx = Math.min(idx, Math.max(0, visibleSteps.length - 1));
  const step = visibleSteps[safeIdx];
  const [rect, setRect] = useState<DOMRect | null>(null);
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  const titleId = "dispatch-tour-title";
  const bodyId = "dispatch-tour-body";
  const stepDescId = `dispatch-tour-step-${safeIdx}`;

  // Attach aria-describedby to the spotlight target so SR users get context.
  useEffect(() => {
    if (!step) return;
    const el = document.querySelector(step.selector) as HTMLElement | null;
    if (!el) return;
    const prev = el.getAttribute("aria-describedby");
    const next = prev ? `${prev} ${stepDescId}` : stepDescId;
    el.setAttribute("aria-describedby", next);
    return () => {
      const cur = el.getAttribute("aria-describedby");
      if (!cur) return;
      const cleaned = cur.split(/\s+/).filter((t) => t !== stepDescId).join(" ");
      if (cleaned) el.setAttribute("aria-describedby", cleaned);
      else el.removeAttribute("aria-describedby");
    };
  }, [step?.selector, stepDescId]);

  useEffect(() => {
    if (!step) { setRect(null); return; }
    const measure = () => {
      const el = document.querySelector(step.selector) as HTMLElement | null;
      if (!el) { setRect(null); return; }
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      // Re-measure after the scroll has a chance to settle.
      requestAnimationFrame(() => {
        setRect(el.getBoundingClientRect());
      });
    };
    measure();
    const onResize = () => {
      const el = document.querySelector(step.selector) as HTMLElement | null;
      if (el) setRect(el.getBoundingClientRect());
    };
    window.addEventListener("resize", onResize);
    window.addEventListener("scroll", onResize, true);
    return () => {
      window.removeEventListener("resize", onResize);
      window.removeEventListener("scroll", onResize, true);
    };
  }, [step?.selector]);

  // Position the tooltip below the target when there's room, otherwise above.
  // When there is no spotlight (no panel / all panels hidden), centre it.
  const tooltipStyle = useMemo<React.CSSProperties>(() => {
    if (!rect) {
      return { top: "50%", left: "50%", transform: "translate(-50%, -50%)" };
    }
    const tooltipW = 360;
    const tooltipH = 200;
    const margin = 12;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const spaceBelow = vh - rect.bottom;
    const placeBelow = spaceBelow >= tooltipH + margin;
    const top = placeBelow
      ? Math.min(rect.bottom + margin, vh - tooltipH - margin)
      : Math.max(margin, rect.top - tooltipH - margin);
    const rawLeft = rect.left + rect.width / 2 - tooltipW / 2;
    const left = Math.max(margin, Math.min(rawLeft, vw - tooltipW - margin));
    return { top, left, width: tooltipW };
  }, [rect]);

  const next = () => {
    if (safeIdx < visibleSteps.length - 1) setIdx(safeIdx + 1);
    else onClose();
  };
  const prev = () => { if (safeIdx > 0) setIdx(safeIdx - 1); };

  // Restore focus to the trigger when the tour closes.
  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    return () => {
      if (previouslyFocused && typeof previouslyFocused.focus === "function") {
        previouslyFocused.focus();
      }
    };
  }, []);

  // Move focus into the tooltip when it opens or steps change.
  useEffect(() => {
    const root = tooltipRef.current;
    if (!root) return;
    const focusables = root.querySelectorAll<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    );
    const first = focusables[0];
    if (first) first.focus();
    else root.focus();
  }, [safeIdx, noVisiblePanels]);

  // Keyboard handling: Esc closes, Arrow/Enter navigate, Tab is trapped.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key === "ArrowRight" || e.key === "Enter") {
        const target = e.target as HTMLElement | null;
        // Let Enter activate focused buttons normally; only intercept Enter
        // when focus is on the tooltip container itself.
        if (e.key === "Enter" && target && target.tagName === "BUTTON") return;
        e.preventDefault();
        next();
        return;
      }
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        prev();
        return;
      }
      if (e.key === "Tab") {
        const root = tooltipRef.current;
        if (!root) return;
        const focusables = Array.from(
          root.querySelectorAll<HTMLElement>(
            'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
          ),
        ).filter((el) => !el.hasAttribute("disabled"));
        if (focusables.length === 0) {
          e.preventDefault();
          root.focus();
          return;
        }
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        const active = document.activeElement as HTMLElement | null;
        if (e.shiftKey) {
          if (active === first || !root.contains(active)) {
            e.preventDefault();
            last.focus();
          }
        } else {
          if (active === last || !root.contains(active)) {
            e.preventDefault();
            first.focus();
          }
        }
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [safeIdx, noVisiblePanels, onClose]);

  // "All panels hidden" — show a single centred message prompting the user
  // to restore panels via the Customize button, then close.
  if (noVisiblePanels) {
    return (
      <div className="fixed inset-0 z-[1000]">
        <div
          className="absolute inset-0 bg-black/50"
          onClick={onClose}
          data-testid="dispatch-tour-overlay"
        />
        <div
          ref={tooltipRef}
          className="absolute bg-card text-card-foreground rounded-lg shadow-xl border p-4 space-y-3 focus:outline-none"
          style={{ top: "50%", left: "50%", transform: "translate(-50%, -50%)", width: 360 }}
          onClick={(e) => e.stopPropagation()}
          data-testid="dispatch-tour-tooltip"
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          aria-describedby={bodyId}
          tabIndex={-1}
        >
          <div className="flex items-start justify-between gap-2">
            <div id={titleId} className="font-semibold text-sm">No panels to tour</div>
            <button
              onClick={onClose}
              className="opacity-60 hover:opacity-100"
              aria-label="Close walkthrough"
              data-testid="dispatch-tour-close"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
          <p id={bodyId} className="text-sm opacity-85 leading-snug">
            All walkthrough panels are currently hidden. Use the{" "}
            <strong>Customize</strong> button in the header to restore them, then
            re-open the tour.
          </p>
          <div className="flex justify-end pt-1">
            <Button size="sm" onClick={onClose} data-testid="dispatch-tour-next">
              Got it
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-[1000]">
      {/* Dim overlay; click anywhere outside the highlight or tooltip dismisses. */}
      <div
        className="absolute inset-0 bg-black/50"
        onClick={onClose}
        data-testid="dispatch-tour-overlay"
      />
      {rect && (
        <div
          className="absolute pointer-events-none rounded-lg ring-4 ring-brand-gold"
          style={{
            top: rect.top - 6,
            left: rect.left - 6,
            width: rect.width + 12,
            height: rect.height + 12,
            boxShadow: "0 0 0 9999px rgba(0,0,0,0.5)",
          }}
        />
      )}
      <div
        ref={tooltipRef}
        className="absolute bg-card text-card-foreground rounded-lg shadow-xl border p-4 space-y-3 focus:outline-none"
        style={tooltipStyle}
        onClick={(e) => e.stopPropagation()}
        data-testid="dispatch-tour-tooltip"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        tabIndex={-1}
      >
        <div className="flex items-start justify-between gap-2">
          <div>
            <div className="text-[11px] uppercase opacity-60 tracking-wide">
              Step {safeIdx + 1} of {visibleSteps.length}
            </div>
            <div id={titleId} className="font-semibold text-sm mt-0.5">{step.title}</div>
          </div>
          <button
            onClick={onClose}
            className="opacity-60 hover:opacity-100"
            aria-label="Close walkthrough"
            data-testid="dispatch-tour-close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        <p id={bodyId} className="text-sm opacity-85 leading-snug">{step.body}</p>
        {/* Hidden description anchored on the spotlighted panel for SR users. */}
        <span id={stepDescId} className="sr-only">
          {step.title}: {step.body}
        </span>
        <div className="flex items-center justify-between pt-1">
          <div className="flex gap-1">
            {visibleSteps.map((_, i) => (
              <span
                key={i}
                className={`h-1.5 w-5 rounded-full ${i === safeIdx ? "bg-brand-gold" : "bg-muted"}`}
              />
            ))}
          </div>
          <div className="flex items-center gap-2">
            {safeIdx > 0 && (
              <Button size="sm" variant="ghost" onClick={prev}>Back</Button>
            )}
            <Button
              size="sm"
              onClick={next}
              data-testid="dispatch-tour-next"
            >
              {safeIdx < visibleSteps.length - 1 ? "Next" : "Got it"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ----- shared panel chrome bits ---------------------------------------------

function FreshnessLabel({ updatedAt }: { updatedAt: number | undefined }) {
  const [, force] = useState(0);
  // Tick once a minute so "5m ago" doesn't go stale on idle tabs.
  useEffect(() => {
    const t = setInterval(() => force((n) => n + 1), 60_000);
    return () => clearInterval(t);
  }, []);
  if (!updatedAt) return null;
  return <span className="text-[11px] opacity-60 font-normal">updated {fmtAgo(new Date(updatedAt).toISOString())}</span>;
}

function InlineError({ error }: { error: unknown }) {
  if (!error) return null;
  const msg = error instanceof Error ? error.message : "Could not load this panel.";
  return (
    <div className="rounded border border-red-200 bg-red-50 text-red-900 text-xs px-3 py-2 flex items-center gap-2">
      <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" />
      <span className="truncate">{msg}</span>
    </div>
  );
}

// =========================================================== INCIDENTS PANEL

function IncidentsPanel({
  data, loading, error, updatedAt, onChange, wsState,
  focusedIncidentId, onFocusConsumed,
}: {
  data: Incident[]; loading: boolean; error: unknown; updatedAt: number | undefined;
  onChange: () => void; wsState: "connecting" | "open" | "closed";
  focusedIncidentId?: string | null;
  onFocusConsumed?: () => void;
}) {
  const critical = data.filter((i) => i.severity === "critical");
  const others = data.filter((i) => i.severity !== "critical");
  // When the Live Map deep-links to an incident, scroll its row into
  // view so the auto-opened dialog has visible context underneath.
  const focusRowRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!focusedIncidentId) return;
    const el = focusRowRef.current;
    if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [focusedIncidentId, data]);
  return (
    <Card className="border-2" style={{ borderColor: critical.length ? "#dc2626" : "transparent" }}>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base flex-wrap">
          <ShieldAlert className="w-5 h-5 brand-gold" />
          Active Incidents
          {critical.length > 0 && (
            <Badge className="bg-red-600 hover:bg-red-700 text-white animate-pulse ml-2">
              {critical.length} CRITICAL
            </Badge>
          )}
          <span className="ml-auto flex items-center gap-2">
            <span className="text-xs opacity-60 font-normal">{data.length} open</span>
            {wsState === "open" ? (
              <Wifi className="w-3.5 h-3.5 text-emerald-600" aria-label="Real-time updates connected" />
            ) : (
              <WifiOff className="w-3.5 h-3.5 text-amber-600" aria-label="Falling back to polling" />
            )}
            <FreshnessLabel updatedAt={updatedAt} />
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 max-h-[28rem] overflow-y-auto">
        <InlineError error={error} />
        {loading && <div className="text-sm opacity-60">Loading…</div>}
        {!loading && !error && data.length === 0 && <div className="text-sm opacity-60">No active incidents.</div>}
        {[...critical, ...others].map((i) => (
          <IncidentRow
            key={i.id}
            incident={i}
            onChange={onChange}
            autoOpen={focusedIncidentId === i.id}
            onAutoOpenConsumed={onFocusConsumed}
            rowRef={focusedIncidentId === i.id ? focusRowRef : undefined}
          />
        ))}
      </CardContent>
    </Card>
  );
}

function IncidentRow({
  incident, onChange, autoOpen, onAutoOpenConsumed, rowRef,
}: {
  incident: Incident; onChange: () => void;
  autoOpen?: boolean;
  onAutoOpenConsumed?: () => void;
  rowRef?: React.Ref<HTMLDivElement>;
}) {
  const [open, setOpen] = useState(false);
  // Auto-open when the Live Map deep-links to this incident.
  useEffect(() => {
    if (autoOpen) {
      setOpen(true);
      onAutoOpenConsumed?.();
    }
  }, [autoOpen, onAutoOpenConsumed]);
  return (
    <div ref={rowRef}>
      <button
        onClick={() => setOpen(true)}
        className="w-full text-left rounded border bg-card hover:bg-accent/50 p-3 transition-colors"
      >
        <div className="flex items-start gap-2">
          <Badge className={`uppercase text-[10px] ${SEV_STYLES[incident.severity]}`}>
            {incident.severity}
          </Badge>
          <div className="flex-1 min-w-0">
            <div className="font-medium text-sm truncate">{incident.title}</div>
            <div className="text-xs opacity-70 truncate">
              {incident.employeeName ?? "—"} · {incident.locationDescription ?? incident.status}
            </div>
          </div>
          <div className="text-[11px] opacity-60 whitespace-nowrap">{fmtAgo(incident.createdAt)}</div>
        </div>
      </button>
      <IncidentDialog incident={incident} open={open} onOpenChange={setOpen} onChange={onChange} />
    </div>
  );
}

function IncidentDialog({
  incident, open, onOpenChange, onChange,
}: { incident: Incident; open: boolean; onOpenChange: (v: boolean) => void; onChange: () => void }) {
  const [notes, setNotes] = useState(incident.adminNotes ?? "");
  const [status, setStatus] = useState(incident.status);
  const save = useMutation({
    mutationFn: () => api(`/incidents/${incident.id}`, {
      method: "PUT",
      body: { adminNotes: notes, status },
    }),
    onSuccess: () => { onChange(); onOpenChange(false); },
  });
  useEffect(() => {
    if (open) { setNotes(incident.adminNotes ?? ""); setStatus(incident.status); }
  }, [open, incident]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Badge className={`uppercase text-[10px] ${SEV_STYLES[incident.severity]}`}>
              {incident.severity}
            </Badge>
            {incident.title}
          </DialogTitle>
          <DialogDescription className="sr-only">
            Incident details. Review and update the status and dispatcher notes.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 text-sm">
          <div className="opacity-80">{incident.description ?? "No description."}</div>
          <div className="grid grid-cols-2 gap-2 text-xs">
            <div><span className="opacity-60">Reporter:</span> {incident.employeeName ?? "—"}</div>
            <div><span className="opacity-60">Location:</span> {incident.locationDescription ?? "—"}</div>
            <div><span className="opacity-60">Occurred:</span> {fmtTime(incident.occurredAt)}</div>
            <div><span className="opacity-60">Reported:</span> {fmtTime(incident.createdAt)}</div>
          </div>
          <div>
            <label className="text-xs opacity-70 block mb-1">Status</label>
            <select
              className="w-full rounded border px-2 py-1 bg-background"
              value={status}
              onChange={(e) => setStatus(e.target.value)}
            >
              <option value="open">Open</option>
              <option value="in_progress">In progress</option>
              <option value="resolved">Resolved</option>
              <option value="closed">Closed</option>
            </select>
          </div>
          <div>
            <label className="text-xs opacity-70 block mb-1">Dispatcher / admin notes</label>
            <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={4} />
          </div>
          {save.isError && (
            <div className="text-xs text-red-700">
              {save.error instanceof Error ? save.error.message : "Could not save changes."}
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={() => save.mutate()} disabled={save.isPending}>
            {save.isPending ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// =========================================================== STATUS BOARD

function StatusBoardPanel({
  data, loading, error, updatedAt, isAdmin, onChange,
}: {
  data?: StatusBoard; loading: boolean; error: unknown; updatedAt: number | undefined;
  isAdmin?: boolean; onChange?: () => void;
}) {
  const counts = useMemo(() => ({
    onDuty: data?.onDuty.length ?? 0,
    late: data?.late.length ?? 0,
    noShow: data?.noShow.length ?? 0,
    earlyOut: data?.earlyOut.length ?? 0,
    completed: data?.completed.length ?? 0,
    scheduled: data?.scheduled.length ?? 0,
  }), [data]);

  const stuckCount = useMemo(() => data?.onDuty.filter((r) => r.stuck).length ?? 0, [data]);

  // Admin-only on-behalf clock control. We track the busy row id so only the
  // tapped button shows a spinner while the others stay live.
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [clockError, setClockError] = useState<string | null>(null);

  const clockIn = useMutation({
    mutationFn: (r: StatusRow) =>
      api(`/dispatch/officers/${r.userId}/clock-in`, { method: "POST", body: { shiftId: r.shiftId } }),
    onMutate: (r) => { setClockError(null); setPendingId(r.assignmentId); },
    onSuccess: () => onChange?.(),
    onError: (e) => setClockError(e instanceof Error ? e.message : "Could not clock in officer."),
    onSettled: () => setPendingId(null),
  });
  const clockOut = useMutation({
    mutationFn: (r: StatusRow) =>
      api(`/dispatch/officers/${r.userId}/clock-out`, {
        method: "POST",
        body: r.timeEntryId ? { timeEntryId: r.timeEntryId } : {},
      }),
    onMutate: (r) => { setClockError(null); setPendingId(r.assignmentId); },
    onSuccess: () => onChange?.(),
    onError: (e) => setClockError(e instanceof Error ? e.message : "Could not clock out officer."),
    onSettled: () => setPendingId(null),
  });

  const clockProps = isAdmin
    ? {
        isAdmin: true as const,
        pendingId,
        onClockIn: (r: StatusRow) => clockIn.mutate(r),
        onClockOut: (r: StatusRow) => clockOut.mutate(r),
      }
    : {};

  // Closing a STUCK entry reuses PATCH /time-entries/:id/clock-out (the same
  // route the Payroll Board's "missing clock-out" fix uses) instead of the
  // dispatch on-behalf clock-out above — it snaps a shift-linked entry to its
  // scheduled end (so hours aren't inflated by however long it sat stuck)
  // and is audit-logged with who closed it.
  const [closeTarget, setCloseTarget] = useState<StatusRow | null>(null);
  const [closeError, setCloseError] = useState<string | null>(null);
  const closeStuck = useMutation({
    mutationFn: (r: StatusRow) =>
      api(`/time-entries/${r.timeEntryId}/clock-out`, {
        method: "PATCH",
        body: r.shiftId ? { useShiftEnd: true } : { clockOutTime: new Date().toISOString() },
      }),
    onSuccess: () => { setCloseTarget(null); onChange?.(); },
    onError: (e) => setCloseError(e instanceof Error ? e.message : "Could not close this shift."),
  });

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <UserCheck className="w-5 h-5 brand-gold" />
          Clock-In Status Board
          <span className="ml-auto flex items-center gap-2 text-xs opacity-60 font-normal">
            <span>Today · late ≥10m</span>
            <FreshnessLabel updatedAt={updatedAt} />
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <InlineError error={error} />
        {loading && <div className="text-sm opacity-60">Loading…</div>}
        {!loading && data && stuckCount > 0 && (
          <div className="mb-3 flex items-center gap-2 rounded border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-800">
            <AlertTriangle className="w-4 h-4 shrink-0" />
            <span>
              {stuckCount} {stuckCount === 1 ? "officer has" : "officers have"} a shift open well past when it should
              have ended, blocking their next clock-in. See the "On duty" tab below to close {stuckCount === 1 ? "it" : "them"}.
            </span>
          </div>
        )}
        {!loading && data && (
          <Tabs defaultValue="onDuty">
            <TabsList className="grid grid-cols-6 w-full">
              <TabsTrigger value="onDuty">On duty<Pill n={counts.onDuty} tone={stuckCount > 0 ? "bad" : "ok"} /></TabsTrigger>
              <TabsTrigger value="late">Late<Pill n={counts.late} tone="warn" /></TabsTrigger>
              <TabsTrigger value="noShow">No show<Pill n={counts.noShow} tone="bad" /></TabsTrigger>
              <TabsTrigger value="earlyOut">Early out<Pill n={counts.earlyOut} tone="warn" /></TabsTrigger>
              <TabsTrigger value="completed">Completed<Pill n={counts.completed} tone="ok" /></TabsTrigger>
              <TabsTrigger value="scheduled">Scheduled<Pill n={counts.scheduled} tone="muted" /></TabsTrigger>
            </TabsList>
            <BucketTab
              value="onDuty" rows={data.onDuty} emptyMsg="No one clocked in." showClockIn clockAction="out" {...clockProps}
              onCloseStuck={isAdmin ? (r: StatusRow) => { setCloseError(null); setCloseTarget(r); } : undefined}
            />
            <BucketTab value="late" rows={data.late} emptyMsg="No late officers." showMinutesLate clockAction="in" {...clockProps} />
            <BucketTab value="noShow" rows={data.noShow} emptyMsg="No no-shows." showMinutesLate clockAction="in" {...clockProps} />
            <BucketTab value="earlyOut" rows={data.earlyOut} emptyMsg="No early clock-outs." showMinutesEarly />
            <BucketTab value="completed" rows={data.completed} emptyMsg="No completed shifts yet." showClockOut />
            <BucketTab value="scheduled" rows={data.scheduled} emptyMsg="Nothing upcoming." clockAction="in" {...clockProps} />
          </Tabs>
        )}
        {clockError && <div className="mt-2 text-xs text-red-700">{clockError}</div>}
      </CardContent>
      <Dialog open={!!closeTarget} onOpenChange={(o) => { if (!o) { setCloseTarget(null); setCloseError(null); } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Close {closeTarget?.officerName}'s stuck shift?</DialogTitle>
            <DialogDescription>
              This officer has been clocked in for {closeTarget?.hoursOpen}h without clocking out, which is blocking
              their next clock-in.{" "}
              {closeTarget?.shiftId
                ? "We'll close it at the shift's scheduled end time, matching the Payroll Board's fix-clock-out."
                : "This entry has no shift attached, so we'll close it using the current time."}
            </DialogDescription>
          </DialogHeader>
          {closeError && <div className="text-xs text-red-700">{closeError}</div>}
          <DialogFooter>
            <Button variant="ghost" onClick={() => { setCloseTarget(null); setCloseError(null); }}>Cancel</Button>
            <Button
              variant="destructive"
              disabled={closeStuck.isPending}
              onClick={() => closeTarget && closeStuck.mutate(closeTarget)}
            >
              {closeStuck.isPending ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
              Close shift
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

function Pill({ n, tone }: { n: number; tone: "ok" | "warn" | "bad" | "muted" }) {
  const cls = {
    ok: "bg-emerald-600 text-white",
    warn: "bg-amber-500 text-black",
    bad: "bg-red-600 text-white",
    muted: "bg-slate-300 text-slate-700",
  }[tone];
  return <span className={`ml-1.5 inline-flex items-center justify-center min-w-[1.25rem] h-4 px-1 rounded-full text-[10px] ${cls}`}>{n}</span>;
}

function BucketTab({
  value, rows, emptyMsg, showMinutesLate, showMinutesEarly, showClockIn, showClockOut,
  isAdmin, clockAction, pendingId, onClockIn, onClockOut, onCloseStuck,
}: {
  value: string; rows: StatusRow[]; emptyMsg: string;
  showMinutesLate?: boolean; showMinutesEarly?: boolean; showClockIn?: boolean;
  showClockOut?: boolean;
  isAdmin?: boolean; clockAction?: "in" | "out"; pendingId?: string | null;
  onClockIn?: (r: StatusRow) => void; onClockOut?: (r: StatusRow) => void;
  onCloseStuck?: (r: StatusRow) => void;
}) {
  return (
    <TabsContent value={value} className="mt-3 max-h-72 overflow-y-auto space-y-1">
      {rows.length === 0 ? (
        <div className="text-sm opacity-60 py-4 text-center">{emptyMsg}</div>
      ) : rows.map((r) => (
        <div
          key={r.assignmentId}
          className={`flex items-center gap-2 text-sm rounded border bg-card px-3 py-2 ${r.stuck ? "border-red-300" : ""}`}
        >
          <div className="flex-1 min-w-0">
            <div className="font-medium truncate flex items-center gap-1.5">
              {r.officerName}
              {r.stuck && <Badge className="bg-red-600 text-white">Stuck · {r.hoursOpen}h</Badge>}
            </div>
            <div className="text-xs opacity-70 truncate">
              {r.siteName ?? "—"} · {fmtTime(r.startTime)}–{fmtTime(r.endTime)}
            </div>
          </div>
          <div className="text-right text-xs whitespace-nowrap">
            {showClockIn && r.clockInTime && <div className="opacity-70">in {fmtAgo(r.clockInTime)}</div>}
            {showClockOut && r.clockOutTime && <div className="opacity-70">out {fmtAgo(r.clockOutTime)}</div>}
            {showMinutesLate && r.minutesLate != null && (
              <Badge className="bg-amber-500 text-black">{r.minutesLate}m late</Badge>
            )}
            {showMinutesEarly && r.minutesEarly != null && (
              <Badge className="bg-orange-500 text-white">{r.minutesEarly}m early</Badge>
            )}
          </div>
          {r.stuck && onCloseStuck && (
            <Button
              size="sm" variant="destructive" className="h-7 text-xs"
              onClick={() => onCloseStuck(r)}
            >
              Close shift
            </Button>
          )}
          {isAdmin && clockAction === "in" && onClockIn && (
            <Button
              size="sm" variant="outline" className="h-7 text-xs"
              disabled={pendingId === r.assignmentId}
              onClick={() => onClockIn(r)}
            >
              {pendingId === r.assignmentId ? "…" : "Clock in"}
            </Button>
          )}
          {isAdmin && clockAction === "out" && !r.stuck && onClockOut && (
            <Button
              size="sm" variant="outline" className="h-7 text-xs"
              disabled={pendingId === r.assignmentId}
              onClick={() => onClockOut(r)}
            >
              {pendingId === r.assignmentId ? "…" : "Clock out"}
            </Button>
          )}
        </div>
      ))}
    </TabsContent>
  );
}

// =========================================================== OPEN SHIFTS — STAFFING BOARD

/**
 * Two-column drag-and-drop staffing board.
 *   LEFT  — open shift cards act as drop targets (click to select, drag an officer onto)
 *   RIGHT — eligible officer roster for the selected shift, site-veteran-first then
 *           nearest; each card is draggable onto any open shift
 *
 * Drop path validates eligibility client-side (no conflict, meets license) before
 * POSTing to /shifts/:id/assignments; server re-validates. License overrides still
 * go through the "Assign" dialog (which passes overrideLicense to the server).
 */
function OpenShiftsPanel({
  data, loading, error, updatedAt, onChange,
}: {
  data: OpenShift[]; loading: boolean; error: unknown; updatedAt: number | undefined;
  onChange: () => void;
}) {
  const qc = useQueryClient();
  const [selectedShiftId, setSelectedShiftId] = useState<string | null>(null);
  const [pickerShiftId, setPickerShiftId] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [dragOverShiftId, setDragOverShiftId] = useState<string | null>(null);
  const [assigningShiftId, setAssigningShiftId] = useState<string | null>(null);
  const [dropError, setDropError] = useState<string | null>(null);
  // The shift whose assignment the server never confirmed: still running under
  // its key when `api()` stopped waiting. A save in progress, not a refusal, so
  // it never becomes a `dropError` — the board is refreshed and dropping again
  // stays safe, since the same key can only replay, never assign twice.
  const [stillSavingShiftId, setStillSavingShiftId] = useState<string | null>(null);

  // Deselect if the currently-selected shift gets fully staffed and leaves the list.
  useEffect(() => {
    if (selectedShiftId && !data.find((s) => s.id === selectedShiftId)) {
      setSelectedShiftId(null);
    }
  }, [data, selectedShiftId]);

  // Dry-run candidate fetch for the selected shift (site-veteran-first from server).
  const candidatesQuery = useQuery<AssignNearestResult>({
    queryKey: ["dispatch", "assign-nearest", selectedShiftId],
    queryFn: () =>
      api<AssignNearestResult>("/dispatch/assign-nearest", {
        method: "POST",
        body: { shiftId: selectedShiftId!, dryRun: true },
      }),
    enabled: !!selectedShiftId,
    staleTime: 30_000,
  });

  // One intent per (shift, officer): a repeated drop of the same officer onto
  // the same shift reuses its idempotency key and replays the first
  // assignment rather than creating a second one.
  const intent = useIdempotentIntent();
  const assignMutation = useMutation({
    mutationFn: ({ shiftId, employeeId }: { shiftId: string; employeeId: string }) =>
      intent.run(`assign:${shiftId}:${employeeId}`, (idempotencyKey) =>
        api(`/shifts/${shiftId}/assignments`, {
          method: "POST",
          idempotencyKey,
          body: { employeeId, status: "accepted" },
        }),
      ),
    onSuccess: () => {
      onChange();
      // Refresh the officer roster so the just-assigned officer disappears.
      qc.invalidateQueries({ queryKey: ["dispatch", "assign-nearest", selectedShiftId] });
    },
    onError: (e, vars) => {
      if (isStillProcessing(e)) {
        setStillSavingShiftId(vars.shiftId);
        // It may have landed while we waited — refresh so a completed
        // assignment shows itself on the board rather than staying invisible.
        onChange();
      } else {
        setDropError(e instanceof Error ? e.message : "Could not assign officer.");
      }
    },
    onSettled: () => setAssigningShiftId(null),
  });

  const handleDragStart = (e: React.DragEvent, c: Candidate) => {
    e.dataTransfer.setData("application/wcsg-officer", JSON.stringify({
      userId: c.userId,
      name: c.name,
      meetsLicense: c.meetsLicense,
      conflictingShift: c.conflictingShift ?? false,
      alreadyAssigned: c.alreadyAssigned,
    }));
    e.dataTransfer.effectAllowed = "move";
  };

  const handleDragOverShift = (e: React.DragEvent, shiftId: string) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    if (dragOverShiftId !== shiftId) setDragOverShiftId(shiftId);
  };

  const handleDragLeaveShift = (e: React.DragEvent) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
      setDragOverShiftId(null);
    }
  };

  const handleDropOnShift = (e: React.DragEvent, shiftId: string) => {
    e.preventDefault();
    setDragOverShiftId(null);
    setDropError(null);
    const raw = e.dataTransfer.getData("application/wcsg-officer");
    if (!raw) return;
    try {
      const officer = JSON.parse(raw) as {
        userId: string; name: string;
        meetsLicense?: boolean; conflictingShift?: boolean; alreadyAssigned?: boolean;
      };
      if (officer.alreadyAssigned) {
        setDropError(`${officer.name} is already assigned to this shift.`);
        return;
      }
      if (officer.conflictingShift) {
        setDropError(`${officer.name} has a conflicting shift during this window.`);
        return;
      }
      if (officer.meetsLicense === false) {
        setDropError(`${officer.name} doesn't meet the license requirement. Use "Assign" to override.`);
        return;
      }
      setStillSavingShiftId(null);
      setAssigningShiftId(shiftId);
      assignMutation.mutate({ shiftId, employeeId: officer.userId });
    } catch {
      setDropError("Could not read drag data — try again.");
    }
  };

  const selectedShift = data.find((s) => s.id === selectedShiftId) ?? null;
  const allCandidates = candidatesQuery.data?.candidates ?? [];
  const siteHasCoords = candidatesQuery.data?.siteHasCoords ?? true;
  const eligibleCandidates = allCandidates.filter(
    (c) => !c.alreadyAssigned && !c.conflictingShift && c.meetsLicense !== false,
  );
  const blockedCandidates = allCandidates.filter(
    (c) => c.alreadyAssigned || c.conflictingShift || c.meetsLicense === false,
  );

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Clock className="w-5 h-5 brand-gold" />
          Open Shifts — Staffing Board
          <span className="ml-auto flex items-center gap-2 text-xs opacity-60 font-normal">
            <span>{data.length} open</span>
            <FreshnessLabel updatedAt={updatedAt} />
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <InlineError error={error} />
        {dropError && (
          <div className="mb-3 rounded border border-amber-200 bg-amber-50 text-amber-900 text-xs px-3 py-2 flex items-center gap-2">
            <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
            <span className="flex-1">{dropError}</span>
            <button
              onClick={() => setDropError(null)}
              aria-label="Dismiss"
              className="opacity-60 hover:opacity-100 text-lg leading-none"
            >×</button>
          </div>
        )}
        {stillSavingShiftId && (
          <div role="status" className="mb-3 rounded border bg-muted/40 text-muted-foreground text-xs px-3 py-2">
            {STILL_SAVING_MESSAGE}
          </div>
        )}
        {loading && <div className="text-sm opacity-60">Loading…</div>}
        {!loading && !error && data.length === 0 && (
          <div className="text-sm opacity-60">All shifts in the next 72h are filled.</div>
        )}
        {data.length > 0 && (
          <div className="grid grid-cols-1 md:grid-cols-5 gap-3">
            {/* LEFT — open shift drop targets */}
            <div className="md:col-span-3 space-y-2 max-h-[28rem] overflow-y-auto pr-1">
              {data.map((shift) => {
                const isSelected = shift.id === selectedShiftId;
                const isDragOver = shift.id === dragOverShiftId;
                const isAssigning = shift.id === assigningShiftId;
                const isStillSaving = shift.id === stillSavingShiftId;
                const isUnreleased = !!shift.claimableFrom && new Date(shift.claimableFrom).getTime() > Date.now();
                return (
                  <div
                    key={shift.id}
                    role="button"
                    tabIndex={0}
                    aria-pressed={isSelected}
                    aria-label={`Select shift: ${shift.title ?? shift.siteName ?? "Shift"} — click to view officers, or drop an officer onto this card to assign`}
                    onClick={() => {
                      setSelectedShiftId(shift.id === selectedShiftId ? null : shift.id);
                      setDropError(null);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        setSelectedShiftId(shift.id === selectedShiftId ? null : shift.id);
                        setDropError(null);
                      }
                    }}
                    onDragOver={(e) => handleDragOverShift(e, shift.id)}
                    onDragLeave={handleDragLeaveShift}
                    onDrop={(e) => handleDropOnShift(e, shift.id)}
                    className={[
                      "rounded border bg-card p-3 cursor-pointer transition-all select-none outline-none",
                      "focus-visible:ring-2 focus-visible:ring-brand-gold",
                      isSelected ? "border-brand-gold ring-1 ring-brand-gold" : "hover:border-brand-gold/50",
                      isDragOver ? "border-brand-gold ring-2 ring-brand-gold bg-brand-gold/10" : "",
                    ].join(" ")}
                  >
                    <div className="flex items-start gap-2">
                      <div className="flex-1 min-w-0">
                        <div className="font-medium text-sm">{shift.title ?? shift.siteName ?? "Shift"}</div>
                        <div className="text-xs opacity-70">
                          <span className="font-medium">{fmtDate(shift.startTime)}</span>
                          {" · "}{shift.siteName ?? "—"}
                          {" · "}{fmtTime(shift.startTime)} – {fmtTime(shift.endTime)}
                        </div>
                        <div className="text-xs opacity-60 mt-1 flex flex-wrap gap-2">
                          {shift.filled > 0 && shift.filled < shift.headcount ? (
                            <span className="font-medium text-amber-700">
                              {shift.headcount - shift.filled} of {shift.headcount} slot{shift.headcount - shift.filled === 1 ? "" : "s"} still open ({shift.filled} assigned)
                            </span>
                          ) : (
                            <span>{shift.filled} / {shift.headcount} filled</span>
                          )}
                          <span>· L{shift.requiredLicenseLevel}+</span>
                          {shift.payRate && <span>· ${shift.payRate}/hr</span>}
                        </div>
                        {isUnreleased && (
                          <div className="mt-1 inline-flex items-center gap-1 rounded border border-sky-300 bg-sky-100 px-1.5 py-0.5 text-xs font-medium text-sky-800">
                            <Timer className="w-3 h-3" />
                            Opens {new Date(shift.claimableFrom!).toLocaleString("en-US", {
                              timeZone: "America/Chicago",
                              weekday: "short",
                              month: "short",
                              day: "numeric",
                              hour: "numeric",
                              minute: "2-digit",
                            })} CT
                          </div>
                        )}
                        {isDragOver && (
                          <div className="text-xs text-brand-gold font-semibold mt-1 animate-pulse">
                            ↓ Drop to assign
                          </div>
                        )}
                        {isAssigning && (
                          <div role="status" className="text-xs text-brand-gold font-medium mt-1">
                            <Loader2 className="w-3 h-3 inline animate-spin mr-1" />Assigning…
                          </div>
                        )}
                        {!isAssigning && isStillSaving && (
                          <div className="text-xs text-muted-foreground font-medium mt-1">
                            Still saving — not confirmed yet
                          </div>
                        )}
                      </div>
                      {/* Stop click propagation so buttons don't toggle the selection */}
                      <div
                        className="flex flex-col gap-1 shrink-0"
                        onClick={(e) => e.stopPropagation()}
                        onKeyDown={(e) => e.stopPropagation()}
                      >
                        <Button
                          size="sm"
                          onClick={() => { setPickerShiftId(shift.id); setPickerOpen(true); }}
                        >
                          <Users className="w-3.5 h-3.5 mr-1" /> Assign
                        </Button>
                        <ShiftNotifyButton shiftId={shift.id} />
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>

            {/* RIGHT — draggable officer roster for the selected shift */}
            <div className="md:col-span-2">
              {!selectedShiftId ? (
                <div className="h-full min-h-[120px] flex items-center justify-center rounded-lg border-2 border-dashed text-xs opacity-40 text-center p-4">
                  <div>
                    <Users className="w-6 h-6 mx-auto mb-2 opacity-60" />
                    Click a shift to see<br />available officers
                  </div>
                </div>
              ) : (
                <div className="space-y-2">
                  <div className="text-xs font-semibold opacity-70 flex items-center gap-1 flex-wrap">
                    <span>
                      {selectedShift?.siteName
                        ? `Officers for ${selectedShift.siteName}`
                        : "Available Officers"}
                    </span>
                    <span className="font-normal opacity-60">— drag to assign</span>
                  </div>
                  {!siteHasCoords && (
                    <div className="text-[11px] bg-amber-50 border border-amber-200 text-amber-800 rounded px-2 py-1">
                      No site coordinates — ordering by recent ping.
                    </div>
                  )}
                  {candidatesQuery.isLoading && (
                    <div className="text-xs opacity-50 flex items-center gap-1.5 py-2">
                      <Loader2 className="w-3.5 h-3.5 animate-spin" /> Ranking officers…
                    </div>
                  )}
                  {candidatesQuery.isError && (
                    <div className="text-xs text-red-700 py-1">Could not load officers.</div>
                  )}
                  <div className="space-y-1 max-h-[24rem] overflow-y-auto">
                    {!candidatesQuery.isLoading && eligibleCandidates.length === 0 && blockedCandidates.length === 0 && (
                      <div className="text-xs opacity-40 text-center py-4">No eligible officers available.</div>
                    )}
                    {eligibleCandidates.map((c) => (
                      <div
                        key={c.userId}
                        draggable
                        onDragStart={(e) => handleDragStart(e, c)}
                        className="flex items-center gap-1.5 rounded border bg-card px-2 py-1.5 text-xs cursor-grab active:cursor-grabbing hover:border-brand-gold/70 hover:bg-brand-gold/5 transition-colors select-none"
                        title={`Drag ${c.name} onto a shift to assign`}
                      >
                        {c.workedSiteBefore && (
                          <span
                            className="text-amber-500 shrink-0 text-sm leading-none"
                            title="Has worked this site before"
                          >★</span>
                        )}
                        <span className="flex-1 min-w-0 truncate font-medium">{c.name}</span>
                        <span className="text-[11px] opacity-55 shrink-0 whitespace-nowrap">
                          {c.distanceMiles != null ? `${c.distanceMiles.toFixed(1)} mi` : "no GPS"}
                        </span>
                      </div>
                    ))}
                    {blockedCandidates.length > 0 && (
                      <>
                        {eligibleCandidates.length > 0 && (
                          <div className="text-[11px] opacity-40 pt-1.5 pb-0.5 border-t">Unavailable</div>
                        )}
                        {blockedCandidates.map((c) => {
                          const reason = candidateBlockReason(c);
                          return (
                            <div
                              key={c.userId}
                              className="flex items-center gap-1.5 rounded border bg-card px-2 py-1.5 text-xs opacity-40 cursor-not-allowed select-none"
                            >
                              <div className="flex-1 min-w-0">
                                <div className="truncate">{c.name}</div>
                                {reason && <div className="text-[11px]">{reason}</div>}
                              </div>
                            </div>
                          );
                        })}
                      </>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {pickerShiftId && (
          <AssignNearestDialog
            shiftId={pickerShiftId}
            open={pickerOpen}
            onOpenChange={(v) => { setPickerOpen(v); if (!v) setPickerShiftId(null); }}
            onAssigned={() => {
              onChange();
              qc.invalidateQueries({ queryKey: ["dispatch", "assign-nearest", selectedShiftId] });
            }}
          />
        )}
      </CardContent>
    </Card>
  );
}

function ShiftNotifyButton({ shiftId }: { shiftId: string }) {
  const notify = useMutation({
    mutationFn: () => api(`/shifts/${shiftId}/notify-vacancy`, { method: "POST" }),
  });
  return (
    <Button
      size="sm"
      variant="outline"
      onClick={() => notify.mutate()}
      disabled={notify.isPending}
    >
      {notify.isPending
        ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
        : <Megaphone className="w-3.5 h-3.5 mr-1" />}
      Notify
    </Button>
  );
}

// =========================================================== SHIFT CLAIMS

function claimLevelBadge(level: number): { label: string; cls: string } {
  if (level >= 4) return { label: "L4 / PPO", cls: "bg-purple-100 text-purple-800 border-purple-300" };
  if (level === 3) return { label: "L3 Armed", cls: "bg-amber-100 text-amber-800 border-amber-300" };
  if (level <= 1) return { label: "L1", cls: "bg-slate-100 text-slate-700 border-slate-300" };
  return { label: "L2", cls: "bg-slate-100 text-slate-700 border-slate-300" };
}

/**
 * Officer self-claims awaiting an approve/decline decision. Mirrors the Shifts
 * page Shift Claims panel — same `PUT /shifts/:id/assignments/:assignmentId`
 * call with `accepted` (confirm) / `declined` (free the slot). After a decision
 * we invalidate the dispatch queries so this panel and the status board refresh.
 */
function ShiftClaimsPanel({
  claims, loading, error, updatedAt, onChange,
}: {
  claims: PendingClaim[]; loading: boolean; error: unknown;
  updatedAt: number | undefined; onChange: () => void;
}) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const decide = useMutation({
    mutationFn: ({ shiftId, assignmentId, decision }: { shiftId: string; assignmentId: string; decision: "accepted" | "declined" }) =>
      api(`/shifts/${shiftId}/assignments/${assignmentId}`, { method: "PUT", body: { status: decision } }),
    onMutate: ({ assignmentId }) => { setBusyId(assignmentId); setActionError(null); },
    onSuccess: () => { onChange(); },
    onError: (e: unknown) => {
      setActionError(e instanceof Error ? e.message : "Could not update the claim.");
    },
    onSettled: () => { setBusyId(null); },
  });

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <UserCheck className="w-5 h-5 brand-gold" />
          Shift Claims — Awaiting Approval
          <span className="ml-auto flex items-center gap-2 text-xs opacity-60 font-normal">
            <span>{claims.length} pending</span>
            <FreshnessLabel updatedAt={updatedAt} />
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 max-h-[24rem] overflow-y-auto">
        <InlineError error={error} />
        {actionError && (
          <div className="rounded border border-red-200 bg-red-50 text-red-900 text-xs px-3 py-2 flex items-center gap-2">
            <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" />
            <span className="truncate">{actionError}</span>
          </div>
        )}
        {loading && <div className="text-sm opacity-60">Loading…</div>}
        {!loading && !error && claims.length === 0 && (
          <div className="text-sm opacity-60">No officer shift claims awaiting approval.</div>
        )}
        {claims.map((c) => {
          const busy = busyId === c.assignmentId;
          const lvl = claimLevelBadge(c.requiredLicenseLevel);
          return (
            <div key={c.assignmentId} className="rounded border bg-card p-3 flex flex-wrap items-center gap-3">
              <div className="flex-1 min-w-0">
                <div className="font-medium text-sm truncate">{c.employeeName ?? "Officer"}</div>
                <div className="text-xs opacity-70 truncate">
                  {c.shiftTitle ?? "Shift"}{c.clientName ? ` · ${c.clientName}` : ""}{c.location ? ` · ${c.location}` : ""}
                </div>
                <div className="text-xs opacity-70">
                  {fmtDate(c.startTime)} · {fmtTime(c.startTime)} – {fmtTime(c.endTime)}
                </div>
              </div>
              <span className={`text-xs px-2 py-0.5 rounded border ${lvl.cls}`}>{lvl.label}</span>
              <div className="flex items-center gap-2 shrink-0">
                <Button
                  size="sm"
                  disabled={busy}
                  onClick={() => decide.mutate({ shiftId: c.shiftId, assignmentId: c.assignmentId, decision: "accepted" })}
                >
                  {busy ? <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" /> : <CheckCircle2 className="w-3.5 h-3.5 mr-1" />}
                  Approve
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  className="border-red-300 text-red-700 hover:bg-red-50"
                  onClick={() => decide.mutate({ shiftId: c.shiftId, assignmentId: c.assignmentId, decision: "declined" })}
                >
                  <X className="w-3.5 h-3.5 mr-1" /> Decline
                </Button>
              </div>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}

// =========================================================== LIVE MAP

/**
 * Read the server-configured geofence radius (miles) so the dispatch map
 * draws the same circle the backend uses to fire breach alerts. Uses
 * /dispatch/config (admin OR dispatcher-accessible) so the map renders
 * the correct boundary for both roles. Cached for 5 minutes — env-driven
 * config doesn't need real-time freshness. Falls back to the same 0.25mi
 * default the backend uses on any failure so the map still renders.
 */
function useGeofenceRadiusMiles(): number {
  const { data } = useQuery({
    queryKey: ["dispatch-config", "geofenceRadiusMiles"],
    queryFn: async (): Promise<number> => {
      try {
        const body = await api<{ geofenceRadiusMiles?: number }>("/dispatch/config");
        const n = body.geofenceRadiusMiles;
        return typeof n === "number" && isFinite(n) && n > 0 ? n : 0.25;
      } catch {
        return 0.25;
      }
    },
    staleTime: 5 * 60 * 1000,
    gcTime: 30 * 60 * 1000,
    retry: false,
  });
  return data ?? 0.25;
}

type MapPoint = {
  kind: "officer" | "incident" | "site";
  lat: number;
  lng: number;
  label: string;
  sub: string;
  severity?: "low" | "medium" | "high" | "critical";
  // Pin-deep-link target. Set on officer/incident pins so the popup can
  // render a "View profile" / "View incident" button that postMessages
  // the id up to the parent dispatch shell. Sites have nowhere to go
  // (covered by the dedicated /sites/:id route from the personnel grid).
  officerId?: string;
  incidentId?: string;
  /** SOS contact info — set only on critical incident pins (staff-only
   *  surface). The popup renders Call/Email actions that postMessage up
   *  to the parent shell, which validates and opens tel:/mailto:. */
  phone?: string;
  email?: string;
  /** Per-site effective geofence radius (miles). Set on `kind:"site"`
   *  points so the map draws each site's circle at its own size — sites
   *  with a per-site override (`sites.geofence_radius_miles`) draw at
   *  that value, others fall back to the global default. */
  radiusMiles?: number;
};

// Random value re-evaluated on every HMR reload of this module. Included in
// the iframe-srcdoc useMemo deps so that dev-time edits to the map template
// actually take effect without a hard refresh of the browser tab.
const MAP_BUILD_ID = Math.random().toString(36).slice(2, 10);

function buildLeafletHtml(
  points: MapPoint[],
  defaultGeofenceRadiusMiles: number,
  focusCenter?: { lat: number; lng: number },
  initialTileLayer: "street" | "satellite" = "street",
): string {
  // Coordinates are validated numbers; labels are JSON-encoded then
  // injected into the DOM via createTextNode, never innerHTML.
  // CRITICAL: we MUST escape `<` (and the U+2028/U+2029 line separators
  // some browsers treat as JS line terminators) before interpolating
  // into a <script> tag — otherwise a malicious officer name like
  // `</script><script>alert(1)` would break out of the script context
  // and execute in the admin origin. createTextNode protects DOM-side
  // rendering but not the parser pre-pass.
  const data = JSON.stringify(points)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
  // Server geofence is evaluated in miles → convert to meters for L.circle.
  // Clamp to a sane range so a misconfigured env can't paint the whole map.
  // This is the FALLBACK used when a site point doesn't carry its own
  // effective radius (e.g. older payload shape). Per-site overrides ride
  // along on each MapPoint and are clamped inside the iframe script.
  const defaultRadiusMeters = Math.max(10, Math.min(defaultGeofenceRadiusMiles * 1609.344, 50_000));
  return `<!doctype html><html><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"/>
<style>html,body,#m{margin:0;padding:0;height:100%;background:#0c0a08}
.popup{font:13px -apple-system,system-ui,sans-serif}.popup b{color:#0c0a08}
.popup-btn{margin-top:6px;background:#0c0a08;color:#c9a04a;border:1px solid #c9a04a;border-radius:4px;padding:4px 8px;font-size:12px;font-weight:600;cursor:pointer;font-family:inherit}
.popup-btn:hover{background:#c9a04a;color:#0c0a08}
.site-pin{display:flex;align-items:center;justify-content:center;width:28px;height:28px;border-radius:6px;background:#0c0a08;color:#c9a04a;border:2px solid #c9a04a;font:bold 13px -apple-system,system-ui,sans-serif;box-shadow:0 1px 4px rgba(0,0,0,.35)}
.officer-pin{filter:drop-shadow(0 1px 3px rgba(0,0,0,.55))}
.sos-pin{position:relative;width:34px;height:34px}
.sos-ring{position:absolute;left:0;top:0;width:34px;height:34px;border-radius:50%;background:rgba(220,38,38,.55);animation:sosring 1.2s ease-out infinite}
.sos-core{position:absolute;left:4px;top:4px;width:26px;height:26px;border-radius:50%;background:#dc2626;border:2px solid #fff;color:#fff;display:flex;align-items:center;justify-content:center;font:800 9px -apple-system,system-ui,sans-serif;box-shadow:0 0 10px rgba(220,38,38,.9);animation:sosblink 1.2s step-start infinite;box-sizing:border-box}
@keyframes sosring{0%{transform:scale(.55);opacity:.9}100%{transform:scale(2.3);opacity:0}}
@keyframes sosblink{0%,100%{background:#dc2626}50%{background:#8f1d1d}}
@media (prefers-reduced-motion:reduce){.sos-ring{animation:none;transform:scale(1.35);opacity:.3}.sos-core{animation:none}}
.popup-contact{margin-top:6px;font-size:12px}
.popup-btn-sos{background:#dc2626;color:#fff;border-color:#dc2626}
.popup-btn-sos:hover{background:#b91c1c;color:#fff}</style>
</head><body><div id="m"></div>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<script>
const pts = ${data};
const DEFAULT_GEOFENCE_RADIUS_M = ${defaultRadiusMeters};
function resolveRadiusM(p){
  // Per-site override (miles, already resolved server-side) wins; otherwise
  // fall back to the global default. Clamp to the same sane bounds the
  // outer renderer uses so a bad row can't paint the whole map.
  var miles = typeof p.radiusMiles === 'number' && isFinite(p.radiusMiles) && p.radiusMiles > 0
    ? p.radiusMiles : null;
  if (miles === null) return DEFAULT_GEOFENCE_RADIUS_M;
  return Math.max(10, Math.min(miles * 1609.344, 50000));
}
const SEV = { critical:'#dc2626', high:'#ea580c', medium:'#eab308', low:'#94a3b8' };
// Static icon markup (no user input ever interpolated here).
const OFFICER_SVG='<svg width="24" height="26" viewBox="0 0 24 26" aria-hidden="true"><path d="M12 1l10 3.5v7c0 6.5-4.3 11.4-10 13.5C6.3 22.9 2 18 2 11.5v-7L12 1z" fill="#c9a04a" stroke="#0c0a08" stroke-width="1.6"/><path d="M12 6.5l1.7 3.4 3.7.6-2.7 2.6.7 3.7-3.4-1.8-3.4 1.8.7-3.7-2.7-2.6 3.7-.6L12 6.5z" fill="#0c0a08"/></svg>';
const SITE_SVG='<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#c9a04a" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 22V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v18"/><path d="M2 22h20"/><path d="M9 7h1"/><path d="M14 7h1"/><path d="M9 11h1"/><path d="M14 11h1"/><path d="M9 15h1"/><path d="M14 15h1"/></svg>';
function popup(p){
  const w=document.createElement('div');w.className='popup';
  const b=document.createElement('b');b.appendChild(document.createTextNode(String(p.label||'')));
  w.appendChild(b);w.appendChild(document.createElement('br'));
  w.appendChild(document.createTextNode(String(p.sub||'')));
  // SOS pins carry the officer's contact info so a dispatcher can reach
  // them in one tap. Values render via createTextNode and are handed to
  // the parent shell as strings in a structured postMessage — the parent
  // validates the format before opening tel:/mailto: (this sandboxed
  // iframe cannot navigate on its own).
  if (p.phone) {
    const row=document.createElement('div');row.className='popup-contact';
    row.appendChild(document.createTextNode('Phone: '+String(p.phone)));
    w.appendChild(row);
  }
  if (p.phone || p.email) {
    const btns=document.createElement('div');
    if (p.phone) {
      const call=document.createElement('button');
      call.className='popup-btn popup-btn-sos';
      call.appendChild(document.createTextNode('Call officer'));
      call.addEventListener('click', function(){
        try { parent.postMessage({ type:'wcsg:call', phone:String(p.phone) }, '*'); } catch(e) {}
      });
      btns.appendChild(call);
    }
    if (p.email) {
      const mail=document.createElement('button');
      mail.className='popup-btn';
      if (p.phone) mail.style.marginLeft='6px';
      mail.appendChild(document.createTextNode('Email'));
      mail.addEventListener('click', function(){
        try { parent.postMessage({ type:'wcsg:email', email:String(p.email) }, '*'); } catch(e) {}
      });
      btns.appendChild(mail);
    }
    w.appendChild(btns);
  }
  // Render a deep-link button on officer/incident pins. Built via
  // createElement + addEventListener (never innerHTML) so any officer-
  // controlled label/id can never break out into script context. The
  // id itself is sent as a string in a structured postMessage; the
  // parent admin shell validates and dispatches to the correct route.
  if (p.officerId || p.incidentId) {
    w.appendChild(document.createElement('br'));
    const btn=document.createElement('button');
    btn.className='popup-btn';
    btn.appendChild(document.createTextNode(p.officerId ? 'View profile' : 'View incident'));
    btn.addEventListener('click', function(){
      try {
        if (p.officerId) parent.postMessage({ type:'wcsg:openOfficer', userId:String(p.officerId) }, '*');
        else if (p.incidentId) parent.postMessage({ type:'wcsg:openIncident', incidentId:String(p.incidentId) }, '*');
      } catch(e) {}
    });
    w.appendChild(btn);
  }
  return w;
}
function tip(label, sub){
  // Leaflet's bindTooltip renders string content as HTML, so we MUST pass
  // an HTMLElement built with createTextNode — otherwise an officer name
  // like "<img onerror=...>" would execute inside the iframe.
  const w=document.createElement('div');
  const b=document.createElement('b');
  b.appendChild(document.createTextNode(String(label||'')));
  w.appendChild(b);
  if (sub) {
    w.appendChild(document.createElement('br'));
    const s=document.createElement('span');
    s.style.opacity='0.8';s.style.fontSize='11px';
    s.appendChild(document.createTextNode(String(sub)));
    w.appendChild(s);
  }
  return w;
}
const map = L.map('m',{zoomControl:true});
// Leaflet requires a view (center + zoom) BEFORE any layer that needs
// projection (L.circle uses a metric radius and projects on add). Without
// this, adding a circle throws "Cannot read properties of undefined
// (reading 'layerPointToLatLng')". fitBounds below replaces this view.
map.setView([39.8283,-98.5795],4);
var STREET_LAYER = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{
  attribution:'&copy; OpenStreetMap', maxZoom:19
});
var SATELLITE_LAYER = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',{
  attribution:'Imagery &copy; Esri', maxZoom:19
});
var currentTileLayer = '${initialTileLayer}' === 'satellite' ? SATELLITE_LAYER : STREET_LAYER;
currentTileLayer.addTo(map);
// Tile-layer toggle button
(function(){
  var btn=document.createElement('button');
  btn.id='tile-toggle';
  btn.title='Toggle Street / Satellite';
  btn.style.cssText='position:absolute;top:10px;right:10px;z-index:1000;background:#0c0a08;color:#c9a04a;border:1.5px solid #c9a04a;border-radius:5px;padding:5px 10px;font:bold 11px -apple-system,system-ui,sans-serif;cursor:pointer;box-shadow:0 1px 4px rgba(0,0,0,.5);letter-spacing:.03em;';
  var isSat = '${initialTileLayer}' === 'satellite';
  btn.textContent = isSat ? 'Street' : 'Satellite';
  btn.addEventListener('click',function(){
    map.removeLayer(currentTileLayer);
    isSat = !isSat;
    currentTileLayer = isSat ? SATELLITE_LAYER : STREET_LAYER;
    currentTileLayer.addTo(map);
    btn.textContent = isSat ? 'Street' : 'Satellite';
    try{ parent.postMessage({type:'wcsg:mapTileLayer',layer:isSat?'satellite':'street'},'*'); }catch(e){}
  });
  document.getElementById('m').appendChild(btn);
})();
if(pts.length){
  const group = L.featureGroup().addTo(map);
  pts.forEach(p=>{
    let m;
    if (p.kind === 'site') {
      // Site pins use a distinct square gold/navy icon so they read as
      // fixed locations vs. live circles for officers/incidents.
      // Around each site we also paint a translucent gold disc sized to
      // the configured geofence radius — dispatchers can see at a glance
      // when an officer pin drifts outside the same boundary the backend
      // uses to fire breach alerts. interactive:false + no popup/tooltip
      // keeps it visually subordinate to the live pins.
      L.circle([p.lat,p.lng], {
        radius: resolveRadiusM(p),
        color: '#c9a04a',
        weight: 1,
        opacity: 0.45,
        fillColor: '#c9a04a',
        fillOpacity: 0.08,
        interactive: false,
      }).addTo(group);
      const icon = L.divIcon({
        className:'', html:'<div class="site-pin">'+SITE_SVG+'</div>',
        iconSize:[28,28], iconAnchor:[14,14]
      });
      m = L.marker([p.lat,p.lng], { icon });
    } else if (p.kind === 'officer') {
      // Clocked-in officers render as a gold badge/shield so they read
      // instantly as personnel vs. buildings and incident pins.
      const icon = L.divIcon({
        className:'officer-pin', html:OFFICER_SVG,
        iconSize:[24,26], iconAnchor:[12,13]
      });
      m = L.marker([p.lat,p.lng], { icon, zIndexOffset:200 });
    } else if (p.severity === 'critical') {
      // SOS / critical incidents: flashing red beacon pinned above every
      // other marker. The CSS animation is suppressed for users with
      // prefers-reduced-motion (static red halo instead).
      const icon = L.divIcon({
        className:'', html:'<div class="sos-pin"><div class="sos-ring"></div><div class="sos-core">SOS</div></div>',
        iconSize:[34,34], iconAnchor:[17,17]
      });
      m = L.marker([p.lat,p.lng], { icon, zIndexOffset:1000 });
    } else {
      const color = SEV[p.severity]||'#94a3b8';
      m = L.circleMarker([p.lat,p.lng], {
        radius: 12, color, fillColor: color, fillOpacity: 0.95, weight: 4,
      });
    }
    m.bindPopup(popup(p));
    // Hover tooltip surfaces the name instantly without a click, which is
    // what dispatchers want when scanning bunching/gaps. Content is built
    // via createTextNode (see tip()), never as a raw string — Leaflet
    // bindTooltip treats string args as HTML.
    m.bindTooltip(tip(p.label, p.sub), { direction:'top', offset:[0,-6], opacity:0.95 });
    m.addTo(group);
  });
  // Compute fit bounds manually instead of group.getBounds(). FeatureGroup
  // iterates child layers and calls .getBounds() on each, which for L.circle
  // hits Circle.js:62 (this._map.layerPointToLatLng) and has thrown
  // "Cannot read properties of undefined" in this sandboxed iframe even after
  // .addTo(group). A lat/lng box, expanded by site radii, is bulletproof.
  const _bb = L.latLngBounds([]);
  pts.forEach(function(p){
    _bb.extend([p.lat, p.lng]);
    if (p.kind === 'site') {
      var rm = resolveRadiusM(p);
      var cosLat = Math.cos(p.lat * Math.PI / 180);
      var dLat = rm / 111320;
      var dLng = rm / (111320 * Math.max(0.01, cosLat));
      _bb.extend([p.lat - dLat, p.lng - dLng]);
      _bb.extend([p.lat + dLat, p.lng + dLng]);
    }
  });
  if (_bb.isValid()) map.fitBounds(_bb.pad(0.3), { maxZoom: 14 });
}
${focusCenter ? `try { map.setView([${focusCenter.lat}, ${focusCenter.lng}], 15); } catch (e) {}` : ""}
</script></body></html>`;
}

function LiveMapPanel({
  officers, sites, loading, error, updatedAt, incidents, onFocusIncident,
  focusUserId, focusSiteId, mapExpanded, onToggleExpand, mapTileLayer, onTileLayerChange,
}: {
  officers: ActiveOfficer[]; sites: Site[]; loading: boolean; error: unknown;
  updatedAt: number | undefined; incidents: Incident[];
  onFocusIncident: (incidentId: string) => void;
  focusUserId?: string | null;
  focusSiteId?: string | null;
  mapExpanded?: boolean;
  onToggleExpand?: () => void;
  mapTileLayer?: "street" | "satellite";
  onTileLayerChange?: (layer: "street" | "satellite") => void;
}) {
  const [, navigate] = useLocation();

  // Listen for popup clicks from inside the sandboxed leaflet iframe. We
  // accept only our known message shapes and validate every payload field
  // — every other message is ignored. The iframe is
  // sandbox="allow-scripts" (no allow-same-origin), so its origin is
  // "null" by design; filtering on shape + a `wcsg:` type prefix is the
  // right contract here. Officer pins navigate to the role-shared
  // /personnel/:id profile page; incident pins hand off to the
  // Dispatch page's IncidentsPanel which opens the existing edit dialog
  // — dispatcher-safe (no /incidents/share-links dependency).
  // SOS popups additionally request tel:/mailto: opens — the sandboxed
  // iframe can't navigate, so the parent validates the phone/email format
  // strictly before touching window.location.
  useEffect(() => {
    const handler = (ev: MessageEvent) => {
      const data = ev.data;
      if (!data || typeof data !== "object") return;
      const type = (data as { type?: unknown }).type;
      if (type === "wcsg:openOfficer") {
        const uid = (data as { userId?: unknown }).userId;
        if (typeof uid === "string" && uid.length > 0 && uid.length < 100) {
          navigate(`/personnel/${encodeURIComponent(uid)}`);
        }
      } else if (type === "wcsg:openIncident") {
        const iid = (data as { incidentId?: unknown }).incidentId;
        if (typeof iid === "string" && iid.length > 0 && iid.length < 100) {
          onFocusIncident(iid);
        }
      } else if (type === "wcsg:call") {
        const phone = (data as { phone?: unknown }).phone;
        // Allow-list of dial characters only, then strip to +digits for the
        // tel: URI so nothing else can ride along into the navigation.
        if (typeof phone === "string" && /^[+()\d\s.-]{7,24}$/.test(phone)) {
          const cleaned = phone.replace(/[^+\d]/g, "");
          if (cleaned.replace(/\D/g, "").length >= 7) {
            window.location.href = `tel:${cleaned}`;
          }
        }
      } else if (type === "wcsg:email") {
        const email = (data as { email?: unknown }).email;
        if (
          typeof email === "string" &&
          email.length <= 200 &&
          /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
        ) {
          window.location.href = `mailto:${encodeURIComponent(email)}`;
        }
      } else if (type === "wcsg:mapTileLayer") {
        const layer = (data as { layer?: unknown }).layer;
        if (layer === "street" || layer === "satellite") {
          onTileLayerChange?.(layer);
        }
      }
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, [navigate, onFocusIncident, onTileLayerChange]);

  const points = useMemo<MapPoint[]>(() => {
    const pts: MapPoint[] = [];
    // Only sites with someone currently clocked in get a marker — the map
    // is a live-ops view, not a site directory. A deep-linked site stays
    // visible so alert links still land on a pin.
    const staffedSiteIds = new Set<string>();
    for (const o of officers) {
      if (o.siteId) staffedSiteIds.add(o.siteId);
    }
    // Sites first so they sit underneath live circles when they overlap.
    for (const s of sites) {
      if (!staffedSiteIds.has(s.id) && s.id !== focusSiteId) continue;
      if (!s.locationLat || !s.locationLng) continue;
      const lat = parseFloat(s.locationLat); const lng = parseFloat(s.locationLng);
      if (!isFinite(lat) || !isFinite(lng)) continue;
      // Prefer the server-resolved effective radius (per-site override or
      // global default, computed once on the API). Fall back to the raw
      // override column if a stale client somehow lacks the decorated
      // field, otherwise leave undefined and let the iframe use the
      // global default.
      let radiusMiles: number | undefined;
      if (typeof s.effectiveGeofenceRadiusMiles === "number" && isFinite(s.effectiveGeofenceRadiusMiles) && s.effectiveGeofenceRadiusMiles > 0) {
        radiusMiles = s.effectiveGeofenceRadiusMiles;
      } else if (s.geofenceRadiusMiles != null) {
        const n = Number(s.geofenceRadiusMiles);
        if (isFinite(n) && n > 0) radiusMiles = n;
      }
      pts.push({
        kind: "site", lat, lng,
        label: s.name,
        sub: s.address ?? "site",
        radiusMiles,
      });
    }
    for (const o of officers) {
      if (!o.lastLat || !o.lastLng) continue;
      const lat = parseFloat(o.lastLat); const lng = parseFloat(o.lastLng);
      if (!isFinite(lat) || !isFinite(lng)) continue;
      pts.push({
        kind: "officer", lat, lng,
        label: `${o.firstName} ${o.lastName}`,
        sub: `${o.siteName ?? o.shiftTitle ?? "no site"} · ${fmtAgo(o.lastLocationAt)}`,
        officerId: o.userId,
      });
    }
    for (const i of incidents) {
      if (!i.lat || !i.lng) continue;
      const lat = parseFloat(i.lat); const lng = parseFloat(i.lng);
      if (!isFinite(lat) || !isFinite(lng)) continue;
      // Critical (SOS) pins carry the officer's contact info so the popup
      // can offer one-tap call/email. Staff-only data — this page is
      // admin/dispatcher-gated and the fields never reach client portals.
      const sos = i.severity === "critical";
      pts.push({
        kind: "incident", lat, lng,
        severity: i.severity,
        label: `[${i.severity.toUpperCase()}] ${i.title}`,
        sub: `${i.employeeName ?? i.locationDescription ?? i.status} · ${fmtAgo(i.createdAt)}`,
        incidentId: i.id,
        phone: sos ? (i.employeePhone ?? undefined) : undefined,
        email: sos ? (i.employeeEmail ?? undefined) : undefined,
      });
    }
    return pts;
  }, [officers, sites, incidents, focusSiteId]);

  const geofenceRadiusMiles = useGeofenceRadiusMiles();

  // Resolve a deep-link focus center: an officer (emergency / geofence-breach
  // alert) or a site. The map zooms here after fitBounds so the relevant pin
  // is centered (mirrors the mobile live-map deep link).
  const focusCenter = useMemo<{ lat: number; lng: number } | undefined>(() => {
    if (focusUserId) {
      const o = officers.find((x) => x.userId === focusUserId);
      if (o?.lastLat && o?.lastLng) {
        const lat = parseFloat(o.lastLat); const lng = parseFloat(o.lastLng);
        if (isFinite(lat) && isFinite(lng)) return { lat, lng };
      }
    }
    if (focusSiteId) {
      const s = sites.find((x) => x.id === focusSiteId);
      if (s?.locationLat && s?.locationLng) {
        const lat = parseFloat(s.locationLat); const lng = parseFloat(s.locationLng);
        if (isFinite(lat) && isFinite(lng)) return { lat, lng };
      }
    }
    return undefined;
  }, [focusUserId, focusSiteId, officers, sites]);

  // MAP_BUILD_ID re-evaluates on every HMR reload so dev-time edits to
  // buildLeafletHtml actually take effect without a hard refresh.
  const html = useMemo(
    () => buildLeafletHtml(points, geofenceRadiusMiles, focusCenter, mapTileLayer ?? "street"),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [points, geofenceRadiusMiles, focusCenter, mapTileLayer, MAP_BUILD_ID],
  );
  const withCoords = points.filter((p) => p.kind === "officer").length;
  const withoutCoords = officers.length - withCoords;
  const siteCount = points.filter((p) => p.kind === "site").length;

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base flex-wrap">
          <MapPin className="w-5 h-5 brand-gold" />
          Live Map
          <span className="ml-auto flex items-center gap-2 text-xs opacity-60 font-normal">
            <span>
              {officers.length} on duty · {siteCount} sites
              {withoutCoords > 0 && ` · ${withoutCoords} no GPS`}
            </span>
            <FreshnessLabel updatedAt={updatedAt} />
            <button
              onClick={onToggleExpand}
              className="opacity-60 hover:opacity-100 transition-opacity ml-1"
              aria-label={mapExpanded ? "Collapse map" : "Expand map"}
              title={mapExpanded ? "Collapse map" : "Expand map"}
            >
              {mapExpanded
                ? <Minimize2 className="w-3.5 h-3.5" />
                : <Maximize2 className="w-3.5 h-3.5" />}
            </button>
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        {error ? <div className="p-3"><InlineError error={error} /></div> : null}
        {loading ? (
          <div className="text-sm opacity-60 p-4">Loading…</div>
        ) : (
          <iframe
            key={`dispatch-map-${MAP_BUILD_ID}-${mapTileLayer ?? "street"}`}
            title="Live officer map"
            srcDoc={html}
            className={`w-full border-0 transition-all duration-300 ${mapExpanded ? "h-[50rem]" : "h-[24rem]"}`}
            sandbox="allow-scripts"
          />
        )}
        {officers.length > 0 && (
          <div className="border-t p-2 space-y-1 max-h-40 overflow-y-auto">
            {officers.slice(0, 12).map((o) => {
              const isFocus = !!focusUserId && o.userId === focusUserId;
              return (
                <div
                  key={o.userId}
                  className={`flex items-center gap-2 text-xs px-2 rounded${isFocus ? " wcsg-deep-link-flash" : ""}`}
                >
                  <div className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${isFocus ? "bg-brand-gold" : "bg-emerald-500"}`} />
                  <span className="flex-1 truncate">{o.firstName} {o.lastName}</span>
                  <span className="opacity-60">{o.siteName ?? "—"}</span>
                  <span className="opacity-50 whitespace-nowrap">{fmtAgo(o.lastLocationAt)}</span>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// =========================================================== BROADCAST

function BroadcastPanel({ rooms }: { rooms: ChatRoom[] }) {
  const [roomId, setRoomId] = useState<string>("");
  const [text, setText] = useState("");
  const [sent, setSent] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);

  useEffect(() => {
    if (!roomId && rooms.length > 0) {
      // Default to announcements (org-wide blast) when present, falling
      // back to whatever the API returned first.
      const ann = rooms.find((r) => r.type === "announcements") ?? rooms[0];
      setRoomId(ann.id);
    }
  }, [rooms, roomId]);

  // Lightweight "full Chat" shortcut: rather than navigating away from
  // the command center, drop the last ~30 messages from the selected
  // channel inline so the dispatcher has context before they post.
  // Refetches whenever the room changes or after Send succeeds.
  const history = useQuery<ChatMessage[]>({
    queryKey: ["dispatch", "chat-history", roomId, sent],
    queryFn: () => api<ChatMessage[]>(`/chat/rooms/${roomId}/messages?limit=30`),
    enabled: showHistory && !!roomId,
    refetchInterval: showHistory ? 15_000 : false,
  });

  const send = useMutation({
    mutationFn: () => api(`/chat/rooms/${roomId}/messages`, {
      method: "POST",
      body: { content: text },
    }),
    onSuccess: () => {
      setSent(new Date().toISOString());
      setText("");
      setTimeout(() => setSent(null), 4000);
    },
  });

  const activeRoom = rooms.find((r) => r.id === roomId);

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Radio className="w-5 h-5 brand-gold" />
          Broadcast
          <div className="ml-auto flex items-center gap-1">
            <Button
              variant="ghost" size="sm"
              className="h-7 px-2 text-xs"
              onClick={() => setShowHistory((v) => !v)}
              disabled={!roomId}
            >
              <MessageCircle className="w-3.5 h-3.5 mr-1" />
              {showHistory ? "Hide" : "Preview"} thread
            </Button>
            <Link
              href={roomId ? `/chat?room=${encodeURIComponent(roomId)}` : "/chat"}
              className="inline-flex items-center h-7 px-2 text-xs rounded hover:bg-accent/50 transition-colors"
            >
              Open full chat →
            </Link>
          </div>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        <div>
          <label className="text-xs opacity-70 block mb-1">Channel</label>
          <select
            className="w-full rounded border px-2 py-1.5 bg-background text-sm"
            value={roomId}
            onChange={(e) => setRoomId(e.target.value)}
          >
            {rooms.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name ?? r.type} {r.type === "announcements" ? "📣" : ""}
              </option>
            ))}
          </select>
        </div>

        {showHistory && (
          <div className="rounded border bg-muted/30 max-h-56 overflow-y-auto p-2 space-y-1.5 text-xs">
            <div className="flex items-center justify-between text-[11px] opacity-60">
              <span>{activeRoom?.name ?? "Channel"} · recent</span>
              {history.isFetching && <Loader2 className="w-3 h-3 animate-spin" />}
            </div>
            {history.isLoading && <div className="opacity-60">Loading…</div>}
            {history.error && (
              <div className="text-red-700">
                {history.error instanceof Error ? history.error.message : "Could not load chat history."}
              </div>
            )}
            {history.data && history.data.length === 0 && (
              <div className="opacity-60">No messages in this channel yet.</div>
            )}
            {history.data?.map((m) => (
              <div key={m.id} className="leading-snug">
                <span className="font-medium">{m.userName ?? "—"}: </span>
                <span className="opacity-90">{m.content ?? ""}</span>
                <span className="opacity-50 ml-1">· {fmtAgo(m.createdAt)}</span>
              </div>
            ))}
          </div>
        )}

        <Textarea
          placeholder="Type the message officers will see…"
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={4}
        />
        <div className="flex items-center gap-2">
          <Button
            onClick={() => send.mutate()}
            disabled={!roomId || !text.trim() || send.isPending}
            className="flex-1"
          >
            {send.isPending ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Send className="w-4 h-4 mr-2" />}
            Send
          </Button>
        </div>
        {sent && (
          <div className="text-xs text-emerald-700 flex items-center gap-1">
            <CheckCircle2 className="w-3 h-3" /> Sent {fmtAgo(sent)}
          </div>
        )}
        {send.isError && (
          <div className="text-xs text-red-700">
            {send.error instanceof Error ? send.error.message : "Failed to send. Check your access to this channel."}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
