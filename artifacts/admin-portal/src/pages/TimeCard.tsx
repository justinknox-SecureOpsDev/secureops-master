import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearch, useLocation } from "wouter";
import {
  Clock, ChevronLeft, ChevronRight, Loader2, CalendarDays, FileDown, FileSpreadsheet,
  Plus, Pencil, Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { api, fetchWithAuth } from "@/lib/api";
import { useAuth } from "@/lib/auth";

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

type SiteRow = { id: string; name: string };

type SiteOfficer = {
  id: string;
  firstName: string | null;
  lastName: string | null;
  email: string;
  entryCount: number;
  lastClockInTime: string;
};

/** Full time-entry row from the admin tables API (fields the editor needs). */
type EntryRow = {
  id: string;
  employeeId: string;
  siteId: string | null;
  shiftId: string | null;
  clockInTime: string;
  clockOutTime: string | null;
  approvalStatus: "pending" | "approved" | "rejected";
  notes: string | null;
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

const userLabel = (u: { firstName: string | null; lastName: string | null; email: string }) =>
  `${u.firstName ?? ""} ${u.lastName ?? ""}`.trim() || u.email;

// ISO timestamp -> value for <input type="datetime-local"> in the browser's
// local time (YYYY-MM-DDTHH:mm). "" for null/invalid so the input stays empty.
function toLocalInput(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// datetime-local value -> ISO string (browser-local interpretation), or null.
function fromLocalInput(v: string): string | null {
  if (!v) return null;
  const d = new Date(v);
  if (isNaN(d.getTime())) return null;
  return d.toISOString();
}

type EditorState =
  | { mode: "create"; date: string }
  | { mode: "edit"; entryId: string };

type EditorForm = {
  siteId: string;
  clockIn: string;   // datetime-local value
  clockOut: string;  // datetime-local value ("" = still clocked in / unknown)
  approvalStatus: "pending" | "approved" | "rejected";
  notes: string;
};

const EMPTY_FORM: EditorForm = { siteId: "", clockIn: "", clockOut: "", approvalStatus: "pending", notes: "" };

export default function TimeCardPage() {
  const search = useSearch();
  const [, setLocation] = useLocation();
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const params = useMemo(() => new URLSearchParams(search), [search]);
  const employeeId = params.get("employeeId") ?? "";
  const week = params.get("week") ?? "";
  const siteId = params.get("siteId") ?? "";

  const [users, setUsers] = useState<UserRow[]>([]);
  const [sites, setSites] = useState<SiteRow[]>([]);
  const [siteOfficers, setSiteOfficers] = useState<SiteOfficer[] | null>(null);
  const [officersLoading, setOfficersLoading] = useState(false);
  const [officersError, setOfficersError] = useState<string | null>(null);
  const [card, setCard] = useState<TimeCard | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState<"pdf" | "csv" | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);

  // --- Entry editor (admin add/edit) ---
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [form, setForm] = useState<EditorForm>(EMPTY_FORM);
  const [editorLoading, setEditorLoading] = useState(false);
  const [editorError, setEditorError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // --- Delete confirmation ---
  const [deleteTarget, setDeleteTarget] = useState<CardEntry | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const download = async (format: "pdf" | "csv") => {
    if (!card) return;
    setError(null);
    setDownloading(format);
    try {
      const qs = new URLSearchParams({ employeeId: card.employeeId, weekStart: card.weekStart, format });
      const res = await fetchWithAuth(`/api/time-entries/time-card/export?${qs.toString()}`);
      if (!res.ok) {
        let msg = `Download failed (${res.status})`;
        try {
          const j = await res.json();
          if (j?.message) msg = j.message;
          else if (j?.error) msg = j.error;
        } catch { /* not JSON */ }
        throw new Error(msg);
      }
      const blob = await res.blob();
      const disp = res.headers.get("Content-Disposition") ?? "";
      const m = /filename="?([^";]+)"?/.exec(disp);
      const filename = m?.[1] ?? `time-card-${card.weekStart}.${format}`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Download failed.");
    } finally {
      setDownloading(null);
    }
  };

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
    api<{ rows: SiteRow[] }>("/admin/tables/sites?limit=500&sort=name&dir=asc")
      .then((r) => setSites(r.rows ?? []))
      .catch(() => setSites([]));
  }, []);

  // Site-first lookup: when a site is picked, the officer dropdown narrows to
  // officers who actually have time entries at that site.
  useEffect(() => {
    if (!siteId) { setSiteOfficers(null); setOfficersError(null); return; }
    let cancelled = false;
    setOfficersLoading(true);
    setOfficersError(null);
    api<{ officers: SiteOfficer[] }>(`/time-entries/time-card/site-officers?siteId=${encodeURIComponent(siteId)}`)
      .then((r) => { if (!cancelled) setSiteOfficers(r.officers ?? []); })
      .catch((e) => {
        if (!cancelled) {
          setSiteOfficers([]);
          setOfficersError((e as Error).message ?? "Could not load officers for this site");
        }
      })
      .finally(() => { if (!cancelled) setOfficersLoading(false); });
    return () => { cancelled = true; };
  }, [siteId]);

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
  }, [employeeId, week, refreshTick]);

  const refreshCard = useCallback(() => setRefreshTick((t) => t + 1), []);

  const navigate = (next: { siteId?: string; employeeId?: string; week?: string }) => {
    const qs = new URLSearchParams();
    const s = next.siteId ?? siteId;
    const e = next.employeeId ?? employeeId;
    const w = next.week ?? week;
    if (s) qs.set("siteId", s);
    if (e) qs.set("employeeId", e);
    if (w) qs.set("week", w);
    setLocation(`/payroll/time-card${qs.toString() ? `?${qs.toString()}` : ""}`);
  };

  // Officer options. Admins can ALWAYS pick any staff officer so they can
  // create a missing time card — even for someone with no entries yet. When a
  // site is picked we surface officers who actually worked there first (a
  // convenience group), then list everyone else under "All officers"; without a
  // site filter it's a single flat list of all staff.
  const officerGroups: Array<{ label: string | null; options: Array<{ id: string; label: string }> }> = useMemo(() => {
    const all = users.map((u) => ({ id: u.id, label: userLabel(u) }));
    if (!siteId) return [{ label: null, options: all }];
    const withEntries = new Set((siteOfficers ?? []).map((o) => o.id));
    return [
      { label: "Worked at this site", options: all.filter((o) => withEntries.has(o.id)) },
      { label: "All officers", options: all.filter((o) => !withEntries.has(o.id)) },
    ];
  }, [siteId, siteOfficers, users]);

  const todayIso = card
    ? new Date().toLocaleDateString("en-CA", { timeZone: card.timezone })
    : null;

  // ---- Editor helpers -------------------------------------------------------

  const openCreate = (date: string) => {
    setForm({ ...EMPTY_FORM, siteId, clockIn: `${date}T09:00` });
    setEditorError(null);
    setEditor({ mode: "create", date });
  };

  const openEdit = async (entry: CardEntry) => {
    setEditorError(null);
    setEditor({ mode: "edit", entryId: entry.id });
    setEditorLoading(true);
    try {
      const row = await api<EntryRow>(`/admin/tables/time_entries/${entry.id}`);
      setForm({
        siteId: row.siteId ?? "",
        clockIn: toLocalInput(row.clockInTime),
        clockOut: toLocalInput(row.clockOutTime),
        approvalStatus: row.approvalStatus ?? "pending",
        notes: row.notes ?? "",
      });
    } catch (e) {
      setEditorError((e as Error).message ?? "Could not load the entry.");
    } finally {
      setEditorLoading(false);
    }
  };

  const closeEditor = () => {
    if (saving) return;
    setEditor(null);
    setForm(EMPTY_FORM);
    setEditorError(null);
  };

  const computedHours: number | null = useMemo(() => {
    const cin = fromLocalInput(form.clockIn);
    const cout = fromLocalInput(form.clockOut);
    if (!cin || !cout) return null;
    const h = (new Date(cout).getTime() - new Date(cin).getTime()) / 3600000;
    if (!isFinite(h) || h <= 0) return null;
    return Math.round(h * 100) / 100;
  }, [form.clockIn, form.clockOut]);

  const saveEntry = async () => {
    if (!editor || !card) return;
    const clockInTime = fromLocalInput(form.clockIn);
    const clockOutTime = fromLocalInput(form.clockOut);
    if (!clockInTime) { setEditorError("Clock-in time is required."); return; }
    if (form.clockOut && !clockOutTime) { setEditorError("Clock-out time is invalid."); return; }
    if (clockOutTime && new Date(clockOutTime) <= new Date(clockInTime)) {
      setEditorError("Clock-out must be after clock-in.");
      return;
    }
    setSaving(true);
    setEditorError(null);
    const body = {
      siteId: form.siteId || null,
      clockInTime,
      clockOutTime,
      hoursWorked: clockOutTime ? computedHours : null,
      approvalStatus: form.approvalStatus,
      notes: form.notes.trim() ? form.notes.trim() : null,
    };
    try {
      if (editor.mode === "create") {
        await api(`/admin/tables/time_entries`, {
          method: "POST",
          body: { ...body, employeeId: card.employeeId },
        });
      } else {
        await api(`/admin/tables/time_entries/${editor.entryId}`, { method: "PUT", body });
      }
      setEditor(null);
      setForm(EMPTY_FORM);
      refreshCard();
    } catch (e) {
      setEditorError((e as Error).message ?? "Save failed.");
    } finally {
      setSaving(false);
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await api(`/admin/tables/time_entries/${deleteTarget.id}`, { method: "DELETE" });
      setDeleteTarget(null);
      refreshCard();
    } catch (e) {
      setDeleteError((e as Error).message ?? "Delete failed.");
    } finally {
      setDeleting(false);
    }
  };

  const fmtEntryTime = (iso: string) =>
    card
      ? new Date(iso).toLocaleTimeString("en-US", { timeZone: card.timezone, hour: "numeric", minute: "2-digit" })
      : new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });

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
      <div className="flex flex-col sm:flex-row sm:flex-wrap sm:items-center gap-3 mb-4">
        <label className="flex items-center gap-2 text-sm">
          <span className="text-muted-foreground shrink-0">Site</span>
          <select
            className="border rounded-md px-3 py-2 text-sm bg-background min-w-[180px]"
            value={siteId}
            onChange={(e) => navigate({ siteId: e.target.value, employeeId: "" })}
            aria-label="Filter officers by site"
          >
            <option value="">All sites</option>
            {sites.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
        </label>

        <label className="flex items-center gap-2 text-sm">
          <span className="text-muted-foreground shrink-0">Employee</span>
          <select
            className="border rounded-md px-3 py-2 text-sm bg-background min-w-[220px]"
            value={employeeId}
            onChange={(e) => navigate({ employeeId: e.target.value })}
            disabled={officersLoading}
            aria-label="Select employee"
          >
            <option value="">
              {officersLoading ? "Loading officers…" : "Select an employee…"}
            </option>
            {officerGroups.map((g) =>
              g.label === null
                ? g.options.map((u) => (
                    <option key={u.id} value={u.id}>{u.label}</option>
                  ))
                : g.options.length > 0 && (
                    <optgroup key={g.label} label={g.label}>
                      {g.options.map((u) => (
                        <option key={u.id} value={u.id}>{u.label}</option>
                      ))}
                    </optgroup>
                  ),
            )}
          </select>
        </label>

        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={!card || loading}
            onClick={() => card && navigate({ week: card.prevWeekStart })}
            aria-label="Previous week"
          >
            <ChevronLeft className="h-4 w-4" aria-hidden="true" />
          </Button>
          <button
            type="button"
            className="text-sm font-medium min-w-[190px] text-center hover:underline"
            onClick={() => navigate({ week: "" })}
            title="Jump to the current week"
            aria-label={card ? `Week of ${fmtRange(card.weekStart, card.weekEnd)}. Jump to the current week.` : "Current week"}
          >
            {card ? fmtRange(card.weekStart, card.weekEnd) : "Mon – Sun"}
          </button>
          <Button
            variant="outline"
            size="sm"
            disabled={!card || loading}
            onClick={() => card && navigate({ week: card.nextWeekStart })}
            aria-label="Next week"
          >
            <ChevronRight className="h-4 w-4" aria-hidden="true" />
          </Button>
        </div>

        <div className="flex items-center gap-2 sm:ml-auto">
          <Button
            variant="outline"
            size="sm"
            disabled={!card || loading || downloading !== null}
            onClick={() => download("pdf")}
            aria-label="Download PDF time card"
          >
            {downloading === "pdf"
              ? <Loader2 className="h-4 w-4 animate-spin mr-1.5" aria-hidden="true" />
              : <FileDown className="h-4 w-4 mr-1.5" aria-hidden="true" />}
            PDF
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={!card || loading || downloading !== null}
            onClick={() => download("csv")}
            aria-label="Download CSV time card"
          >
            {downloading === "csv"
              ? <Loader2 className="h-4 w-4 animate-spin mr-1.5" aria-hidden="true" />
              : <FileSpreadsheet className="h-4 w-4 mr-1.5" aria-hidden="true" />}
            CSV
          </Button>
        </div>
      </div>

      {officersError && (
        <div className="border border-amber-200 bg-amber-50 text-amber-800 rounded-lg p-3 text-sm mb-4">
          {officersError}
        </div>
      )}

      {!employeeId ? (
        <div className="border rounded-lg p-10 text-center text-muted-foreground">
          <CalendarDays className="h-8 w-8 mx-auto mb-3" aria-hidden="true" />
          {siteId && siteOfficers && siteOfficers.length === 0 && !officersLoading ? (
            <p className="text-sm">No officers have time entries at this site yet — pick any officer under “All officers” to start a new time card.</p>
          ) : siteId ? (
            <p className="text-sm">Pick an officer to see their weekly time card. Officers who worked at this site are listed first, but you can select anyone.</p>
          ) : (
            <p className="text-sm">Pick an employee to see their weekly time card — or pick a site first to narrow the list.</p>
          )}
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
                    <div className="flex items-center gap-2">
                      <div className={`text-sm font-semibold ${day.totalHours > 0 ? "" : "text-muted-foreground"}`}>
                        {fmtHours(day.totalHours)}
                      </div>
                      {isAdmin && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 px-2"
                          onClick={() => openCreate(day.date)}
                          aria-label={`Add time entry on ${fmtDay(day.date)}`}
                        >
                          <Plus className="h-4 w-4" aria-hidden="true" />
                        </Button>
                      )}
                    </div>
                  </div>
                  {day.entries.length === 0 ? (
                    <div className="px-4 py-3 text-sm text-muted-foreground">No entries</div>
                  ) : (
                    <ul className="divide-y">
                      {day.entries.map((e) => (
                        <li key={e.id} className="flex items-center justify-between gap-3 px-4 py-2.5">
                          <div className="min-w-0">
                            <div className="text-sm font-medium">
                              {fmtEntryTime(e.clockInTime)} → {e.open ? "now" : e.clockOutTime ? fmtEntryTime(e.clockOutTime) : "—"}
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
                            {isAdmin && (
                              <span className="flex items-center gap-1">
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  className="h-7 px-2"
                                  onClick={() => void openEdit(e)}
                                  aria-label={`Edit entry starting ${fmtEntryTime(e.clockInTime)}`}
                                >
                                  <Pencil className="h-4 w-4" aria-hidden="true" />
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  className="h-7 px-2 text-red-600 hover:text-red-700"
                                  onClick={() => { setDeleteError(null); setDeleteTarget(e); }}
                                  aria-label={`Delete entry starting ${fmtEntryTime(e.clockInTime)}`}
                                >
                                  <Trash2 className="h-4 w-4" aria-hidden="true" />
                                </Button>
                              </span>
                            )}
                          </div>
                        </li>
                      ))}
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

      {/* Add / edit entry dialog */}
      <Dialog open={editor !== null} onOpenChange={(open) => { if (!open) closeEditor(); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{editor?.mode === "create" ? "Add time entry" : "Edit time entry"}</DialogTitle>
            <DialogDescription>
              {card ? `For ${card.employeeName?.trim() || "this employee"}. ` : ""}
              Times are entered in your local timezone. Approved hours flow into the week&apos;s draft invoice automatically.
            </DialogDescription>
          </DialogHeader>
          {editorLoading ? (
            <div className="flex items-center justify-center py-8 text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin" aria-label="Loading entry" />
            </div>
          ) : (
            <div className="space-y-3">
              <div className="space-y-1">
                <label htmlFor="te-site" className="text-sm font-medium">Site</label>
                <select
                  id="te-site"
                  className="w-full border rounded-md px-3 py-2 text-sm bg-background"
                  value={form.siteId}
                  onChange={(e) => setForm((f) => ({ ...f, siteId: e.target.value }))}
                  disabled={saving}
                >
                  <option value="">No site</option>
                  {sites.map((s) => (
                    <option key={s.id} value={s.id}>{s.name}</option>
                  ))}
                </select>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label htmlFor="te-clock-in" className="text-sm font-medium">Clock in</label>
                  <input
                    id="te-clock-in"
                    type="datetime-local"
                    className="w-full border rounded-md px-3 py-2 text-sm bg-background"
                    value={form.clockIn}
                    onChange={(e) => setForm((f) => ({ ...f, clockIn: e.target.value }))}
                    disabled={saving}
                  />
                </div>
                <div className="space-y-1">
                  <label htmlFor="te-clock-out" className="text-sm font-medium">Clock out</label>
                  <input
                    id="te-clock-out"
                    type="datetime-local"
                    className="w-full border rounded-md px-3 py-2 text-sm bg-background"
                    value={form.clockOut}
                    onChange={(e) => setForm((f) => ({ ...f, clockOut: e.target.value }))}
                    disabled={saving}
                  />
                  <p className="text-xs text-muted-foreground">Leave empty for an in-progress entry.</p>
                </div>
              </div>
              <div className="space-y-1">
                <label htmlFor="te-status" className="text-sm font-medium">Approval</label>
                <select
                  id="te-status"
                  className="w-full border rounded-md px-3 py-2 text-sm bg-background"
                  value={form.approvalStatus}
                  onChange={(e) => setForm((f) => ({ ...f, approvalStatus: e.target.value as EditorForm["approvalStatus"] }))}
                  disabled={saving}
                >
                  <option value="pending">Pending</option>
                  <option value="approved">Approved</option>
                  <option value="rejected">Rejected</option>
                </select>
              </div>
              <div className="space-y-1">
                <label htmlFor="te-notes" className="text-sm font-medium">Notes</label>
                <textarea
                  id="te-notes"
                  className="w-full border rounded-md px-3 py-2 text-sm bg-background min-h-[64px]"
                  value={form.notes}
                  onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
                  disabled={saving}
                />
              </div>
              <p className="text-sm text-muted-foreground">
                Hours: <span className="font-medium text-foreground">{computedHours != null ? fmtHours(computedHours) : "—"}</span>
                {form.clockOut && computedHours == null ? " (clock-out must be after clock-in)" : ""}
              </p>
              {editorError && (
                <div className="border border-red-200 bg-red-50 text-red-800 rounded-md p-2.5 text-sm">{editorError}</div>
              )}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={closeEditor} disabled={saving}>Cancel</Button>
            <Button onClick={() => void saveEntry()} disabled={saving || editorLoading}>
              {saving && <Loader2 className="h-4 w-4 animate-spin mr-1.5" aria-hidden="true" />}
              {editor?.mode === "create" ? "Add entry" : "Save changes"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirmation */}
      <AlertDialog open={deleteTarget !== null} onOpenChange={(open) => { if (!open && !deleting) setDeleteTarget(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this time entry?</AlertDialogTitle>
            <AlertDialogDescription>
              {deleteTarget
                ? `${fmtEntryTime(deleteTarget.clockInTime)} → ${deleteTarget.open ? "now" : deleteTarget.clockOutTime ? fmtEntryTime(deleteTarget.clockOutTime) : "—"}${deleteTarget.siteName ? ` at ${deleteTarget.siteName}` : ""}. `
                : ""}
              This can&apos;t be undone. If the entry was approved, its hours are also removed from that week&apos;s draft invoice.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {deleteError && (
            <div className="border border-red-200 bg-red-50 text-red-800 rounded-md p-2.5 text-sm">{deleteError}</div>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => { e.preventDefault(); void confirmDelete(); }}
              disabled={deleting}
              className="bg-red-600 hover:bg-red-700 text-white"
            >
              {deleting && <Loader2 className="h-4 w-4 animate-spin mr-1.5" aria-hidden="true" />}
              Delete entry
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
