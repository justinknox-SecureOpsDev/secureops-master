import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, getToken } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Card, CardContent, CardHeader, CardTitle,
} from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import {
  AlertTriangle, CheckCircle2, Clock, MapPin, MessageCircle, Radio, Send,
  ShieldAlert, UserCheck, Users, Megaphone, Loader2, RefreshCw, Wifi, WifiOff,
  HelpCircle, X,
} from "lucide-react";
import { useAuth } from "@/lib/auth";
import { useFirstQueryParam } from "@/hooks/useDeepLinkFocus";
import { AssignNearestDialog } from "@/components/AssignNearestDialog";

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


function fmtTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
  });
}

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
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

  const refreshAll = () => {
    qc.invalidateQueries({ queryKey: ["dispatch"] });
  };

  // Real-time incident pulse — falls back to the 30s poll on WS drop.
  const wsState = useIncidentWs(() => {
    qc.invalidateQueries({ queryKey: ["dispatch", "active-incidents"] });
  });

  return (
    <div className="p-4 lg:p-6 space-y-4 max-w-[1600px] mx-auto">
      <header className="flex items-center justify-between flex-wrap gap-3">
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
        <div className="flex items-center gap-2">
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

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2 space-y-4">
          <div data-tour="incidents">
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
          </div>
          <div data-tour="status-board">
            <StatusBoardPanel
              data={board.data}
              loading={board.isLoading}
              error={board.error}
              updatedAt={board.dataUpdatedAt}
              isAdmin={user?.role === "admin"}
              onChange={refreshAll}
            />
          </div>
          <div data-tour="open-shifts">
            <OpenShiftsPanel
              data={openShifts.data ?? []}
              loading={openShifts.isLoading}
              error={openShifts.error}
              updatedAt={openShifts.dataUpdatedAt}
              onChange={refreshAll}
            />
          </div>
        </div>

        <div className="space-y-4">
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
          />
          <div data-tour="broadcast">
            <BroadcastPanel rooms={rooms.data ?? []} />
          </div>
        </div>
      </div>

      {tourOpen && <DispatchTour onClose={closeTour} />}
    </div>
  );
}

// =========================================================== COACH-MARK TOUR

type TourStep = {
  selector: string;
  title: string;
  body: string;
};

const TOUR_STEPS: TourStep[] = [
  {
    selector: '[data-tour="incidents"]',
    title: "Active Incidents",
    body: "Every open incident lands here in real time. Critical ones flash red — click any row to update status and add dispatcher notes.",
  },
  {
    selector: '[data-tour="status-board"]',
    title: "Clock-In Status Board",
    body: "Today's shifts grouped by state: on duty, late (≥10m), no-show, early-out, and upcoming. Use it to spot coverage gaps at a glance.",
  },
  {
    selector: '[data-tour="open-shifts"]',
    title: "Open Shifts & Assign Nearest",
    body: "Unfilled shifts in the next 72 hours. Hit \"Assign nearest\" to rank qualified officers by distance and one-tap fill the slot, or \"Notify\" to push the vacancy to everyone who qualifies.",
  },
  {
    selector: '[data-tour="broadcast"]',
    title: "Broadcast Composer",
    body: "Pick a channel (📣 announcements goes org-wide), preview the thread if you want context, then send. Officers see it instantly in chat and push.",
  },
];

