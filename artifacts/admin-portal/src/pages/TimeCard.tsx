import { useEffect, useMemo, useState } from "react";
import { useSearch, useLocation } from "wouter";
import { Clock, ChevronLeft, ChevronRight, Loader2, CalendarDays } from "lucide-react";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";

type CardEntry = {
  id: string;
  clockInTime: string;
  clockOutTime?: string | null;
  hoursWorked?: number | null;
  approvalStatus: "pending" | "approved" | "rejected";
  siteName?: string | null;
  shiftTitle?: string | null;
  open: boolean;
};

type CardDay = { date: string; entries: CardEntry[]; totalHours: number };

type TimeCard = {
  employeeId: string;
  employeeName?: string;
  timezone: string;
  weekStart: string;
  weekEnd: string;
  prevWeekStart: string;
  nextWeekStart: string;
  days: CardDay[];
  totalHours: number;
  approvedHours: number;
  pendingHours: number;
};

type UserRow = {
  id: string;
  firstName: string | null;
  lastName: string | null;
  email: string;
  role: string;
  status?: string | null;
};

const APPROVAL_PILL: Record<CardEntry["approvalStatus"], string> = {
  pending: "bg-amber-100 text-amber-800",
  approved: "bg-green-100 text-green-800",
  rejected: "bg-red-100 text-red-800",
};

const fmtHours = (n: number) => `${n.toFixed(2)} h`;

const fmtDay = (isoDate: string) =>
  new Date(`${isoDate}T00:00:00`).toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" });

const fmtRange = (a: string, b: string) => {
  const opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" };
  const s = new Date(`${a}T00:00:00`);
  const e = new Date(`${b}T00:00:00`);
  return `${s.toLocaleDateString("en-US", opts)} – ${e.toLocaleDateString("en-US", opts)}, ${e.getFullYear()}`;
};

