import { useMemo, useState } from "react";
import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import {
  ChevronLeft, ChevronRight, CalendarDays, Clock, MapPin, Users, Megaphone,
  Loader2, UserPlus, CheckCircle2, AlertTriangle,
} from "lucide-react";
import { AssignNearestDialog } from "@/components/AssignNearestDialog";

const COMPANY_TZ = "America/Chicago";

type Assignment = {
  id: string;
  shiftId: string;
  employeeId: string;
  status: string;
  createdAt: string;
  employeeName: string | null;
};

type Shift = {
  id: string;
  title: string;
  siteId: string | null;
  startTime: string;
  endTime: string;
  headcount: number;
  requiredLicenseLevel: number;
  payRate: string | null;
  status: string;
  assignments: Assignment[];
};

type Site = { id: string; name: string; address: string | null };

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Count of officers actively holding the shift (accepted). */
function filledCount(s: Shift): number {
  return s.assignments.filter((a) => a.status === "accepted").length;
}

/** y-m-d key in company timezone, so a shift is bucketed on its local day. */
function tzDayKey(iso: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: COMPANY_TZ, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date(iso));
  const y = parts.find((p) => p.type === "year")?.value ?? "";
  const m = parts.find((p) => p.type === "month")?.value ?? "";
  const d = parts.find((p) => p.type === "day")?.value ?? "";
  return `${y}-${m}-${d}`;
}

function localDayKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function fmtTime(iso: string): string {
  return new Date(iso).toLocaleString("en-US", {
    timeZone: COMPANY_TZ, hour: "numeric", minute: "2-digit",
  });
}

function fmtDateLong(iso: string): string {
  return new Date(iso).toLocaleString("en-US", {
    timeZone: COMPANY_TZ, weekday: "long", month: "long", day: "numeric", year: "numeric",
  });
}

/** All 42 cells (6 weeks) covering the month that `anchor` falls in. */
function buildGrid(anchor: Date): Date[] {
  const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
  const start = new Date(first);
  start.setDate(first.getDate() - first.getDay()); // back up to Sunday
  const cells: Date[] = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    cells.push(d);
  }
  return cells;
}

