import { useMemo, useState, useCallback, useEffect } from "react";
import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import { api, isStillProcessing, STILL_SAVING_MESSAGE } from "@/lib/api";
import { useIdempotentIntent } from "@/lib/idempotentIntent";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import {
  ChevronLeft, ChevronRight, Loader2, Users, MousePointerClick,
  AlertTriangle, Repeat, Plus,
} from "lucide-react";
import {
  Shift, ShiftFilters, applyFilters, filledCount, localDayKey, tzDayKey,
  fmtTimeTz, siteLabelFor,
} from "./shared";

type CalView = "month" | "week" | "3day";

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
function buildGrid(anchor: Date): Date[] {
  const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
  const start = new Date(first);
  start.setDate(first.getDate() - first.getDay());
  return Array.from({ length: 42 }, (_, i) => addDays(start, i));
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

export function StaffingBar({ filled, headcount, open }: { filled: number; headcount: number; open: boolean }) {
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

type Props = {
  filters: ShiftFilters;
  siteIndex: Map<string, { name: string; clientName: string | null }>;
  onSelect: (shift: Shift) => void;
  onCreateAt: (date: Date) => void;
  /** ISO date (YYYY-MM-DD) to jump the calendar anchor to; changes re-fire. */
  jumpDate: string | null;
  /** Start time of a deep-linked shift — moves the anchor so it's visible. */
  focusStartTime: string | null;
  focusShiftId?: string | null;
};

export function ShiftsCalendarView({
  filters, siteIndex, onSelect, onCreateAt, jumpDate, focusStartTime, focusShiftId,
}: Props) {
  const qc = useQueryClient();
  const [anchor, setAnchor] = useState(() => startOfDay(new Date()));
  const [view, setView] = useState<CalView>("month");
  const [dayView, setDayView] = useState<{ key: string; shifts: Shift[] } | null>(null);

  const [rosterShiftId, setRosterShiftId] = useState<string | null>(null);
  const [dragOverShiftId, setDragOverShiftId] = useState<string | null>(null);
  const [assigningShiftId, setAssigningShiftId] = useState<string | null>(null);
  const [dropError, setDropError] = useState<string | null>(null);
  // The shift whose assignment the server never confirmed: still running under
  // its key when `api()` stopped waiting. A save in progress, not a refusal, so
  // it never becomes a `dropError` — the calendar is refreshed and dropping
  // again stays safe, since the same key can only replay, never assign twice.
  const [stillSavingShiftId, setStillSavingShiftId] = useState<string | null>(null);

  useEffect(() => {
    if (!jumpDate) return;
    const d = new Date(`${jumpDate}T12:00:00`);
    if (!Number.isNaN(d.getTime())) setAnchor(startOfDay(d));
  }, [jumpDate]);

  useEffect(() => {
    if (!focusStartTime) return;
    const d = new Date(focusStartTime);
    if (!Number.isNaN(d.getTime())) setAnchor(startOfDay(d));
  }, [focusStartTime]);

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
    queryKey: ["shifts-area", "calendar", queryFrom.toISOString(), queryTo.toISOString()],
    queryFn: () =>
      api<Shift[]>(`/shifts?from=${queryFrom.toISOString()}&to=${queryTo.toISOString()}`),
  });

  const byDay = useMemo(() => {
    const map = new Map<string, Shift[]>();
    // Cancelled shifts stay hidden on the calendar unless the admin explicitly
    // filters for them — mirrors the old calendar's behavior.
    const base = (shifts.data ?? []).filter(
      (s) => filters.status === "cancelled" || filters.status === "all"
        ? true
        : s.status !== "cancelled",
    );
    const rows = applyFilters(base, filters, siteIndex);
    for (const s of rows) {
      const key = tzDayKey(s.startTime);
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(s);
    }
    for (const list of map.values()) {
      list.sort((a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime());
    }
    return map;
  }, [shifts.data, filters, siteIndex]);

  const viewLabel = useMemo(() => {
    if (view === "month") return anchor.toLocaleString("en-US", { month: "long", year: "numeric" });
    return fmtRangeLabel(viewDates);
  }, [view, anchor, viewDates]);

  const onChange = useCallback(() => {
    qc.invalidateQueries({ queryKey: ["shifts-area"] });
  }, [qc]);

  function navigate(dir: -1 | 1) {
    setRosterShiftId(null);
    setDropError(null);
    setAnchor((prev) => {
      if (view === "month") return new Date(prev.getFullYear(), prev.getMonth() + dir, 1);
      if (view === "week") return addDays(prev, dir * 7);
      return addDays(prev, dir * 3);
    });
  }

  function switchView(v: CalView, date?: Date) {
    setView(v);
    setRosterShiftId(null);
    setDropError(null);
    if (date) setAnchor(startOfDay(date));
  }

  const candidatesQuery = useQuery<AssignNearestResult>({
    queryKey: ["shifts-area", "roster", rosterShiftId],
    queryFn: () =>
      api<AssignNearestResult>("/dispatch/assign-nearest", {
        method: "POST",
        body: { shiftId: rosterShiftId!, dryRun: true },
      }),
    enabled: !!rosterShiftId,
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
      qc.invalidateQueries({ queryKey: ["shifts-area", "roster", rosterShiftId] });
    },
    onError: (e, vars) => {
      if (isStillProcessing(e)) {
        setStillSavingShiftId(vars.shiftId);
        // It may have landed while we waited — refresh so a completed
        // assignment shows itself on the calendar rather than staying invisible.
        onChange();
      } else {
        setDropError(e instanceof Error ? e.message : "Could not assign officer.");
      }
    },
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
        setStillSavingShiftId(null);
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

  const siteName = (s: Shift) => siteLabelFor(s, siteIndex).site;

  return (
    <div className="flex flex-col gap-3">
      {/* ── Calendar toolbar ── */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="flex items-center rounded-md border overflow-hidden text-sm">
          {(["month", "week", "3day"] as CalView[]).map((v) => (
            <button
              key={v}
              onClick={() => switchView(v)}
              className={`px-3 py-1.5 font-medium transition-colors border-r last:border-r-0 ${
                view === v ? "bg-brand-gold text-sidebar" : "hover:bg-muted"
              }`}
            >
              {v === "month" ? "Month" : v === "week" ? "Week" : "3 Day"}
            </button>
          ))}
        </div>

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

        {shifts.isFetching && (
          <span className="flex items-center gap-1 text-xs opacity-50">
            <Loader2 className="w-3 h-3 animate-spin" /> Refreshing…
          </span>
        )}

        <div className="ml-auto flex flex-wrap items-center gap-4 text-xs opacity-60">
          <span className="flex items-center gap-1.5">
            <span className="inline-block w-3 h-3 rounded-sm bg-amber-400" /> Open
          </span>
          <span className="flex items-center gap-1.5">
            <span className="inline-block w-3 h-3 rounded-sm bg-emerald-500" /> Staffed
          </span>
          <span className="flex items-center gap-1.5">
            <Repeat className="w-3 h-3" /> Series
          </span>
          {view !== "month" && (
            <span className="flex items-center gap-1.5 text-brand-gold/80 opacity-100">
              <MousePointerClick className="w-3 h-3" /> Click a shift for available officers
            </span>
          )}
        </div>
      </div>

      {shifts.isError && (
        <div className="text-sm text-red-700 rounded border border-red-200 bg-red-50 px-3 py-2">
          {shifts.error instanceof Error ? shifts.error.message : "Could not load shifts."}
        </div>
      )}

      {view === "month" ? (
        /* ═══════════ MONTH VIEW ═══════════ */
        <div className="overflow-x-auto">
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
                  className={`group bg-card min-h-[7.5rem] p-1.5 flex flex-col gap-1 ${
                    isPast ? "opacity-40" : inMonth ? "" : "opacity-50"
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <button
                      type="button"
                      onClick={() => switchView("3day", cell)}
                      className={`text-xs font-semibold px-1 rounded hover:bg-accent transition-colors ${
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
                    {!isPast && (
                      <button
                        type="button"
                        onClick={() => onCreateAt(cell)}
                        aria-label={`Create shift on ${cell.toLocaleString("en-US", { month: "long", day: "numeric" })}`}
                        className="opacity-0 group-hover:opacity-60 focus-visible:opacity-100 hover:!opacity-100 transition-opacity rounded p-0.5 hover:bg-accent"
                      >
                        <Plus className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>

                  <div className="flex flex-col gap-1 overflow-hidden">
                    {dayShifts.slice(0, 4).map((s) => {
                      const filled = filledCount(s);
                      const open = filled < s.headcount;
                      return (
                        <button
                          key={s.id}
                          type="button"
                          onClick={() => onSelect(s)}
                          className={`text-left rounded px-1.5 py-1 text-[11px] leading-tight transition-colors ${
                            open
                              ? "bg-amber-100 hover:bg-amber-200 text-amber-900"
                              : "bg-emerald-100 hover:bg-emerald-200 text-emerald-900"
                          } ${s.id === focusShiftId ? "ring-2 ring-brand-gold ring-offset-1" : ""}`}
                          title={`${s.title} · ${siteName(s)}`}
                        >
                          <div className="font-semibold truncate flex items-center gap-1">
                            {s.isRepeat && <Repeat className="w-2.5 h-2.5 shrink-0 opacity-70" aria-label="Repeating series" />}
                            <span className="truncate">{fmtTimeTz(s.startTime)} · {s.title}</span>
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
                      <button
                        type="button"
                        onClick={() => onCreateAt(cell)}
                        className="text-[10px] opacity-20 hover:opacity-70 text-center pt-2 transition-opacity"
                      >
                        + Add shift
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ) : (
        /* ═══════════ WEEK / 3-DAY VIEW ═══════════ */
        <div className="flex flex-col lg:flex-row gap-4 items-start">
          <div className="flex-1 min-w-0 w-full flex flex-col gap-3">
            <div className="overflow-x-auto">
              <div
                className={`grid gap-px bg-border rounded-lg overflow-hidden ${
                  view === "week" ? "grid-cols-7" : "grid-cols-3"
                } min-w-[22rem]`}
              >
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
                        isPast ? (
                          <div className="text-[11px] opacity-25 text-center pt-8">No shifts</div>
                        ) : (
                          <button
                            type="button"
                            onClick={() => onCreateAt(cell)}
                            className="text-[11px] opacity-25 hover:opacity-70 text-center pt-8 transition-opacity"
                          >
                            + Add shift
                          </button>
                        )
                      )}
                      {dayShifts.map((s) => {
                        const filled = filledCount(s);
                        const open = filled < s.headcount;
                        const isRosterSelected = s.id === rosterShiftId;
                        const isDragOver = s.id === dragOverShiftId;
                        const isAssigning = s.id === assigningShiftId;
                        const isStillSaving = s.id === stillSavingShiftId;
                        const activate = () => {
                          if (!isPast) {
                            setRosterShiftId(s.id === rosterShiftId ? null : s.id);
                            setDropError(null);
                          } else {
                            onSelect(s);
                          }
                        };
                        return (
                          <div
                            key={s.id}
                            role="button"
                            tabIndex={0}
                            aria-pressed={isRosterSelected}
                            onClick={activate}
                            onKeyDown={(e) => {
                              if (e.key === "Enter" || e.key === " ") {
                                e.preventDefault();
                                activate();
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
                              isRosterSelected ? "ring-2 ring-brand-gold border-brand-gold shadow-sm" : "",
                              isDragOver ? "ring-2 ring-brand-gold bg-brand-gold/10 border-brand-gold" : "",
                              s.id === focusShiftId && !isRosterSelected && !isDragOver
                                ? "ring-2 ring-brand-gold ring-offset-1"
                                : "",
                            ].filter(Boolean).join(" ")}
                          >
                            <div className="font-semibold text-[11px] opacity-70 flex items-center gap-1">
                              {s.isRepeat && <Repeat className="w-2.5 h-2.5 shrink-0" aria-label="Repeating series" />}
                              {fmtTimeTz(s.startTime)} – {fmtTimeTz(s.endTime)}
                            </div>
                            <div className="font-semibold mt-0.5 truncate">{s.title}</div>
                            <div className="opacity-60 truncate text-[10px] mt-0.5">{siteName(s)}</div>
                            <StaffingBar filled={filled} headcount={s.headcount} open={open} />
                            <div className="flex items-center justify-between mt-1">
                              <button
                                type="button"
                                onClick={(e) => { e.stopPropagation(); onSelect(s); }}
                                className="text-[10px] underline opacity-60 hover:opacity-100"
                              >
                                Details
                              </button>
                              {isAssigning && (
                                <span role="status" className="flex items-center gap-1 text-[10px] opacity-60">
                                  <Loader2 className="w-3 h-3 animate-spin" /> Assigning…
                                </span>
                              )}
                              {!isAssigning && isStillSaving && (
                                <span className="text-[10px] opacity-60">Still saving — not confirmed</span>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  );
                })}
              </div>
            </div>

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

            {stillSavingShiftId && (
              <div role="status" className="rounded border bg-muted/40 text-muted-foreground text-xs px-3 py-2">
                {STILL_SAVING_MESSAGE}
              </div>
            )}
          </div>

          {/* Officer roster panel */}
          <div className="w-full lg:w-72 shrink-0">
            <div className="lg:sticky lg:top-4 rounded-lg border bg-card overflow-hidden">
              <div className="px-3 py-2.5 border-b bg-muted/50 flex items-center gap-2">
                <Users className="w-4 h-4 brand-gold shrink-0" />
                <span className="font-semibold text-sm">Officer Roster</span>
                {rosterShiftId && (
                  <button
                    onClick={() => { setRosterShiftId(null); setDropError(null); }}
                    className="ml-auto text-xs opacity-50 hover:opacity-100 hover:underline"
                    aria-label="Clear shift selection"
                  >
                    Clear
                  </button>
                )}
              </div>

              {rosterShift && (
                <div className={`px-3 py-2 text-xs border-b ${
                  filledCount(rosterShift) < rosterShift.headcount
                    ? "bg-amber-50 text-amber-800"
                    : "bg-emerald-50 text-emerald-800"
                }`}>
                  <div className="font-semibold truncate">{rosterShift.title}</div>
                  <div className="opacity-70 mt-0.5">
                    {fmtTimeTz(rosterShift.startTime)} – {fmtTimeTz(rosterShift.endTime)}
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
                                <span className="text-amber-500 text-sm leading-none shrink-0" title="Has worked this site before">★</span>
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

                    {rosterShift && filledCount(rosterShift) < rosterShift.headcount && (
                      <div className="pt-1 border-t">
                        <button
                          onClick={() => onSelect(rosterShift)}
                          className="text-[11px] opacity-60 hover:opacity-100 hover:underline"
                        >
                          Open shift details (assign with license override)
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

      {dayView && (
        <Dialog open onOpenChange={(v) => { if (!v) setDayView(null); }}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>
                {new Date(`${dayView.key}T12:00:00Z`).toLocaleString("en-US", {
                  timeZone: "UTC", weekday: "long", month: "long", day: "numeric", year: "numeric",
                })}
              </DialogTitle>
              <DialogDescription className="sr-only">Shifts scheduled on this day.</DialogDescription>
            </DialogHeader>
            <div className="space-y-2 max-h-[60vh] overflow-y-auto">
              {dayView.shifts.map((s) => {
                const filled = filledCount(s);
                const open = filled < s.headcount;
                return (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => { setDayView(null); onSelect(s); }}
                    className={`w-full text-left rounded-lg px-3 py-2.5 text-sm transition-colors ${
                      open
                        ? "bg-amber-50 hover:bg-amber-100 text-amber-900 border border-amber-200"
                        : "bg-emerald-50 hover:bg-emerald-100 text-emerald-900 border border-emerald-200"
                    }`}
                  >
                    <div className="font-semibold flex items-center gap-1.5">
                      {s.isRepeat && <Repeat className="w-3 h-3 shrink-0 opacity-70" aria-label="Repeating series" />}
                      {fmtTimeTz(s.startTime)} – {fmtTimeTz(s.endTime)}
                    </div>
                    <div className="font-medium truncate mt-0.5">{s.title}</div>
                    <div className="text-xs opacity-70 mt-0.5 truncate">
                      {siteName(s)} · L{s.requiredLicenseLevel}+
                    </div>
                    <StaffingBar filled={filled} headcount={s.headcount} open={open} />
                  </button>
                );
              })}
            </div>
            <DialogFooter>
              <Button variant="ghost" onClick={() => setDayView(null)}>Close</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}
