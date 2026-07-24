import { useMemo, useState, useCallback } from "react";
import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import {
  ChevronLeft, ChevronRight, CalendarDays, Clock, MapPin, Users, Megaphone,
  Loader2, UserPlus, CheckCircle2, AlertTriangle, MousePointerClick,
} from "lucide-react";
import { AssignNearestDialog } from "@/components/AssignNearestDialog";

const COMPANY_TZ = "America/Chicago";

type View = "month" | "week" | "3day";

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

type Candidate = {
  userId: string;
  name: string;
  distanceMiles: number | null;
  workedSiteBefore?: boolean;
  meetsLicense?: boolean;
  conflictingShift?: boolean;
  alreadyAssigned?: boolean;
};
type AssignNearestResult = { candidates: Candidate[]; siteHasCoords?: boolean };

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const WEEKDAYS_LONG = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function filledCount(s: Shift): number {
  return s.assignments.filter((a) => a.status === "accepted").length;
}

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

function addDays(d: Date, n: number): Date {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}

function startOfDay(d: Date): Date {
  const r = new Date(d);
  r.setHours(0, 0, 0, 0);
  return r;
}

function startOfWeek(d: Date): Date {
  const r = startOfDay(d);
  r.setDate(r.getDate() - r.getDay());
  return r;
}

/** 42-cell month grid (6 weeks) covering the month of `anchor`. */
function buildGrid(anchor: Date): Date[] {
  const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
  const start = new Date(first);
  start.setDate(first.getDate() - first.getDay());
  const cells: Date[] = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    cells.push(d);
  }
  return cells;
}

function buildWeek(anchor: Date): Date[] {
  const start = startOfWeek(anchor);
  return Array.from({ length: 7 }, (_, i) => addDays(start, i));
}

function build3Day(anchor: Date): Date[] {
  const s = startOfDay(anchor);
  return [s, addDays(s, 1), addDays(s, 2)];
}

function fmtRangeLabel(dates: Date[]): string {
  const first = dates[0];
  const last = dates[dates.length - 1];
  const sameMonthYear =
    first.getMonth() === last.getMonth() && first.getFullYear() === last.getFullYear();
  if (sameMonthYear) {
    const mo = first.toLocaleString("en-US", { month: "long" });
    return `${mo} ${first.getDate()}–${last.getDate()}, ${first.getFullYear()}`;
  }
  const f = first.toLocaleString("en-US", { month: "short", day: "numeric" });
  const l = last.toLocaleString("en-US", { month: "short", day: "numeric" });
  return `${f} – ${l}, ${last.getFullYear()}`;
}