export default function TimeCardPage() {
  const search = useSearch();
  const [, setLocation] = useLocation();
  const params = useMemo(() => new URLSearchParams(search), [search]);
  const employeeId = params.get("employeeId") ?? "";
  const week = params.get("week") ?? "";

  const [users, setUsers] = useState<UserRow[]>([]);
  const [card, setCard] = useState<TimeCard | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<{ rows: UserRow[] }>("/admin/tables/users?limit=1000")
      .then((r) => {
        const staff = (r.rows ?? []).filter((u) => u.role !== "client");
        staff.sort((a, b) =>
          `${a.firstName ?? ""} ${a.lastName ?? ""}`.trim().toLowerCase()
            .localeCompare(`${b.firstName ?? ""} ${b.lastName ?? ""}`.trim().toLowerCase()));
        setUsers(staff);
      })
      .catch(() => setUsers([]));
  }, []);

  useEffect(() => {
    if (!employeeId) { setCard(null); return; }
    let cancelled = false;
    setLoading(true);
    setError(null);
    const qs = new URLSearchParams({ employeeId });
    if (week) qs.set("weekStart", week);
    api<TimeCard>(`/time-entries/time-card?${qs.toString()}`)
      .then((c) => { if (!cancelled) setCard(c); })
      .catch((e) => { if (!cancelled) { setCard(null); setError((e as Error).message ?? "Could not load time card"); } })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [employeeId, week]);

  const navigate = (nextEmployeeId: string, nextWeek: string) => {
    const qs = new URLSearchParams();
    if (nextEmployeeId) qs.set("employeeId", nextEmployeeId);
    if (nextWeek) qs.set("week", nextWeek);
    setLocation(`/payroll/time-card${qs.toString() ? `?${qs.toString()}` : ""}`);
  };

  const userLabel = (u: UserRow) =>
    `${u.firstName ?? ""} ${u.lastName ?? ""}`.trim() || u.email;

  const todayIso = card
    ? new Date().toLocaleDateString("en-CA", { timeZone: card.timezone })
    : null;

  return (
    <div className="p-4 sm:p-6 max-w-4xl mx-auto">
      <div className="flex items-center gap-3 mb-4">
        <Clock className="h-6 w-6 text-muted-foreground" aria-hidden="true" />
        <div>
          <h1 className="text-xl font-semibold">Weekly Time Card</h1>
          <p className="text-sm text-muted-foreground">
            Per-day clock-ins, daily totals, and the weekly total for one employee. Days follow the company timezone.
          </p>
        </div>
      </div>

      {/* Controls */}
      <div className="flex flex-col sm:flex-row sm:items-center gap-3 mb-4">
        <label className="flex items-center gap-2 text-sm">
          <span className="text-muted-foreground shrink-0">Employee</span>
          <select
            className="border rounded-md px-3 py-2 text-sm bg-background min-w-[220px]"
            value={employeeId}
            onChange={(e) => navigate(e.target.value, week)}
            aria-label="Select employee"
          >
            <option value="">Select an employee…</option>
            {users.map((u) => (
              <option key={u.id} value={u.id}>{userLabel(u)}</option>
            ))}
          </select>
        </label>

        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={!card || loading}
            onClick={() => card && navigate(employeeId, card.prevWeekStart)}
            aria-label="Previous week"
          >
            <ChevronLeft className="h-4 w-4" aria-hidden="true" />
          </Button>
          <button
            type="button"
            className="text-sm font-medium min-w-[190px] text-center hover:underline"
            onClick={() => navigate(employeeId, "")}
            title="Jump to the current week"
            aria-label={card ? `Week of ${fmtRange(card.weekStart, card.weekEnd)}. Jump to the current week.` : "Current week"}
          >
            {card ? fmtRange(card.weekStart, card.weekEnd) : "Mon – Sun"}
          </button>
          <Button
            variant="outline"
            size="sm"
            disabled={!card || loading}
            onClick={() => card && navigate(employeeId, card.nextWeekStart)}
            aria-label="Next week"
          >
            <ChevronRight className="h-4 w-4" aria-hidden="true" />
          </Button>
        </div>
      </div>

      {!employeeId ? (
        <div className="border rounded-lg p-10 text-center text-muted-foreground">
          <CalendarDays className="h-8 w-8 mx-auto mb-3" aria-hidden="true" />
          <p className="text-sm">Pick an employee to see their weekly time card.</p>
        </div>
      ) : loading ? (
        <div className="flex items-center justify-center p-10 text-muted-foreground">
          <Loader2 className="h-6 w-6 animate-spin" aria-label="Loading time card" />
        </div>
      ) : error ? (
        <div className="border border-red-200 bg-red-50 text-red-800 rounded-lg p-4 text-sm">{error}</div>
      ) : card ? (
        <>
          {/* Summary */}
          <div className="grid grid-cols-3 border rounded-lg overflow-hidden mb-4">
            <div className="p-4 text-center">
              <div className="text-[11px] font-semibold tracking-wide text-muted-foreground">WEEK TOTAL</div>
              <div className="text-xl font-bold">{fmtHours(card.totalHours)}</div>
            </div>
            <div className="p-4 text-center border-l">
              <div className="text-[11px] font-semibold tracking-wide text-muted-foreground">APPROVED</div>
              <div className="text-xl font-bold text-green-700">{fmtHours(card.approvedHours)}</div>
            </div>
            <div className="p-4 text-center border-l">
              <div className="text-[11px] font-semibold tracking-wide text-muted-foreground">PENDING</div>
              <div className="text-xl font-bold text-amber-700">{fmtHours(card.pendingHours)}</div>
            </div>
          </div>

          {/* Days */}
          <div className="space-y-3">
            {card.days.map((day) => {
              const isToday = day.date === todayIso;
              return (
                <div key={day.date} className={`border rounded-lg overflow-hidden ${isToday ? "border-primary" : ""}`}>
                  <div className="flex items-center justify-between px-4 py-2.5 bg-muted/50 border-b">
                    <div className="text-sm font-semibold">
                      {fmtDay(day.date)}
                      {isToday && <span className="ml-2 text-xs font-medium text-primary">Today</span>}
                    </div>
                    <div className={`text-sm font-semibold ${day.totalHours > 0 ? "" : "text-muted-foreground"}`}>
                      {fmtHours(day.totalHours)}
                    </div>
                  </div>
                  {day.entries.length === 0 ? (
                    <div className="px-4 py-3 text-sm text-muted-foreground">No entries</div>
                  ) : (
                    <ul className="divide-y">
                      {day.entries.map((e) => {
                        const fmtT = (iso: string) =>
                          new Date(iso).toLocaleTimeString("en-US", { timeZone: card.timezone, hour: "numeric", minute: "2-digit" });
                        return (
                          <li key={e.id} className="flex items-center justify-between gap-3 px-4 py-2.5">
                            <div className="min-w-0">
                              <div className="text-sm font-medium">
                                {fmtT(e.clockInTime)} → {e.open ? "now" : e.clockOutTime ? fmtT(e.clockOutTime) : "—"}
                              </div>
                              {(e.siteName || e.shiftTitle) && (
                                <div className="text-xs text-muted-foreground truncate">{e.siteName ?? e.shiftTitle}</div>
                              )}
                            </div>
                            <div className="flex items-center gap-3 shrink-0">
                              <span className="text-sm font-semibold">
                                {e.open ? "In progress" : fmtHours(e.hoursWorked ?? 0)}
                              </span>
                              <span className={`text-xs px-2 py-0.5 rounded ${APPROVAL_PILL[e.approvalStatus]}`}>
                                {e.approvalStatus.charAt(0).toUpperCase() + e.approvalStatus.slice(1)}
                              </span>
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>
              );
            })}
          </div>

          <p className="text-xs text-muted-foreground mt-4">
            Days follow the company timezone ({card.timezone}). Rejected entries are shown but excluded from totals.
            Totals use the same rounding as payroll, so this card always agrees with the Payroll Board.
          </p>
        </>
      ) : null}
    </div>
  );
}
