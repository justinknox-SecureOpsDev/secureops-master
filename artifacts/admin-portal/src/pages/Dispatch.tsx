import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "wouter";
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
} from "lucide-react";

type StatusRow = {
  assignmentId: string;
  shiftId: string;
  shiftTitle: string | null;
  startTime: string;
  endTime: string;
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
};

type StatusBoard = {
  onDuty: StatusRow[];
  late: StatusRow[];
  noShow: StatusRow[];
  earlyOut: StatusRow[];
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
};

type ChatRoom = { id: string; name: string; type: string };
type ChatMessage = { id: string; content: string | null; userName?: string | null; createdAt: string };

type Candidate = {
  userId: string;
  name: string;
  distanceMiles: number | null;
  alreadyAssigned: boolean;
  conflictingShift?: boolean;
  availabilityKnown?: boolean;
  availabilityCovers?: boolean;
};

type AssignNearestResult = {
  topCandidate: { userId: string; name: string; distanceMiles: number | null } | null;
  candidates: Candidate[];
  assignment?: { id: string; shiftId: string; employeeId: string };
  assignedTo?: { userId: string; name: string };
  siteHasCoords?: boolean;
};

function fmtTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
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
        <Button variant="outline" size="sm" onClick={refreshAll}>
          <RefreshCw className="w-4 h-4 mr-2" /> Refresh
        </Button>
      </header>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2 space-y-4">
          <IncidentsPanel
            data={incidents.data ?? []}
            loading={incidents.isLoading}
            error={incidents.error}
            updatedAt={incidents.dataUpdatedAt}
            onChange={refreshAll}
            wsState={wsState}
          />
          <StatusBoardPanel
            data={board.data}
            loading={board.isLoading}
            error={board.error}
            updatedAt={board.dataUpdatedAt}
          />
          <OpenShiftsPanel
            data={openShifts.data ?? []}
            loading={openShifts.isLoading}
            error={openShifts.error}
            updatedAt={openShifts.dataUpdatedAt}
            onChange={refreshAll}
          />
        </div>

        <div className="space-y-4">
          <LiveMapPanel
            officers={officers.data ?? []}
            sites={sites.data ?? []}
            loading={officers.isLoading}
            error={officers.error}
            updatedAt={officers.dataUpdatedAt}
            incidents={incidents.data ?? []}
          />
          <BroadcastPanel rooms={rooms.data ?? []} />
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
}: {
  data: Incident[]; loading: boolean; error: unknown; updatedAt: number | undefined;
  onChange: () => void; wsState: "connecting" | "open" | "closed";
}) {
  const critical = data.filter((i) => i.severity === "critical");
  const others = data.filter((i) => i.severity !== "critical");
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
          <IncidentRow key={i.id} incident={i} onChange={onChange} />
        ))}
      </CardContent>
    </Card>
  );
}