export default function Calendar() {
  const qc = useQueryClient();
  const [anchor, setAnchor] = useState(() => new Date());
  const [filter, setFilter] = useState<"all" | "open" | "filled">("all");
  const [selected, setSelected] = useState<Shift | null>(null);
  const [dayView, setDayView] = useState<{ key: string; shifts: Shift[] } | null>(null);

  const cells = useMemo(() => buildGrid(anchor), [anchor]);

  // Fetch window padded by a full day on each side. The grid is rendered in
  // the browser's local calendar but shifts are bucketed by their Central
  // (COMPANY_TZ) calendar date; padding guarantees edge-day shifts are
  // fetched regardless of the admin's browser timezone (max offset < 24h).
  const queryFrom = useMemo(() => {
    const d = new Date(cells[0]);
    d.setDate(d.getDate() - 1);
    d.setHours(0, 0, 0, 0);
    return d;
  }, [cells]);
  const queryTo = useMemo(() => {
    const d = new Date(cells[cells.length - 1]);
    d.setDate(d.getDate() + 1);
    d.setHours(23, 59, 59, 999);
    return d;
  }, [cells]);

  const shifts = useQuery<Shift[]>({
    queryKey: ["calendar-shifts", queryFrom.toISOString(), queryTo.toISOString()],
    queryFn: () =>
      api<Shift[]>(`/shifts?from=${queryFrom.toISOString()}&to=${queryTo.toISOString()}`),
  });

  const sites = useQuery<Site[]>({
    queryKey: ["calendar-sites"],
    queryFn: () => api<Site[]>("/sites"),
    staleTime: 5 * 60 * 1000,
  });
  const siteName = (id: string | null): string => {
    if (!id) return "—";
    return sites.data?.find((s) => s.id === id)?.name ?? "—";
  };

  // Bucket shifts by company-local day.
  const byDay = useMemo(() => {
    const map = new Map<string, Shift[]>();
    const rows = (shifts.data ?? []).filter((s) => {
      if (s.status === "cancelled") return false;
      const open = filledCount(s) < s.headcount;
      if (filter === "open") return open;
      if (filter === "filled") return !open;
      return true;
    });
    for (const s of rows) {
      const key = tzDayKey(s.startTime);
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(s);
    }
    for (const list of map.values()) {
      list.sort((a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime());
    }
    return map;
  }, [shifts.data, filter]);

  const monthLabel = anchor.toLocaleString("en-US", { month: "long", year: "numeric" });
  const todayKey = tzDayKey(new Date().toISOString());
  const monthIdx = anchor.getMonth();

  const onChange = () => {
    qc.invalidateQueries({ queryKey: ["calendar-shifts"] });
  };

  // Keep the selected shift's data fresh after an assignment mutation.
  const selectedLive = useMemo(() => {
    if (!selected) return null;
    return (shifts.data ?? []).find((s) => s.id === selected.id) ?? selected;
  }, [selected, shifts.data]);

  return (
    <div className="flex flex-col h-full">
      <div className="shrink-0 border-b bg-card px-4 py-3 flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2">
          <CalendarDays className="w-5 h-5 brand-gold" />
          <h1 className="text-lg font-semibold">Shift Calendar</h1>
        </div>
        <div className="flex items-center gap-1">
          <Button variant="outline" size="icon" aria-label="Previous month"
            onClick={() => setAnchor(new Date(anchor.getFullYear(), anchor.getMonth() - 1, 1))}>
            <ChevronLeft className="w-4 h-4" />
          </Button>
          <div className="w-40 text-center font-medium">{monthLabel}</div>
          <Button variant="outline" size="icon" aria-label="Next month"
            onClick={() => setAnchor(new Date(anchor.getFullYear(), anchor.getMonth() + 1, 1))}>
            <ChevronRight className="w-4 h-4" />
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setAnchor(new Date())}>Today</Button>
        </div>
        <div className="ml-auto flex items-center gap-1">
          {(["all", "open", "filled"] as const).map((f) => (
            <Button
              key={f}
              size="sm"
              variant={filter === f ? "default" : "outline"}
              onClick={() => setFilter(f)}
            >
              {f === "all" ? "All" : f === "open" ? "Open" : "Filled"}
            </Button>
          ))}
        </div>
      </div>

      <div className="shrink-0 px-4 pt-2 flex items-center gap-4 text-xs opacity-70">
        <span className="flex items-center gap-1">
          <span className="inline-block w-3 h-3 rounded-sm bg-amber-400" /> Open (needs officers)
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block w-3 h-3 rounded-sm bg-emerald-500" /> Filled
        </span>
        {shifts.isFetching && <span className="flex items-center gap-1"><Loader2 className="w-3 h-3 animate-spin" /> Refreshing…</span>}
      </div>

      <div className="flex-1 overflow-auto p-4">
        {shifts.isError && (
          <div className="text-sm text-red-700 mb-2">
            {shifts.error instanceof Error ? shifts.error.message : "Could not load shifts."}
          </div>
        )}
        <div className="grid grid-cols-7 gap-px bg-border rounded-lg overflow-hidden min-w-[40rem]">
          {WEEKDAYS.map((d) => (
            <div key={d} className="bg-muted px-2 py-1.5 text-xs font-medium text-center uppercase tracking-wide opacity-70">
              {d}
            </div>
          ))}
          {cells.map((cell) => {
            const key = localDayKey(cell);
            const inMonth = cell.getMonth() === monthIdx;
            const isToday = key === todayKey;
            const dayShifts = byDay.get(key) ?? [];
            return (
              <div
                key={key}
                className={`bg-card min-h-[7rem] p-1.5 flex flex-col gap-1 ${inMonth ? "" : "opacity-40"}`}
              >
                <div className={`text-xs font-medium px-1 ${isToday ? "brand-gold" : "opacity-60"}`}>
                  {isToday ? (
                    <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-brand-gold text-sidebar font-semibold">
                      {cell.getDate()}
                    </span>
                  ) : cell.getDate()}
                </div>
                <div className="flex flex-col gap-1 overflow-hidden">
                  {dayShifts.slice(0, 4).map((s) => {
                    const filled = filledCount(s);
                    const open = filled < s.headcount;
                    return (
                      <button
                        key={s.id}
                        type="button"
                        onClick={() => setSelected(s)}
                        className={`text-left rounded px-1.5 py-1 text-[11px] leading-tight transition-colors ${
                          open
                            ? "bg-amber-100 hover:bg-amber-200 text-amber-900"
                            : "bg-emerald-100 hover:bg-emerald-200 text-emerald-900"
                        }`}
                        title={`${s.title} · ${siteName(s.siteId)}`}
                      >
                        <div className="font-medium truncate">{fmtTime(s.startTime)} {s.title}</div>
                        <div className="opacity-80 truncate">
                          {siteName(s.siteId)} · {filled}/{s.headcount}
                        </div>
                      </button>
                    );
                  })}
                  {dayShifts.length > 4 && (
                    <button
                      type="button"
                      onClick={() => setDayView({ key, shifts: dayShifts })}
                      className="text-[10px] opacity-70 hover:opacity-100 hover:underline px-1 text-left"
                    >
                      +{dayShifts.length - 4} more
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {selectedLive && (
        <ShiftDetailDialog
          shift={selectedLive}
          siteName={siteName(selectedLive.siteId)}
          open={!!selected}
          onOpenChange={(v) => { if (!v) setSelected(null); }}
          onChange={onChange}
        />
      )}

      {dayView && (
        <DayShiftsDialog
          open={!!dayView}
          dayKey={dayView.key}
          shifts={dayView.shifts}
          siteName={siteName}
          onOpenChange={(v) => { if (!v) setDayView(null); }}
          onPick={(s) => { setDayView(null); setSelected(s); }}
        />
      )}
    </div>
  );
}

function DayShiftsDialog({
  open, dayKey, shifts, siteName, onOpenChange, onPick,
}: {
  open: boolean; dayKey: string; shifts: Shift[];
  siteName: (id: string | null) => string;
  onOpenChange: (v: boolean) => void; onPick: (s: Shift) => void;
}) {
  const heading = new Date(`${dayKey}T12:00:00Z`).toLocaleString("en-US", {
    timeZone: "UTC", weekday: "long", month: "long", day: "numeric", year: "numeric",
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{heading}</DialogTitle>
        </DialogHeader>
        <div className="space-y-1.5 max-h-[60vh] overflow-y-auto">
          {shifts.map((s) => {
            const filled = filledCount(s);
            const open = filled < s.headcount;
            return (
              <button
                key={s.id}
                type="button"
                onClick={() => onPick(s)}
                className={`w-full text-left rounded px-2 py-1.5 text-sm transition-colors ${
                  open
                    ? "bg-amber-100 hover:bg-amber-200 text-amber-900"
                    : "bg-emerald-100 hover:bg-emerald-200 text-emerald-900"
                }`}
              >
                <div className="font-medium truncate">{fmtTime(s.startTime)} – {fmtTime(s.endTime)} · {s.title}</div>
                <div className="text-xs opacity-80 truncate">{siteName(s.siteId)} · {filled}/{s.headcount} filled · L{s.requiredLicenseLevel}+</div>
              </button>
            );
          })}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ShiftDetailDialog({
  shift, siteName, open, onOpenChange, onChange,
}: {
  shift: Shift; siteName: string; open: boolean;
  onOpenChange: (v: boolean) => void; onChange: () => void;
}) {
  const [assignOpen, setAssignOpen] = useState(false);
  const filled = filledCount(shift);
  const isOpen = filled < shift.headcount;
  const accepted = shift.assignments.filter((a) => a.status === "accepted");
  const pending = shift.assignments.filter((a) => a.status !== "accepted");

  const notify = useMutation({
    mutationFn: () => api(`/shifts/${shift.id}/notify-vacancy`, { method: "POST" }),
  });

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              {shift.title}
              {isOpen ? (
                <Badge className="bg-amber-500 hover:bg-amber-500">Open</Badge>
              ) : (
                <Badge className="bg-emerald-600 hover:bg-emerald-600">Filled</Badge>
              )}
            </DialogTitle>
          </DialogHeader>

          <div className="space-y-2 text-sm">
            <div className="flex items-center gap-2 opacity-80">
              <Clock className="w-4 h-4 shrink-0" />
              <span>{fmtDateLong(shift.startTime)}</span>
            </div>
            <div className="flex items-center gap-2 opacity-80">
              <Clock className="w-4 h-4 shrink-0 invisible" />
              <span>{fmtTime(shift.startTime)} – {fmtTime(shift.endTime)}</span>
            </div>
            <div className="flex items-center gap-2 opacity-80">
              <MapPin className="w-4 h-4 shrink-0" />
              <span>{siteName}</span>
            </div>
            <div className="flex flex-wrap items-center gap-2 text-xs opacity-70">
              <span className="flex items-center gap-1"><Users className="w-3.5 h-3.5" /> {filled} / {shift.headcount} filled</span>
              <span>· L{shift.requiredLicenseLevel}+</span>
              {shift.payRate && <span>· ${shift.payRate}/hr</span>}
            </div>

            <div className="pt-2">
              <div className="text-xs font-medium uppercase tracking-wide opacity-60 mb-1">Assigned officers</div>
              {accepted.length === 0 && pending.length === 0 && (
                <div className="text-xs opacity-60">No officers assigned yet.</div>
              )}
              <div className="space-y-1">
                {accepted.map((a) => (
                  <div key={a.id} className="flex items-center gap-2 text-sm">
                    <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
                    <span className="truncate">{a.employeeName ?? "Unknown"}</span>
                  </div>
                ))}
                {pending.map((a) => (
                  <div key={a.id} className="flex items-center gap-2 text-sm opacity-70">
                    <AlertTriangle className="w-4 h-4 text-amber-500 shrink-0" />
                    <span className="truncate">{a.employeeName ?? "Unknown"}</span>
                    <span className="text-[11px] opacity-60">({a.status})</span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          <DialogFooter className="flex-col sm:flex-row gap-2">
            {isOpen && (
              <Button
                variant="outline"
                onClick={() => notify.mutate()}
                disabled={notify.isPending}
              >
                {notify.isPending
                  ? <Loader2 className="w-4 h-4 mr-1 animate-spin" />
                  : <Megaphone className="w-4 h-4 mr-1" />}
                Notify officers
              </Button>
            )}
            <Button onClick={() => setAssignOpen(true)} disabled={!isOpen}>
              <UserPlus className="w-4 h-4 mr-1" />
              {isOpen ? "Assign officer" : "Shift full"}
            </Button>
          </DialogFooter>
          {notify.isError && (
            <div className="text-xs text-red-700">
              {notify.error instanceof Error ? notify.error.message : "Could not notify officers."}
            </div>
          )}
          {notify.isSuccess && (
            <div className="text-xs text-emerald-700">Qualified officers notified.</div>
          )}
        </DialogContent>
      </Dialog>

      <AssignNearestDialog
        shiftId={shift.id}
        open={assignOpen}
        onOpenChange={setAssignOpen}
        onAssigned={onChange}
      />
    </>
  );
}