function DispatchTour({ onClose }: { onClose: () => void }) {
  const [idx, setIdx] = useState(0);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const step = TOUR_STEPS[idx];
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  const titleId = "dispatch-tour-title";
  const bodyId = "dispatch-tour-body";
  const stepDescId = `dispatch-tour-step-${idx}`;

  // Attach aria-describedby to the spotlight target so SR users get context.
  useEffect(() => {
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
  }, [step.selector, stepDescId]);

  useEffect(() => {
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
  }, [step.selector]);

  // Position the tooltip below the target when there's room, otherwise above.
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
    if (idx < TOUR_STEPS.length - 1) setIdx(idx + 1);
    else onClose();
  };
  const prev = () => { if (idx > 0) setIdx(idx - 1); };

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
  }, [idx]);

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
  }, [idx, onClose]);

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
              Step {idx + 1} of {TOUR_STEPS.length}
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
            {TOUR_STEPS.map((_, i) => (
              <span
                key={i}
                className={`h-1.5 w-5 rounded-full ${i === idx ? "bg-brand-gold" : "bg-muted"}`}
              />
            ))}
          </div>
          <div className="flex items-center gap-2">
            {idx > 0 && (
              <Button size="sm" variant="ghost" onClick={prev}>Back</Button>
            )}
            <Button
              size="sm"
              onClick={next}
              data-testid="dispatch-tour-next"
            >
              {idx < TOUR_STEPS.length - 1 ? "Next" : "Got it"}
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
        {!loading && data && (
          <Tabs defaultValue="onDuty">
            <TabsList className="grid grid-cols-6 w-full">
              <TabsTrigger value="onDuty">On duty<Pill n={counts.onDuty} tone="ok" /></TabsTrigger>
              <TabsTrigger value="late">Late<Pill n={counts.late} tone="warn" /></TabsTrigger>
              <TabsTrigger value="noShow">No show<Pill n={counts.noShow} tone="bad" /></TabsTrigger>
              <TabsTrigger value="earlyOut">Early out<Pill n={counts.earlyOut} tone="warn" /></TabsTrigger>
              <TabsTrigger value="completed">Completed<Pill n={counts.completed} tone="ok" /></TabsTrigger>
              <TabsTrigger value="scheduled">Scheduled<Pill n={counts.scheduled} tone="muted" /></TabsTrigger>
            </TabsList>
            <BucketTab value="onDuty" rows={data.onDuty} emptyMsg="No one clocked in." showClockIn clockAction="out" {...clockProps} />
            <BucketTab value="late" rows={data.late} emptyMsg="No late officers." showMinutesLate clockAction="in" {...clockProps} />
            <BucketTab value="noShow" rows={data.noShow} emptyMsg="No no-shows." showMinutesLate clockAction="in" {...clockProps} />
            <BucketTab value="earlyOut" rows={data.earlyOut} emptyMsg="No early clock-outs." showMinutesEarly />
            <BucketTab value="completed" rows={data.completed} emptyMsg="No completed shifts yet." showClockOut />
            <BucketTab value="scheduled" rows={data.scheduled} emptyMsg="Nothing upcoming." clockAction="in" {...clockProps} />
          </Tabs>
        )}
        {clockError && <div className="mt-2 text-xs text-red-700">{clockError}</div>}
      </CardContent>
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
  isAdmin, clockAction, pendingId, onClockIn, onClockOut,
}: {
  value: string; rows: StatusRow[]; emptyMsg: string;
  showMinutesLate?: boolean; showMinutesEarly?: boolean; showClockIn?: boolean;
  showClockOut?: boolean;
  isAdmin?: boolean; clockAction?: "in" | "out"; pendingId?: string | null;
  onClockIn?: (r: StatusRow) => void; onClockOut?: (r: StatusRow) => void;
}) {
  return (
    <TabsContent value={value} className="mt-3 max-h-72 overflow-y-auto space-y-1">
      {rows.length === 0 ? (
        <div className="text-sm opacity-60 py-4 text-center">{emptyMsg}</div>
      ) : rows.map((r) => (
        <div key={r.assignmentId} className="flex items-center gap-2 text-sm rounded border bg-card px-3 py-2">
          <div className="flex-1 min-w-0">
            <div className="font-medium truncate">{r.officerName}</div>
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
          {isAdmin && clockAction === "in" && onClockIn && (
            <Button
              size="sm" variant="outline" className="h-7 text-xs"
              disabled={pendingId === r.assignmentId}
              onClick={() => onClockIn(r)}
            >
              {pendingId === r.assignmentId ? "…" : "Clock in"}
            </Button>
          )}
          {isAdmin && clockAction === "out" && onClockOut && (
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

// =========================================================== OPEN SHIFTS

function OpenShiftsPanel({
  data, loading, error, updatedAt, onChange,
}: {
  data: OpenShift[]; loading: boolean; error: unknown; updatedAt: number | undefined;
  onChange: () => void;
}) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Clock className="w-5 h-5 brand-gold" />
          Open Shifts — Next 72 Hours
          <span className="ml-auto flex items-center gap-2 text-xs opacity-60 font-normal">
            <span>{data.length} open</span>
            <FreshnessLabel updatedAt={updatedAt} />
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 max-h-[24rem] overflow-y-auto">
        <InlineError error={error} />
        {loading && <div className="text-sm opacity-60">Loading…</div>}
        {!loading && !error && data.length === 0 && <div className="text-sm opacity-60">All shifts in the next 72h are filled.</div>}
        {data.map((s) => <OpenShiftRow key={s.id} shift={s} onChange={onChange} />)}
      </CardContent>
    </Card>
  );
}

function OpenShiftRow({ shift, onChange }: { shift: OpenShift; onChange: () => void }) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const notify = useMutation({
    mutationFn: () => api(`/shifts/${shift.id}/notify-vacancy`, { method: "POST" }),
  });

  return (
    <div className="rounded border bg-card p-3">
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0">
          <div className="font-medium text-sm">{shift.title ?? shift.siteName ?? "Shift"}</div>
          <div className="text-xs opacity-70">
            <span className="font-medium">{fmtDate(shift.startTime)}</span> · {shift.siteName ?? "—"} · {fmtTime(shift.startTime)} – {fmtTime(shift.endTime)}
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
        </div>
        <div className="flex flex-col gap-1.5">
          <Button size="sm" onClick={() => setPickerOpen(true)}>
            <Users className="w-3.5 h-3.5 mr-1" /> Assign nearest
          </Button>
          <Button
            size="sm" variant="outline"
            onClick={() => notify.mutate()} disabled={notify.isPending}
          >
            {notify.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Megaphone className="w-3.5 h-3.5 mr-1" />}
            Notify
          </Button>
        </div>
      </div>
      <AssignNearestDialog
        shiftId={shift.id}
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        onAssigned={onChange}
      />
    </div>
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
<style>html,body,#m{margin:0;padding:0;height:100%;background:#080c18}
.popup{font:13px -apple-system,system-ui,sans-serif}.popup b{color:#080c18}
.popup-btn{margin-top:6px;background:#080c18;color:#c9a84c;border:1px solid #c9a84c;border-radius:4px;padding:4px 8px;font-size:12px;font-weight:600;cursor:pointer;font-family:inherit}
.popup-btn:hover{background:#c9a84c;color:#080c18}
.site-pin{display:flex;align-items:center;justify-content:center;width:28px;height:28px;border-radius:6px;background:#080c18;color:#c9a84c;border:2px solid #c9a84c;font:bold 13px -apple-system,system-ui,sans-serif;box-shadow:0 1px 4px rgba(0,0,0,.35)}</style>
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
function popup(label, sub, officerId, incidentId){
  const w=document.createElement('div');w.className='popup';
  const b=document.createElement('b');b.appendChild(document.createTextNode(String(label||'')));
  w.appendChild(b);w.appendChild(document.createElement('br'));
  w.appendChild(document.createTextNode(String(sub||'')));
  // Render a deep-link button on officer/incident pins. Built via
  // createElement + addEventListener (never innerHTML) so any officer-
  // controlled label/id can never break out into script context. The
  // id itself is sent as a string in a structured postMessage; the
  // parent admin shell validates and dispatches to the correct route.
  if (officerId || incidentId) {
    w.appendChild(document.createElement('br'));
    const btn=document.createElement('button');
    btn.className='popup-btn';
    btn.appendChild(document.createTextNode(officerId ? 'View profile' : 'View incident'));
    btn.addEventListener('click', function(){
      try {
        if (officerId) parent.postMessage({ type:'wcsg:openOfficer', userId:String(officerId) }, '*');
        else if (incidentId) parent.postMessage({ type:'wcsg:openIncident', incidentId:String(incidentId) }, '*');
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
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{
  attribution:'&copy; OpenStreetMap', maxZoom:19
}).addTo(map);
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
        color: '#c9a84c',
        weight: 1,
        opacity: 0.45,
        fillColor: '#c9a84c',
        fillOpacity: 0.08,
        interactive: false,
      }).addTo(group);
      const icon = L.divIcon({
        className:'', html:'<div class="site-pin">S</div>',
        iconSize:[28,28], iconAnchor:[14,14]
      });
      m = L.marker([p.lat,p.lng], { icon });
    } else {
      const isInc = p.kind === 'incident';
      const color = isInc ? (SEV[p.severity]||'#94a3b8') : '#c9a84c';
      m = L.circleMarker([p.lat,p.lng], {
        radius: isInc ? 12 : 9,
        color, fillColor: color,
        fillOpacity: isInc ? 0.95 : 0.85,
        weight: isInc ? 4 : 3,
      });
    }
    m.bindPopup(popup(p.label, p.sub, p.officerId, p.incidentId));
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
  focusUserId, focusSiteId,
}: {
  officers: ActiveOfficer[]; sites: Site[]; loading: boolean; error: unknown;
  updatedAt: number | undefined; incidents: Incident[];
  onFocusIncident: (incidentId: string) => void;
  focusUserId?: string | null;
  focusSiteId?: string | null;
}) {
  const [, navigate] = useLocation();

  // Listen for popup deep-link clicks from inside the sandboxed leaflet
  // iframe. We accept only our two known message shapes and validate the
  // id is a plain string — every other message is ignored. The iframe is
  // sandbox="allow-scripts" (no allow-same-origin), so its origin is
  // "null" by design; filtering on shape + a `wcsg:` type prefix is the
  // right contract here. Officer pins navigate to the role-shared
  // /personnel/:id profile page; incident pins hand off to the
  // Dispatch page's IncidentsPanel which opens the existing edit dialog
  // — dispatcher-safe (no /incidents/share-links dependency).
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
      }
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, [navigate, onFocusIncident]);

  const points = useMemo<MapPoint[]>(() => {
    const pts: MapPoint[] = [];
    // Sites first so they sit underneath live circles when they overlap.
    for (const s of sites) {
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
      pts.push({
        kind: "incident", lat, lng,
        severity: i.severity,
        label: `[${i.severity.toUpperCase()}] ${i.title}`,
        sub: i.employeeName ?? i.locationDescription ?? i.status,
        incidentId: i.id,
      });
    }
    return pts;
  }, [officers, sites, incidents]);

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
    () => buildLeafletHtml(points, geofenceRadiusMiles, focusCenter),
    [points, geofenceRadiusMiles, focusCenter, MAP_BUILD_ID],
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
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        {error ? <div className="p-3"><InlineError error={error} /></div> : null}
        {loading ? (
          <div className="text-sm opacity-60 p-4">Loading…</div>
        ) : (
          <iframe
            key={`dispatch-map-${MAP_BUILD_ID}`}
            title="Live officer map"
            srcDoc={html}
            className="w-full h-[24rem] border-0"
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