function IncidentRow({ incident, onChange }: { incident: Incident; onChange: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
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
    </>
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
  data, loading, error, updatedAt,
}: { data?: StatusBoard; loading: boolean; error: unknown; updatedAt: number | undefined }) {
  const counts = useMemo(() => ({
    onDuty: data?.onDuty.length ?? 0,
    late: data?.late.length ?? 0,
    noShow: data?.noShow.length ?? 0,
    earlyOut: data?.earlyOut.length ?? 0,
    scheduled: data?.scheduled.length ?? 0,
  }), [data]);

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
            <TabsList className="grid grid-cols-5 w-full">
              <TabsTrigger value="onDuty">On duty<Pill n={counts.onDuty} tone="ok" /></TabsTrigger>
              <TabsTrigger value="late">Late<Pill n={counts.late} tone="warn" /></TabsTrigger>
              <TabsTrigger value="noShow">No show<Pill n={counts.noShow} tone="bad" /></TabsTrigger>
              <TabsTrigger value="earlyOut">Early out<Pill n={counts.earlyOut} tone="warn" /></TabsTrigger>
              <TabsTrigger value="scheduled">Scheduled<Pill n={counts.scheduled} tone="muted" /></TabsTrigger>
            </TabsList>
            <BucketTab value="onDuty" rows={data.onDuty} emptyMsg="No one clocked in." showClockIn />
            <BucketTab value="late" rows={data.late} emptyMsg="No late officers." showMinutesLate />
            <BucketTab value="noShow" rows={data.noShow} emptyMsg="No no-shows." showMinutesLate />
            <BucketTab value="earlyOut" rows={data.earlyOut} emptyMsg="No early clock-outs." showMinutesEarly />
            <BucketTab value="scheduled" rows={data.scheduled} emptyMsg="Nothing upcoming." />
          </Tabs>
        )}
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
  value, rows, emptyMsg, showMinutesLate, showMinutesEarly, showClockIn,
}: {
  value: string; rows: StatusRow[]; emptyMsg: string;
  showMinutesLate?: boolean; showMinutesEarly?: boolean; showClockIn?: boolean;
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
            {showMinutesLate && r.minutesLate != null && (
              <Badge className="bg-amber-500 text-black">{r.minutesLate}m late</Badge>
            )}
            {showMinutesEarly && r.minutesEarly != null && (
              <Badge className="bg-orange-500 text-white">{r.minutesEarly}m early</Badge>
            )}
          </div>
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
            {shift.siteName ?? "—"} · {fmtTime(shift.startTime)} – {fmtTime(shift.endTime)}
          </div>
          <div className="text-xs opacity-60 mt-1 flex flex-wrap gap-2">
            <span>{shift.filled} / {shift.headcount} filled</span>
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

function candidateBlockReason(c: Candidate): string | null {
  if (c.alreadyAssigned) return "already on this shift";
  if (c.conflictingShift) return "would double-book another shift";
  if (c.availabilityKnown && c.availabilityCovers === false) {
    return "outside stated availability";
  }
  return null;
}

function AssignNearestDialog({
  shiftId, open, onOpenChange, onAssigned,
}: { shiftId: string; open: boolean; onOpenChange: (v: boolean) => void; onAssigned: () => void }) {
  const [result, setResult] = useState<AssignNearestResult | null>(null);
  const dryRun = useMutation({
    mutationFn: () => api<AssignNearestResult>("/dispatch/assign-nearest", {
      method: "POST",
      body: { shiftId, dryRun: true },
    }),
    onSuccess: (data) => setResult(data),
  });
  const assign = useMutation({
    mutationFn: (employeeId: string) =>
      api(`/shifts/${shiftId}/assignments`, {
        method: "POST",
        body: { employeeId, status: "accepted" },
      }),
    onSuccess: () => { onAssigned(); onOpenChange(false); },
  });

  useEffect(() => {
    if (open) { setResult(null); assign.reset(); dryRun.mutate(); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Assign nearest qualified officer</DialogTitle>
        </DialogHeader>
        <div className="space-y-2 text-sm">
          {dryRun.isPending && <div className="opacity-60">Ranking candidates…</div>}
          {dryRun.isError && (
            <div className="text-xs text-red-700">
              {dryRun.error instanceof Error ? dryRun.error.message : "Could not rank candidates."}
            </div>
          )}
          {result && result.candidates.length === 0 && (
            <div className="opacity-70">No qualified officers available.</div>
          )}
          {result && !result.siteHasCoords && (
            <div className="text-xs p-2 bg-amber-100 text-amber-900 rounded">
              Site has no coordinates — ranking falls back to most-recent location ping.
            </div>
          )}
          {result?.candidates.slice(0, 8).map((c, idx) => {
            const reason = candidateBlockReason(c);
            const disabled = !!reason;
            return (
              <div key={c.userId} className="flex items-center justify-between rounded border px-2 py-1.5">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="text-xs opacity-50 w-5">{idx + 1}.</span>
                  <div className="min-w-0">
                    <div className="truncate">{c.name}</div>
                    {reason && (
                      <div className="text-[11px] text-amber-700 truncate">{reason}</div>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-xs opacity-70 whitespace-nowrap">
                    {c.distanceMiles == null ? "no GPS" : `${c.distanceMiles.toFixed(1)} mi`}
                  </span>
                  <Button
                    size="sm"
                    variant={idx === 0 && !disabled ? "default" : "outline"}
                    disabled={disabled || assign.isPending}
                    onClick={() => assign.mutate(c.userId)}
                  >
                    Assign
                  </Button>
                </div>
              </div>
            );
          })}
          {assign.isError && (
            <div className="text-xs text-red-700">
              {assign.error instanceof Error ? assign.error.message : "Could not assign officer."}
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// =========================================================== LIVE MAP

type MapPoint = {
  kind: "officer" | "incident" | "site";
  lat: number;
  lng: number;
  label: string;
  sub: string;
  severity?: "low" | "medium" | "high" | "critical";
};

function buildLeafletHtml(points: MapPoint[]): string {
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
  return `<!doctype html><html><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"/>
<style>html,body,#m{margin:0;padding:0;height:100%;background:#080c18}
.popup{font:13px -apple-system,system-ui,sans-serif}.popup b{color:#080c18}
.site-pin{display:flex;align-items:center;justify-content:center;width:28px;height:28px;border-radius:6px;background:#080c18;color:#c9a84c;border:2px solid #c9a84c;font:bold 13px -apple-system,system-ui,sans-serif;box-shadow:0 1px 4px rgba(0,0,0,.35)}</style>
</head><body><div id="m"></div>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<script>
const pts = ${data};
const SEV = { critical:'#dc2626', high:'#ea580c', medium:'#eab308', low:'#94a3b8' };
function popup(label, sub){
  const w=document.createElement('div');w.className='popup';
  const b=document.createElement('b');b.appendChild(document.createTextNode(String(label||'')));
  w.appendChild(b);w.appendChild(document.createElement('br'));
  w.appendChild(document.createTextNode(String(sub||'')));return w;
}
const map = L.map('m',{zoomControl:true});
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{
  attribution:'&copy; OpenStreetMap', maxZoom:19
}).addTo(map);
if(!pts.length){ map.setView([39.8283,-98.5795],4); }
else {
  const group = L.featureGroup();
  pts.forEach(p=>{
    let m;
    if (p.kind === 'site') {
      // Site pins use a distinct square gold/navy icon so they read as
      // fixed locations vs. live circles for officers/incidents.
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
    m.bindPopup(popup(p.label, p.sub));
    m.addTo(group);
  });
  group.addTo(map);
  map.fitBounds(group.getBounds().pad(0.3), { maxZoom: 14 });
}
</script></body></html>`;
}

function LiveMapPanel({
  officers, sites, loading, error, updatedAt, incidents,
}: {
  officers: ActiveOfficer[]; sites: Site[]; loading: boolean; error: unknown;
  updatedAt: number | undefined; incidents: Incident[];
}) {
  const points = useMemo<MapPoint[]>(() => {
    const pts: MapPoint[] = [];
    // Sites first so they sit underneath live circles when they overlap.
    for (const s of sites) {
      if (!s.locationLat || !s.locationLng) continue;
      const lat = parseFloat(s.locationLat); const lng = parseFloat(s.locationLng);
      if (!isFinite(lat) || !isFinite(lng)) continue;
      pts.push({
        kind: "site", lat, lng,
        label: s.name,
        sub: s.address ?? "site",
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
      });
    }
    return pts;
  }, [officers, sites, incidents]);

  const html = useMemo(() => buildLeafletHtml(points), [points]);
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
            title="Live officer map"
            srcDoc={html}
            className="w-full h-[24rem] border-0"
            sandbox="allow-scripts"
          />
        )}
        {officers.length > 0 && (
          <div className="border-t p-2 space-y-1 max-h-40 overflow-y-auto">
            {officers.slice(0, 12).map((o) => (
              <div key={o.userId} className="flex items-center gap-2 text-xs px-2">
                <div className="w-1.5 h-1.5 rounded-full bg-emerald-500 flex-shrink-0" />
                <span className="flex-1 truncate">{o.firstName} {o.lastName}</span>
                <span className="opacity-60">{o.siteName ?? "—"}</span>
                <span className="opacity-50 whitespace-nowrap">{fmtAgo(o.lastLocationAt)}</span>
              </div>
            ))}
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