function StaffingBar({ filled, headcount, open }: { filled: number; headcount: number; open: boolean }) {
  const pct = headcount > 0 ? Math.min(100, (filled / headcount) * 100) : 0;
  return (
    <div className="flex items-center gap-1.5 mt-1">
      <div className="flex-1 h-1.5 rounded-full bg-black/[0.08] overflow-hidden">
        <div
          className={`h-full rounded-full transition-all ${open ? "bg-amber-500" : "bg-emerald-500"}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="text-[10px] opacity-60 shrink-0 tabular-nums">{filled}/{headcount}</span>
    </div>
  );
}

export default function Calendar() {
  const qc = useQueryClient();
  const [anchor, setAnchor] = useState(() => startOfDay(new Date()));
  const [view, setView] = useState<View>("month");
  const [filter, setFilter] = useState<"all" | "open" | "filled">("all");
  const [selected, setSelected] = useState<Shift | null>(null);
  const [dayView, setDayView] = useState<{ key: string; shifts: Shift[] } | null>(null);

  const [rosterShiftId, setRosterShiftId] = useState<string | null>(null);
  const [dragOverShiftId, setDragOverShiftId] = useState<string | null>(null);
  const [assigningShiftId, setAssigningShiftId] = useState<string | null>(null);
  const [dropError, setDropError] = useState<string | null>(null);

  const todayKey = useMemo(() => localDayKey(new Date()), []);
  const monthIdx = anchor.getMonth();

  const viewDates = useMemo(() => {
    if (view === "month") return buildGrid(anchor);
    if (view === "week") return buildWeek(anchor);
    return build3Day(anchor);
  }, [view, anchor]);

  const queryFrom = useMemo(() => {
    const d = new Date(viewDates[0]);
    d.setDate(d.getDate() - 1);
    d.setHours(0, 0, 0, 0);
    return d;
  }, [viewDates]);

  const queryTo = useMemo(() => {
    const d = new Date(viewDates[viewDates.length - 1]);
    d.setDate(d.getDate() + 1);
    d.setHours(23, 59, 59, 999);
    return d;
  }, [viewDates]);

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

  const viewLabel = useMemo(() => {
    if (view === "month") return anchor.toLocaleString("en-US", { month: "long", year: "numeric" });
    return fmtRangeLabel(viewDates);
  }, [view, anchor, viewDates]);

  const onChange = useCallback(() => {
    qc.invalidateQueries({ queryKey: ["calendar-shifts"] });
  }, [qc]);

  const selectedLive = useMemo(() => {
    if (!selected) return null;
    return (shifts.data ?? []).find((s) => s.id === selected.id) ?? selected;
  }, [selected, shifts.data]);

  function navigate(dir: -1 | 1) {
    setRosterShiftId(null);
    setDropError(null);
    setAnchor((prev) => {
      if (view === "month") return new Date(prev.getFullYear(), prev.getMonth() + dir, 1);
      if (view === "week") return addDays(prev, dir * 7);
      return addDays(prev, dir * 3);
    });
  }

  function switchView(v: View, date?: Date) {
    setView(v);
    setRosterShiftId(null);
    setDropError(null);
    if (date) setAnchor(startOfDay(date));
  }

  const candidatesQuery = useQuery<AssignNearestResult>({
    queryKey: ["calendar", "roster", rosterShiftId],
    queryFn: () =>
      api<AssignNearestResult>("/dispatch/assign-nearest", {
        method: "POST",
        body: { shiftId: rosterShiftId!, dryRun: true },
      }),
    enabled: !!rosterShiftId,
    staleTime: 30_000,
  });

  const assignMutation = useMutation({
    mutationFn: ({ shiftId, employeeId }: { shiftId: string; employeeId: string }) =>
      api(`/shifts/${shiftId}/assignments`, {
        method: "POST",
        body: { employeeId, status: "accepted" },
      }),
    onSuccess: () => {
      onChange();
      qc.invalidateQueries({ queryKey: ["calendar", "roster", rosterShiftId] });
    },
    onError: (e) => setDropError(e instanceof Error ? e.message : "Could not assign officer."),
    onSettled: () => setAssigningShiftId(null),
  });

  const handleDragStart = useCallback((e: React.DragEvent, c: Candidate) => {
    e.dataTransfer.setData(
      "application/wcsg-officer",
      JSON.stringify({
        userId: c.userId,
        name: c.name,
        meetsLicense: c.meetsLicense,
        conflictingShift: c.conflictingShift,
        alreadyAssigned: c.alreadyAssigned,
      }),
    );
    e.dataTransfer.effectAllowed = "move";
  }, []);

  const handleDragOverShift = useCallback((e: React.DragEvent, shiftId: string) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setDragOverShiftId(shiftId);
  }, []);

  const handleDragLeaveShift = useCallback((e: React.DragEvent) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
      setDragOverShiftId(null);
    }
  }, []);

  const handleDropOnShift = useCallback(
    (e: React.DragEvent, shiftId: string) => {
      e.preventDefault();
      setDragOverShiftId(null);
      setDropError(null);
      const raw = e.dataTransfer.getData("application/wcsg-officer");
      if (!raw) return;
      try {
        const officer = JSON.parse(raw) as {
          userId: string;
          name: string;
          meetsLicense?: boolean;
          conflictingShift?: boolean;
          alreadyAssigned?: boolean;
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
          setDropError(
            `${officer.name} doesn't meet the license requirement. Use "Assign" to override.`,
          );
          return;
        }
        setAssigningShiftId(shiftId);
        assignMutation.mutate({ shiftId, employeeId: officer.userId });
      } catch {
        setDropError("Could not read drag data — try again.");
      }
    },
    [assignMutation],
  );

  const allCandidates = candidatesQuery.data?.candidates ?? [];
  const siteHasCoords = candidatesQuery.data?.siteHasCoords ?? true;
  const eligibleCandidates = allCandidates.filter(
    (c) => !c.alreadyAssigned && !c.conflictingShift && c.meetsLicense !== false,
  );
  const blockedCandidates = allCandidates.filter(
    (c) => c.alreadyAssigned || c.conflictingShift || c.meetsLicense === false,
  );
  const rosterShift = shifts.data?.find((s) => s.id === rosterShiftId) ?? null;

  return (
    <div className="flex flex-col h-full">
      {/* ── Header ── */}
      <div className="shrink-0 border-b bg-card px-4 py-3">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          {/* Title */}
          <div className="flex items-center gap-2 mr-1">
            <CalendarDays className="w-5 h-5 brand-gold" />
            <h1 className="text-lg font-semibold">Shift Calendar</h1>
          </div>

          {/* View switcher */}
          <div className="flex items-center rounded-md border overflow-hidden text-sm">
            {(["month", "week", "3day"] as View[]).map((v) => (
              <button
                key={v}
                onClick={() => switchView(v)}
                className={`px-3 py-1.5 font-medium transition-colors border-r last:border-r-0 ${
                  view === v
                    ? "bg-brand-gold text-sidebar"
                    : "hover:bg-muted"
                }`}
              >
                {v === "month" ? "Month" : v === "week" ? "Week" : "3 Day"}
              </button>
            ))}
          </div>

          {/* Navigation */}
          <div className="flex items-center gap-1">
            <Button variant="outline" size="icon" aria-label="Previous" onClick={() => navigate(-1)}>
              <ChevronLeft className="w-4 h-4" />
            </Button>
            <div className="min-w-[11rem] text-center font-medium text-sm">{viewLabel}</div>
            <Button variant="outline" size="icon" aria-label="Next" onClick={() => navigate(1)}>
              <ChevronRight className="w-4 h-4" />
            </Button>
            <Button
              variant="default"
              size="sm"
              className="ml-1 bg-brand-gold hover:bg-brand-gold/90 text-sidebar font-semibold"
              onClick={() => {
                setAnchor(startOfDay(new Date()));
                setRosterShiftId(null);
                setDropError(null);
              }}
            >
              Today
            </Button>
          </div>

          {/* Filter — right side */}
          <div className="ml-auto flex items-center gap-1">
            <span className="text-xs opacity-50 mr-1 hidden sm:inline">Show:</span>
            {(["all", "open", "filled"] as const).map((f) => (
              <Button
                key={f}
                size="sm"
                variant={filter === f ? "default" : "ghost"}
                className={filter === f ? "bg-brand-navy text-white hover:bg-brand-navy/90" : ""}
                onClick={() => setFilter(f)}
              >
                {f === "all" ? "All" : f === "open" ? "Open" : "Filled"}
              </Button>
            ))}
          </div>

          {/* Loading indicator */}
          {shifts.isFetching && (
            <span className="flex items-center gap-1 text-xs opacity-50">
              <Loader2 className="w-3 h-3 animate-spin" /> Refreshing…
            </span>
          )}
        </div>

        {/* Legend row */}
        <div className="flex flex-wrap items-center gap-4 text-xs opacity-60 mt-2">
          <span className="flex items-center gap-1.5">
            <span className="inline-block w-3 h-3 rounded-sm bg-amber-400" /> Open shift
          </span>
          <span className="flex items-center gap-1.5">
            <span className="inline-block w-3 h-3 rounded-sm bg-emerald-500" /> Fully staffed
          </span>
          {view !== "month" && (
            <span className="flex items-center gap-1.5 text-brand-gold/80 opacity-100">
              <MousePointerClick className="w-3 h-3" /> Click a shift to see available officers
            </span>
          )}
        </div>
      </div>

      {/* ── Error banner ── */}
      {shifts.isError && (
        <div className="shrink-0 mx-4 mt-3 text-sm text-red-700 rounded border border-red-200 bg-red-50 px-3 py-2">
          {shifts.error instanceof Error ? shifts.error.message : "Could not load shifts."}
        </div>
      )}

      {/* ── Main content ── */}
      <div className="flex-1 overflow-auto p-4">
        {view === "month" ? (
          /* ═══════════════════════ MONTH VIEW ═══════════════════════ */
          <div className="grid grid-cols-7 gap-px bg-border rounded-lg overflow-hidden min-w-[40rem]">
            {WEEKDAYS.map((d) => (
              <div
                key={d}
                className="bg-muted px-2 py-1.5 text-xs font-semibold text-center uppercase tracking-wider opacity-60"
              >
                {d}
              </div>
            ))}
            {viewDates.map((cell) => {
              const key = localDayKey(cell);
              const inMonth = cell.getMonth() === monthIdx;
              const isToday = key === todayKey;
              const isPast = key < todayKey;
              const dayShifts = byDay.get(key) ?? [];
              return (
                <div
                  key={key}
                  className={`bg-card min-h-[7.5rem] p-1.5 flex flex-col gap-1 ${
                    isPast ? "opacity-40" : inMonth ? "" : "opacity-50"
                  }`}
                >
                  {/* Day number — click to drill into 3-day view */}
                  <button
                    type="button"
                    onClick={() => switchView("3day", cell)}
                    className={`self-start text-xs font-semibold px-1 rounded hover:bg-accent transition-colors ${
                      isToday ? "brand-gold" : "opacity-60"
                    }`}
                    title={`View ${cell.toLocaleString("en-US", { weekday: "long", month: "long", day: "numeric" })}`}
                  >
                    {isToday ? (
                      <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-brand-gold text-sidebar font-bold">
                        {cell.getDate()}
                      </span>
                    ) : (
                      cell.getDate()
                    )}
                  </button>

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
                          <div className="font-semibold truncate">
                            {fmtTime(s.startTime)} · {s.title}
                          </div>
                          <StaffingBar filled={filled} headcount={s.headcount} open={open} />
                        </button>
                      );
                    })}
                    {dayShifts.length > 4 && (
                      <button
                        type="button"
                        onClick={() => setDayView({ key, shifts: dayShifts })}
                        className="text-[10px] font-medium opacity-60 hover:opacity-100 hover:underline px-1 text-left"
                      >
                        +{dayShifts.length - 4} more
                      </button>
                    )}
                    {dayShifts.length === 0 && inMonth && !isPast && (
                      <div className="text-[10px] opacity-20 text-center pt-2">No shifts</div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          /* ═══════════════════════ WEEK / 3-DAY VIEW ═══════════════════════ */
          <div className="flex gap-4 items-start">

            {/* Left: grid + error */}
            <div className="flex-1 min-w-0 flex flex-col gap-3">
              <div
                className={`grid gap-px bg-border rounded-lg overflow-hidden ${
                  view === "week" ? "grid-cols-7" : "grid-cols-3"
                } min-w-[22rem]`}
              >
                {/* Column headers */}
                {viewDates.map((cell) => {
                  const key = localDayKey(cell);
                  const isToday = key === todayKey;
                  const isPast = key < todayKey;
                  const wd = WEEKDAYS_LONG[cell.getDay()];
                  const dayLabel = view === "week" ? wd.slice(0, 3) : wd;
                  return (
                    <div
                      key={`hdr-${key}`}
                      className={`bg-muted px-2 py-2 text-center ${isPast ? "opacity-40" : ""}`}
                    >
                      <div className="text-[10px] font-semibold uppercase tracking-wider opacity-60">
                        {dayLabel}
                      </div>
                      <div className="mt-1 flex justify-center">
                        {isToday ? (
                          <span className="inline-flex items-center justify-center w-8 h-8 rounded-full bg-brand-gold text-sidebar font-bold text-sm">
                            {cell.getDate()}
                          </span>
                        ) : (
                          <span className={`text-xl font-semibold ${isPast ? "opacity-40" : ""}`}>
                            {cell.getDate()}
                          </span>
                        )}
                      </div>
                      <div className="text-[10px] opacity-40 mt-0.5">
                        {cell.toLocaleString("en-US", { month: "short" })}
                      </div>
                    </div>
                  );
                })}

                {/* Day cells */}
                {viewDates.map((cell) => {
                  const key = localDayKey(cell);
                  const isPast = key < todayKey;
                  const dayShifts = byDay.get(key) ?? [];
                  return (
                    <div
                      key={`body-${key}`}
                      className={`bg-card p-2 min-h-[11rem] flex flex-col gap-2 ${
                        isPast ? "opacity-45" : ""
                      }`}
                    >
                      {dayShifts.length === 0 && (
                        <div className="text-[11px] opacity-25 text-center pt-8">No shifts</div>
                      )}
                      {dayShifts.map((s) => {
                        const filled = filledCount(s);
                        const open = filled < s.headcount;
                        const isRosterSelected = s.id === rosterShiftId;
                        const isDragOver = s.id === dragOverShiftId;
                        const isAssigning = s.id === assigningShiftId;
                        return (
                          <div
                            key={s.id}
                            role="button"
                            tabIndex={0}
                            aria-pressed={isRosterSelected}
                            onClick={() => {
                              if (!isPast) {
                                setRosterShiftId(s.id === rosterShiftId ? null : s.id);
                                setDropError(null);
                              } else {
                                setSelected(s);
                              }
                            }}
                            onKeyDown={(e) => {
                              if (e.key === "Enter" || e.key === " ") {
                                e.preventDefault();
                                if (!isPast) {
                                  setRosterShiftId(s.id === rosterShiftId ? null : s.id);
                                  setDropError(null);
                                } else {
                                  setSelected(s);
                                }
                              }
                            }}
                            onDragOver={(e) => !isPast && handleDragOverShift(e, s.id)}
                            onDragLeave={handleDragLeaveShift}
                            onDrop={(e) => !isPast && handleDropOnShift(e, s.id)}
                            className={[
                              "rounded border p-2.5 text-xs leading-tight cursor-pointer transition-all select-none outline-none",
                              "focus-visible:ring-2 focus-visible:ring-brand-gold",
                              open
                                ? "bg-amber-50 border-amber-200 text-amber-900"
                                : "bg-emerald-50 border-emerald-200 text-emerald-900",
                              isRosterSelected
                                ? "ring-2 ring-brand-gold border-brand-gold shadow-sm"
                                : "",
                              isDragOver
                                ? "ring-2 ring-brand-gold bg-brand-gold/10 border-brand-gold"
                                : "",
                            ]
                              .filter(Boolean)
                              .join(" ")}
                          >
                            <div className="font-semibold text-[11px] opacity-70">
                              {fmtTime(s.startTime)} – {fmtTime(s.endTime)}
                            </div>
                            <div className="font-semibold mt-0.5 truncate">{s.title}</div>
                            <div className="opacity-60 truncate text-[10px] mt-0.5">
                              {siteName(s.siteId)}
                            </div>
                            <StaffingBar filled={filled} headcount={s.headcount} open={open} />
                            {isAssigning && (
                              <div className="flex items-center gap-1 mt-1 text-[10px] opacity-60">
                                <Loader2 className="w-3 h-3 animate-spin" /> Assigning…
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  );
                })}
              </div>

              {/* Drop error */}
              {dropError && (
                <div className="rounded border border-amber-200 bg-amber-50 text-amber-900 text-xs px-3 py-2 flex items-center gap-2">
                  <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                  <span className="flex-1">{dropError}</span>
                  <button
                    onClick={() => setDropError(null)}
                    aria-label="Dismiss"
                    className="opacity-60 hover:opacity-100 text-lg leading-none ml-2"
                  >
                    ×
                  </button>
                </div>
              )}
            </div>

            {/* Right: sticky Officer Roster panel */}
            <div className="w-72 shrink-0">
              <div className="sticky top-4 rounded-lg border bg-card overflow-hidden">
                {/* Roster header */}
                <div className="px-3 py-2.5 border-b bg-muted/50 flex items-center gap-2">
                  <Users className="w-4 h-4 brand-gold shrink-0" />
                  <span className="font-semibold text-sm">Officer Roster</span>
                  {rosterShiftId && (
                    <button
                      onClick={() => {
                        setRosterShiftId(null);
                        setDropError(null);
                      }}
                      className="ml-auto text-xs opacity-50 hover:opacity-100 hover:underline"
                      aria-label="Clear shift selection"
                    >
                      Clear
                    </button>
                  )}
                </div>

                {/* Selected shift context */}
                {rosterShift && (
                  <div className={`px-3 py-2 text-xs border-b ${
                    filledCount(rosterShift) < rosterShift.headcount
                      ? "bg-amber-50 text-amber-800"
                      : "bg-emerald-50 text-emerald-800"
                  }`}>
                    <div className="font-semibold truncate">{rosterShift.title}</div>
                    <div className="opacity-70 mt-0.5">
                      {fmtTime(rosterShift.startTime)} – {fmtTime(rosterShift.endTime)}
                    </div>
                  </div>
                )}

                <div className="p-3 min-h-[8rem]">
                  {!rosterShiftId ? (
                    <div className="flex flex-col items-center justify-center gap-2 py-8 opacity-30 text-center">
                      <MousePointerClick className="w-8 h-8" />
                      <span className="text-xs">Click any shift to see available officers</span>
                    </div>
                  ) : candidatesQuery.isLoading ? (
                    <div className="flex items-center justify-center gap-2 py-6 text-sm opacity-60">
                      <Loader2 className="w-4 h-4 animate-spin" /> Ranking officers…
                    </div>
                  ) : candidatesQuery.isError ? (
                    <div className="text-sm text-red-700 py-2">Could not load officers.</div>
                  ) : (
                    <div className="flex flex-col gap-3">
                      {!siteHasCoords && (
                        <div className="text-[11px] bg-amber-50 border border-amber-200 text-amber-800 rounded px-2 py-1">
                          No site coordinates — ordering by recent ping.
                        </div>
                      )}
                      {eligibleCandidates.length === 0 && blockedCandidates.length === 0 && (
                        <div className="text-sm opacity-40 text-center py-2">
                          No eligible officers available.
                        </div>
                      )}

                      {/* Draggable eligible officers */}
                      {eligibleCandidates.length > 0 && (
                        <div>
                          <div className="text-[10px] font-semibold uppercase tracking-wider opacity-50 mb-2">
                            Available — drag onto shift to assign
                          </div>
                          <div className="flex flex-col gap-1.5">
                            {eligibleCandidates.map((c) => (
                              <div
                                key={c.userId}
                                draggable
                                onDragStart={(e) => handleDragStart(e, c)}
                                className="flex items-center gap-2 rounded border bg-background px-2.5 py-2 text-xs cursor-grab active:cursor-grabbing hover:border-brand-gold/70 hover:bg-brand-gold/5 transition-colors select-none"
                                title={`Drag ${c.name} onto a shift to assign`}
                              >
                                {c.workedSiteBefore && (
                                  <span
                                    className="text-amber-500 text-sm leading-none shrink-0"
                                    title="Has worked this site before"
                                  >
                                    ★
                                  </span>
                                )}
                                <span className="font-medium flex-1 truncate">{c.name}</span>
                                {c.distanceMiles != null && (
                                  <span className="opacity-40 text-[10px] shrink-0">
                                    {c.distanceMiles.toFixed(1)} mi
                                  </span>
                                )}
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      {/* Blocked officers */}
                      {blockedCandidates.length > 0 && (
                        <div>
                          <div className="text-[10px] font-semibold uppercase tracking-wider opacity-40 mb-2">
                            Unavailable
                          </div>
                          <div className="flex flex-col gap-1.5">
                            {blockedCandidates.map((c) => {
                              const reason = c.alreadyAssigned
                                ? "already assigned"
                                : c.conflictingShift
                                  ? "conflicting shift"
                                  : "license mismatch";
                              return (
                                <div
                                  key={c.userId}
                                  className="flex items-center gap-2 rounded border bg-background px-2.5 py-2 text-xs opacity-35 cursor-not-allowed select-none"
                                  title={reason}
                                >
                                  <span className="flex-1 truncate">{c.name}</span>
                                  <span className="opacity-60 text-[10px] shrink-0">{reason}</span>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      )}

                      {/* Full assign dialog link */}
                      {rosterShift && filledCount(rosterShift) < rosterShift.headcount && (
                        <div className="pt-1 border-t">
                          <button
                            onClick={() => setSelected(rosterShift)}
                            className="text-[11px] opacity-60 hover:opacity-100 hover:underline"
                          >
                            Open full assign dialog (license override available)
                          </button>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      {selectedLive && (
        <ShiftDetailDialog
          shift={selectedLive}
          siteName={siteName(selectedLive.siteId)}
          open={!!selected}
          onOpenChange={(v) => {
            if (!v) setSelected(null);
          }}
          onChange={onChange}
        />
      )}

      {dayView && (
        <DayShiftsDialog
          open={!!dayView}
          dayKey={dayView.key}
          shifts={dayView.shifts}
          siteName={siteName}
          onOpenChange={(v) => {
            if (!v) setDayView(null);
          }}
          onPick={(s) => {
            setDayView(null);
            setSelected(s);
          }}
        />
      )}
    </div>
  );
}

function DayShiftsDialog({
  open,
  dayKey,
  shifts,
  siteName,
  onOpenChange,
  onPick,
}: {
  open: boolean;
  dayKey: string;
  shifts: Shift[];
  siteName: (id: string | null) => string;
  onOpenChange: (v: boolean) => void;
  onPick: (s: Shift) => void;
}) {
  const heading = new Date(`${dayKey}T12:00:00Z`).toLocaleString("en-US", {
    timeZone: "UTC",
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{heading}</DialogTitle>
          <DialogDescription className="sr-only">
            Shifts scheduled on this day.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2 max-h-[60vh] overflow-y-auto">
          {shifts.map((s) => {
            const filled = filledCount(s);
            const open = filled < s.headcount;
            return (
              <button
                key={s.id}
                type="button"
                onClick={() => onPick(s)}
                className={`w-full text-left rounded-lg px-3 py-2.5 text-sm transition-colors ${
                  open
                    ? "bg-amber-50 hover:bg-amber-100 text-amber-900 border border-amber-200"
                    : "bg-emerald-50 hover:bg-emerald-100 text-emerald-900 border border-emerald-200"
                }`}
              >
                <div className="font-semibold">
                  {fmtTime(s.startTime)} – {fmtTime(s.endTime)}
                </div>
                <div className="font-medium truncate mt-0.5">{s.title}</div>
                <div className="text-xs opacity-70 mt-0.5 truncate">
                  {siteName(s.siteId)} · L{s.requiredLicenseLevel}+
                </div>
                <StaffingBar filled={filled} headcount={s.headcount} open={open} />
              </button>
            );
          })}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ShiftDetailDialog({
  shift,
  siteName,
  open,
  onOpenChange,
  onChange,
}: {
  shift: Shift;
  siteName: string;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onChange: () => void;
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
            <DialogDescription className="sr-only">
              Shift details, staffing status, and assigned officers.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-2.5 text-sm">
            <div className="flex items-center gap-2 opacity-80">
              <Clock className="w-4 h-4 shrink-0" />
              <span>{fmtDateLong(shift.startTime)}</span>
            </div>
            <div className="flex items-center gap-2 opacity-80">
              <Clock className="w-4 h-4 shrink-0 invisible" />
              <span>
                {fmtTime(shift.startTime)} – {fmtTime(shift.endTime)}
              </span>
            </div>
            <div className="flex items-center gap-2 opacity-80">
              <MapPin className="w-4 h-4 shrink-0" />
              <span>{siteName}</span>
            </div>

            {/* Staffing summary */}
            <div className="rounded-lg border bg-muted/30 px-3 py-2.5">
              <div className="flex items-center justify-between text-xs opacity-70 mb-1.5">
                <span className="flex items-center gap-1">
                  <Users className="w-3.5 h-3.5" /> Staffing
                </span>
                <span className="font-medium">{filled} / {shift.headcount} officers</span>
              </div>
              <StaffingBar filled={filled} headcount={shift.headcount} open={isOpen} />
              <div className="flex items-center gap-3 mt-1.5 text-xs opacity-60">
                <span>L{shift.requiredLicenseLevel}+ required</span>
                {shift.payRate && <span>${shift.payRate}/hr</span>}
              </div>
            </div>

            <div className="pt-1">
              <div className="text-xs font-semibold uppercase tracking-wide opacity-50 mb-1.5">
                Assigned officers
              </div>
              {accepted.length === 0 && pending.length === 0 && (
                <div className="text-xs opacity-50">No officers assigned yet.</div>
              )}
              <div className="space-y-1.5">
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
                {notify.isPending ? (
                  <Loader2 className="w-4 h-4 mr-1 animate-spin" />
                ) : (
                  <Megaphone className="w-4 h-4 mr-1" />
                )}
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
              {notify.error instanceof Error
                ? notify.error.message
                : "Could not notify officers."}
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
