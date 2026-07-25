import { Fragment, useEffect, useMemo, useState } from "react";
import { useLocation } from "wouter";
import { Banknote, Loader2, ChevronRight, ChevronDown, ArrowRight, AlertTriangle, Clock, DollarSign, Pencil, Archive, ArchiveRestore } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from "@/components/ui/dialog";
import { api } from "@/lib/api";

type BoardBucket = {
  employeeId: string;
  employeeName: string | null;
  siteId: string | null;
  siteName: string | null;
  periodStart: string;
  periodEnd: string;
  totalHours: number;
  hourlyRate: number;
  grossPay: number;
  timeEntryIds: string[];
  entries: Array<{ id: string; clockInTime: string; hoursWorked: number; rate: number; holiday: string | null; hasClockOut: boolean; scheduledEnd: string | null; lastEditedByEmail: string | null; lastEditedAt: string | null; clockOutTime: string | null; employeeEdited: boolean; employeeEditReason: string | null; originalClockInTime: string | null; originalClockOutTime: string | null; confirmationStatus: string | null }>;
  existingPayrollEntryId: string | null;
  existingStatus: string | null;
  warnings: string[];
  // Present only in the Archived view (snapshot metadata).
  archivedAt?: string | null;
  archivedByEmail?: string | null;
  archiveReason?: string | null;
};

type BoardGroup = {
  siteId: string | null;
  siteName: string | null;
  periodStart: string;
  periodEnd: string;
  buckets: BoardBucket[];
  status: "ready" | "partial" | "processed" | "archived";
  totalHours: number;
  grossPay: number;
  officerCount: number;
};

type StatusFilter = "ready" | "partial" | "processed" | "all" | "archived";

// Snapshot of a time entry's editable fields, captured in the audit log
// before/after each admin correction. Mirrors timeEntryAudit.ts on the server.
type EntrySnapshot = {
  clockInTime?: string | null;
  clockOutTime?: string | null;
  hoursWorked?: string | null;
  payRateOverride?: string | null;
  notes?: string | null;
};

type AuditRow = {
  id: string;
  actorEmail: string | null;
  createdAt: string;
  metadata: {
    entryId?: string;
    before?: EntrySnapshot;
    after?: EntrySnapshot;
  } | null;
};

type HistoryEntry = { id: string; lastEditedByEmail: string | null; lastEditedAt: string | null };

// User-facing fields surfaced in the change history, in display order.
const HISTORY_FIELDS: { key: keyof EntrySnapshot; label: string; isDate?: boolean }[] = [
  { key: "clockInTime", label: "Clock In", isDate: true },
  { key: "clockOutTime", label: "Clock Out", isDate: true },
  { key: "hoursWorked", label: "Hours" },
  { key: "payRateOverride", label: "Pay rate override" },
  { key: "notes", label: "Notes" },
];

const fmtDateTime = (iso: string | null | undefined): string => {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
};

const fmtSnapshotValue = (value: string | null | undefined, isDate: boolean): string => {
  if (value === null || value === undefined || value === "") return "—";
  return isDate ? fmtDateTime(value) : value;
};

const fmtUsd = (n: number) =>
  `$${Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const fmtWeekRange = (periodStart: string, periodEnd: string) => {
  const opts: Intl.DateTimeFormatOptions = { weekday: "short", month: "short", day: "numeric" };
  const s = new Date(`${periodStart}T00:00:00`);
  const e = new Date(`${periodEnd}T00:00:00`);
  return `${s.toLocaleDateString("en-US", opts)} → ${e.toLocaleDateString("en-US", opts)}, ${e.getFullYear()}`;
};

const bucketKey = (b: { employeeId: string; siteId: string | null; periodStart: string }) =>
  `${b.employeeId}|${b.siteId ?? "__nosite__"}|${b.periodStart}`;

const statusPill = (status: BoardGroup["status"]) => {
  const map: Record<BoardGroup["status"], string> = {
    ready: "bg-green-100 text-green-800",
    partial: "bg-amber-100 text-amber-800",
    processed: "bg-blue-100 text-blue-800",
    archived: "bg-gray-200 text-gray-700",
  };
  const label =
    status === "ready" ? "Ready" :
    status === "partial" ? "Partially processed" :
    status === "archived" ? "Archived" :
    "Processed";
  return <span className={`text-xs px-2 py-0.5 rounded ${map[status]}`}>{label}</span>;
};

export default function PayrollBoardPage() {
  const [, setLocation] = useLocation();
  const [groups, setGroups] = useState<BoardGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("ready");
  const [siteId, setSiteId] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [openGroups, setOpenGroups] = useState<Set<string>>(new Set());
  const [openBuckets, setOpenBuckets] = useState<Set<string>>(new Set());
  const [hideWarnings, setHideWarnings] = useState(false);
  const [busy, setBusy] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [mode, setMode] = useState<"ach_csv" | "manual">("ach_csv");
  // Fix-clock-out dialog state. Opened from a "Set clock-out" button on
  // entries that are missing a clockOut. Snaps to scheduled shift end or
  // accepts a custom datetime.
  const [fixEntry, setFixEntry] = useState<
    | { id: string; clockInTime: string; scheduledEnd: string | null; employeeName: string | null }
    | null
  >(null);
  const [fixMode, setFixMode] = useState<"scheduled" | "custom">("scheduled");
  const [fixCustom, setFixCustom] = useState("");
  const [fixBusy, setFixBusy] = useState(false);
  // Apply-rate dialog state. Lets admin set a per-entry pay-rate
  // override on all underlying time entries of the currently selected
  // buckets -- fixes "Pay rate is $0" warnings without rewriting
  // shifts/employees.
  const [rateDialogOpen, setRateDialogOpen] = useState(false);
  const [rateInput, setRateInput] = useState("");
  const [onlyZeroRate, setOnlyZeroRate] = useState(true);
  const [rateBusy, setRateBusy] = useState(false);
  // Archive dialog state. Archiving moves selected buckets off the working
  // board into the Archived view (reviewable + restorable later).
  const [archiveDialogOpen, setArchiveDialogOpen] = useState(false);
  const [archiveReason, setArchiveReason] = useState("");
  const [archiveBusy, setArchiveBusy] = useState(false);
  const [unarchiveBusy, setUnarchiveBusy] = useState(false);
  const [toast, setToast] = useState<{ kind: "ok" | "err"; msg: string } | null>(null);
  const [sites, setSites] = useState<Array<{ id: string; name: string }>>([]);
  // Per-entry correction history dialog state. Sourced from audit_logs filtered
  // by entry id (the global audit middleware records before/after on each edit).
  const [historyTarget, setHistoryTarget] = useState<HistoryEntry | null>(null);
  const [historyRows, setHistoryRows] = useState<AuditRow[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);

  const openHistory = (e: HistoryEntry) => {
    setHistoryTarget(e);
    setHistoryRows([]);
    setHistoryError(null);
    setHistoryLoading(true);
    // Officer time-entry edits go through the generic audit middleware (no
    // dedicated action), so filter on entryId alone.
    const qs = new URLSearchParams({ entryId: e.id, limit: "200" }).toString();
    api<{ rows: AuditRow[] }>(`/admin/audit-logs?${qs}`)
      .then((data) => setHistoryRows(data.rows))
      .catch((err) => setHistoryError((err as Error).message))
      .finally(() => setHistoryLoading(false));
  };

  useEffect(() => {
    void (async () => {
      try {
        const rows = await api<Array<{ id: string; name: string }>>("/sites");
        setSites(rows);
      } catch { /* non-critical */ }
    })();
  }, []);

  const reload = async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ statusFilter });
      if (siteId) params.set("siteId", siteId);
      if (from) params.set("from", from);
      if (to) params.set("to", to);
      const data = await api<{ groups: BoardGroup[] }>(`/payroll/board?${params}`);
      setGroups(data.groups);
      setSelected(new Set());
      setOpenBuckets(new Set());
      // Auto-expand if only a handful of groups so admins immediately see the rows.
      if (data.groups.length <= 5) setOpenGroups(new Set(data.groups.map((g) => `${g.siteId ?? "__nosite__"}|${g.periodStart}`)));
    } catch (e) {
      showToast("err", `Load failed: ${(e as Error).message}`);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void reload(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [statusFilter, siteId, from, to]);

  const showToast = (kind: "ok" | "err", msg: string) => {
    setToast({ kind, msg });
    setTimeout(() => setToast(null), 5000);
  };

  // Selectable rows = anything not already processed/paid.
  const isSelectable = (b: BoardBucket) =>
    b.existingStatus !== "processed" && b.existingStatus !== "paid";

  const toggleRow = (b: BoardBucket) => {
    if (!isSelectable(b)) return;
    const k = bucketKey(b);
    const next = new Set(selected);
    if (next.has(k)) next.delete(k); else next.add(k);
    setSelected(next);
  };

  const toggleGroup = (g: BoardGroup) => {
    const keys = g.buckets.filter(isSelectable).map(bucketKey);
    const allSelected = keys.length > 0 && keys.every((k) => selected.has(k));
    const next = new Set(selected);
    if (allSelected) keys.forEach((k) => next.delete(k));
    else keys.forEach((k) => next.add(k));
    setSelected(next);
  };

  const toggleExpanded = (groupKey: string) => {
    const next = new Set(openGroups);
    if (next.has(groupKey)) next.delete(groupKey); else next.add(groupKey);
    setOpenGroups(next);
  };

  // Apply the optional "Hide buckets with warnings" filter client-side so
  // toggling doesn't require a round-trip. Groups that empty out after the
  // filter are dropped entirely.
  const visibleGroups = useMemo(() => {
    if (!hideWarnings) return groups;
    return groups
      .map((g) => {
        const buckets = g.buckets.filter((b) => b.warnings.length === 0);
        if (buckets.length === 0) return null;
        const totalHours = Math.round(buckets.reduce((a, b) => a + b.totalHours, 0) * 100) / 100;
        const grossPay = Math.round(buckets.reduce((a, b) => a + b.grossPay, 0) * 100) / 100;
        return { ...g, buckets, officerCount: buckets.length, totalHours, grossPay };
      })
      .filter((g): g is BoardGroup => g !== null);
  }, [groups, hideWarnings]);

  // Build flat selection summary.
  const allBuckets = useMemo(() => visibleGroups.flatMap((g) => g.buckets), [visibleGroups]);
  const selectedBuckets = useMemo(
    () => allBuckets.filter((b) => selected.has(bucketKey(b))),
    [allBuckets, selected],
  );
  const selGross = selectedBuckets.reduce((a, b) => a + b.grossPay, 0);

  // Patch a missing clock-out so the entry becomes payable. Server
  // recomputes hoursWorked from clockIn → chosen clockOut and audit-logs
  // the change (admin actor recorded via the auditLog middleware).
  const submitFix = async () => {
    if (!fixEntry) return;
    setFixBusy(true);
    try {
      const body: { useShiftEnd?: boolean; clockOutTime?: string } = {};
      if (fixMode === "scheduled") {
        body.useShiftEnd = true;
      } else {
        if (!fixCustom) {
          showToast("err", "Pick a clock-out date and time.");
          setFixBusy(false);
          return;
        }
        // The datetime-local input is naive — assume the admin entered
        // a local timestamp and let JS apply the browser timezone.
        const parsed = new Date(fixCustom);
        if (isNaN(parsed.getTime())) {
          showToast("err", "That clock-out time isn't valid.");
          setFixBusy(false);
          return;
        }
        body.clockOutTime = parsed.toISOString();
      }
      await api(`/time-entries/${fixEntry.id}/clock-out`, { method: "PATCH", body });
      setFixEntry(null);
      showToast("ok", "Clock-out saved. Hours have been recomputed.");
      await reload();
    } catch (e) {
      showToast("err", `Couldn't save clock-out: ${(e as Error).message}`);
    } finally {
      setFixBusy(false);
    }
  };

  // Apply a flat pay rate to every time entry inside the selected
  // buckets. The server defaults to onlyZeroRate=true so valid rates
  // aren't overwritten; admin can toggle that off.
  const submitApplyRate = async () => {
    const rate = parseFloat(rateInput);
    if (!isFinite(rate) || rate <= 0) {
      showToast("err", "Enter a pay rate greater than $0.");
      return;
    }
    if (rate > 1000) {
      showToast("err", "Pay rate must be $1,000/hr or less.");
      return;
    }
    const timeEntryIds = Array.from(
      new Set(selectedBuckets.flatMap((b) => b.entries.map((e) => e.id))),
    );
    if (timeEntryIds.length === 0) {
      showToast("err", "Select at least one bucket first.");
      return;
    }
    setRateBusy(true);
    try {
      const resp = await api<{ updatedCount: number; skippedCount: number }>(
        "/payroll/board/apply-rate",
        { method: "POST", body: { timeEntryIds, rate, onlyZeroRate } },
      );
      setRateDialogOpen(false);
      const parts = [`Updated ${resp.updatedCount} entr${resp.updatedCount === 1 ? "y" : "ies"} at ${fmtUsd(rate)}/hr`];
      if (resp.skippedCount > 0) parts.push(`${resp.skippedCount} skipped`);
      showToast("ok", parts.join(" · "));
      await reload();
    } catch (e) {
      showToast("err", `Couldn't apply rate: ${(e as Error).message}`);
    } finally {
      setRateBusy(false);
    }
  };

  // Archive the selected buckets. Server snapshots the current totals into a
  // payroll_entry with status='archived'; processed/paid weeks are skipped.
  const submitArchive = async () => {
    if (selectedBuckets.length === 0) return;
    setArchiveBusy(true);
    try {
      const resp = await api<{ archivedCount: number; skipped: unknown[] }>(
        "/payroll/board/archive",
        {
          method: "POST",
          body: {
            reason: archiveReason.trim() || undefined,
            selections: selectedBuckets.map((b) => ({
              employeeId: b.employeeId,
              siteId: b.siteId,
              periodStart: b.periodStart,
            })),
          },
        },
      );
      setArchiveDialogOpen(false);
      setArchiveReason("");
      const parts = [`Archived ${resp.archivedCount} officer-week${resp.archivedCount === 1 ? "" : "s"}`];
      if (resp.skipped.length > 0) parts.push(`${resp.skipped.length} skipped`);
      parts.push('view them under the "Archived" status filter');
      showToast("ok", parts.join(" · "));
      await reload();
    } catch (e) {
      showToast("err", `Couldn't archive: ${(e as Error).message}`);
    } finally {
      setArchiveBusy(false);
    }
  };

  // Restore selected archived rows back to the working board (status → pending).
  const submitUnarchive = async () => {
    const ids = Array.from(
      new Set(
        selectedBuckets
          .map((b) => b.existingPayrollEntryId)
          .filter((v): v is string => !!v),
      ),
    );
    if (ids.length === 0) return;
    setUnarchiveBusy(true);
    try {
      const resp = await api<{ restoredCount: number }>(
        "/payroll/board/unarchive",
        { method: "POST", body: { ids } },
      );
      showToast("ok", `Restored ${resp.restoredCount} officer-week${resp.restoredCount === 1 ? "" : "s"} to the board.`);
      await reload();
    } catch (e) {
      showToast("err", `Couldn't restore: ${(e as Error).message}`);
    } finally {
      setUnarchiveBusy(false);
    }
  };

  const submitProcess = async () => {
    if (selectedBuckets.length === 0) return;
    setBusy(true);
    try {
      const resp = await api<{ payrollEntryIds: string[]; mode: string; skipped: unknown[] }>(
        "/payroll/board/process",
        {
          method: "POST",
          body: {
            mode,
            selections: selectedBuckets.map((b) => ({
              employeeId: b.employeeId,
              siteId: b.siteId,
              periodStart: b.periodStart,
            })),
          },
        },
      );
      setDialogOpen(false);
      // Navigate to Pay Run with preselected ids + mode preset.
      const qs = new URLSearchParams();
      qs.set("ids", resp.payrollEntryIds.join(","));
      qs.set("mode", resp.mode);
      setLocation(`/payroll/pay-run?${qs.toString()}`);
    } catch (e) {
      showToast("err", `Process failed: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex-1 overflow-auto p-6 max-w-[1400px] mx-auto w-full">
      <div className="flex items-center gap-3 mb-1">
        <Banknote className="w-7 h-7 brand-gold" />
        <h1 className="text-2xl font-semibold text-brand-navy">Payroll Board</h1>
      </div>
      <p className="text-sm text-muted-foreground mb-6">
        Approved time entries grouped by site and week. Pick what to process — the selection is handed off
        to Pay Run with the chosen payment mode pre-selected.
      </p>

      {toast && (
        <div className={`mb-4 px-4 py-3 rounded border ${toast.kind === "ok" ? "bg-green-50 border-green-300 text-green-900" : "bg-red-50 border-red-300 text-red-900"}`}>
          {toast.msg}
        </div>
      )}

      {/* Filters */}
      <div className="flex flex-wrap gap-3 items-end mb-4 p-4 bg-white border rounded-lg">
        <div>
          <Label className="text-xs">Status</Label>
          <select
            className="block border rounded h-9 px-2 text-sm"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
          >
            <option value="ready">Ready</option>
            <option value="partial">Partially processed</option>
            <option value="processed">Processed</option>
            <option value="all">All</option>
            <option value="archived">Archived</option>
          </select>
        </div>
        <div>
          <Label className="text-xs">Site</Label>
          <select
            className="block border rounded h-9 px-2 text-sm min-w-[180px]"
            value={siteId}
            onChange={(e) => setSiteId(e.target.value)}
          >
            <option value="">All sites</option>
            {sites.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
        </div>
        <div>
          <Label className="text-xs">From</Label>
          <Input type="date" className="h-9" value={from} onChange={(e) => setFrom(e.target.value)} />
        </div>
        <div>
          <Label className="text-xs">To</Label>
          <Input type="date" className="h-9" value={to} onChange={(e) => setTo(e.target.value)} />
        </div>
        <div>
          <Label className="text-xs">Quick range</Label>
          <div className="flex gap-1 mt-0.5">
            {[
              { label: "This wk", days: 0 },
              { label: "Last wk", days: -7 },
              { label: "Last 2 wks", days: -14 },
              { label: "This mo", days: -30 },
            ].map(({ label, days }) => (
              <button
                key={label}
                type="button"
                className="px-2 py-1 text-xs border rounded hover:bg-accent"
                onClick={() => {
                  const now = new Date();
                  const dayOfWeek = now.getDay();
                  const monday = new Date(now);
                  monday.setDate(now.getDate() - ((dayOfWeek + 6) % 7));
                  const start = new Date(monday);
                  start.setDate(monday.getDate() + days);
                  const end = new Date(monday);
                  end.setDate(monday.getDate() + 6);
                  const iso = (d: Date) => d.toISOString().slice(0, 10);
                  setFrom(iso(start));
                  setTo(iso(end));
                }}
              >
                {label}
              </button>
            ))}
            <button
              type="button"
              className="px-2 py-1 text-xs border rounded hover:bg-accent"
              onClick={() => { setFrom(""); setTo(""); }}
            >
              Clear
            </button>
          </div>
        </div>
        <Button variant="outline" onClick={() => void reload()} disabled={loading}>
          {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : "Refresh"}
        </Button>
        <label className="flex items-center gap-2 text-sm cursor-pointer ml-auto select-none">
          <input
            type="checkbox"
            checked={hideWarnings}
            onChange={(e) => setHideWarnings(e.target.checked)}
            className="w-4 h-4"
          />
          Hide buckets with warnings
        </label>
      </div>

      {/* Sticky selection toolbar */}
      <div className="sticky top-0 z-10 flex flex-wrap items-center gap-3 mb-4 p-4 bg-brand-navy text-white rounded-lg shadow">
        <div className="flex-1 min-w-[200px]">
          <div className="text-xs uppercase tracking-wider opacity-70">Selected</div>
          <div className="text-xl font-semibold">
            {selectedBuckets.length} officer{selectedBuckets.length === 1 ? "" : "s"}
            <span className="ml-4 brand-gold">·  {fmtUsd(selGross)} gross</span>
          </div>
        </div>
        {statusFilter === "archived" ? (
          <Button
            variant="outline"
            className="bg-white/10 border-white/30 text-white hover:bg-white/20"
            onClick={() => void submitUnarchive()}
            disabled={selectedBuckets.length === 0 || unarchiveBusy}
            title="Restore the selected archived weeks back to the working board"
          >
            {unarchiveBusy ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <ArchiveRestore className="w-4 h-4 mr-2" />}
            Restore to board
          </Button>
        ) : (
          <>
            <Button
              variant="outline"
              className="bg-white/10 border-white/30 text-white hover:bg-white/20"
              onClick={() => { setRateInput(""); setOnlyZeroRate(true); setRateDialogOpen(true); }}
              disabled={selectedBuckets.length === 0 || rateBusy}
              title="Set a pay rate on all time entries inside the selected buckets"
            >
              {rateBusy ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <DollarSign className="w-4 h-4 mr-2" />}
              Apply pay rate
            </Button>
            <Button
              variant="outline"
              className="bg-white/10 border-white/30 text-white hover:bg-white/20"
              onClick={() => { setArchiveReason(""); setArchiveDialogOpen(true); }}
              disabled={selectedBuckets.length === 0 || archiveBusy}
              title="Move the selected weeks off the board into the Archived view (restorable later)"
            >
              {archiveBusy ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Archive className="w-4 h-4 mr-2" />}
              Archive
            </Button>
            <Button
              className="bg-brand-gold text-brand-navy hover:bg-brand-gold/90"
              onClick={() => setDialogOpen(true)}
              disabled={selectedBuckets.length === 0 || busy}
            >
              {busy ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <ArrowRight className="w-4 h-4 mr-2" />}
              Process selected
            </Button>
          </>
        )}
      </div>

      {/* Groups */}
      {loading ? (
        <div className="bg-white border rounded-lg p-12 text-center text-muted-foreground">
          <Loader2 className="w-6 h-6 animate-spin inline" />
        </div>
      ) : visibleGroups.length === 0 ? (
        <div className="bg-white border rounded-lg p-12 text-center text-muted-foreground">
          {statusFilter === "archived"
            ? "No archived payroll weeks match these filters."
            : groups.length > 0 && hideWarnings
            ? "All buckets have warnings — uncheck \"Hide buckets with warnings\" to see them."
            : "No approved time entries match these filters."}
        </div>
      ) : (
        <div className="space-y-3">
          {visibleGroups.map((g) => {
            const gk = `${g.siteId ?? "__nosite__"}|${g.periodStart}`;
            const selectableKeys = g.buckets.filter(isSelectable).map(bucketKey);
            const allGroupSelected = selectableKeys.length > 0 && selectableKeys.every((k) => selected.has(k));
            const someGroupSelected = selectableKeys.some((k) => selected.has(k));
            const expanded = openGroups.has(gk);
            const warningCount = g.buckets.filter((b) => b.warnings.length > 0).length;
            return (
              <div key={gk} className="bg-white border rounded-lg overflow-hidden">
                <div className="flex items-center gap-3 px-4 py-3 bg-brand-navy text-white">
                  <input
                    type="checkbox"
                    checked={allGroupSelected}
                    ref={(el) => { if (el) el.indeterminate = !allGroupSelected && someGroupSelected; }}
                    onChange={() => toggleGroup(g)}
                    className="w-4 h-4"
                    disabled={selectableKeys.length === 0}
                    title={selectableKeys.length === 0 ? "All officers in this group are already processed" : "Toggle all selectable rows"}
                  />
                  <button
                    type="button"
                    onClick={() => toggleExpanded(gk)}
                    className="flex items-center gap-2 flex-1 text-left"
                  >
                    {expanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                    <div>
                      <div className="font-semibold">{g.siteName ?? "(No site)"}</div>
                      <div className="text-xs opacity-70">
                        {fmtWeekRange(g.periodStart, g.periodEnd)} · {g.officerCount} officer{g.officerCount === 1 ? "" : "s"} · {g.totalHours.toFixed(2)}h
                      </div>
                    </div>
                  </button>
                  <div className="flex items-center gap-3">
                    {warningCount > 0 && (
                      <span
                        className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded bg-amber-100 text-amber-900"
                        title="One or more buckets have problems that will block Pay Run — expand to see details"
                      >
                        <AlertTriangle className="w-3 h-3" />
                        {warningCount} warning{warningCount === 1 ? "" : "s"}
                      </span>
                    )}
                    {statusPill(g.status)}
                    <div className="text-right">
                      <div className="text-xs uppercase tracking-wider opacity-70">Gross</div>
                      <div className="brand-gold text-lg font-semibold">{fmtUsd(g.grossPay)}</div>
                    </div>
                  </div>
                </div>

                {expanded && (
                  <div className="overflow-x-auto" tabIndex={0} role="region" aria-label="Payroll entries table">
                  <table className="w-full text-sm">
                    <thead className="text-left text-[10px] uppercase tracking-wider text-muted-foreground">
                      <tr>
                        <th className="px-3 py-1.5 w-8"></th>
                        <th className="px-3 py-1.5">Officer</th>
                        <th className="px-3 py-1.5 text-right">Hours</th>
                        <th className="px-3 py-1.5 text-right">Rate</th>
                        <th className="px-3 py-1.5 text-right">Gross</th>
                        <th className="px-3 py-1.5">Time entries</th>
                        <th className="px-3 py-1.5">Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {g.buckets.map((b) => {
                        const k = bucketKey(b);
                        const selectable = isSelectable(b);
                        const bucketOpen = openBuckets.has(k);
                        return (
                          <Fragment key={k}>
                            <tr className={`border-t ${selectable ? "hover:bg-gray-50" : "bg-gray-50/60 opacity-70"}`}>
                              <td className="px-3 py-2">
                                <input
                                  type="checkbox"
                                  checked={selected.has(k)}
                                  onChange={() => toggleRow(b)}
                                  disabled={!selectable}
                                  title={selectable ? undefined : `Already ${b.existingStatus}`}
                                />
                              </td>
                              <td className="px-3 py-2">
                                <div className="flex items-center gap-2">
                                  <span className="font-medium">{b.employeeName ?? b.employeeId.slice(0, 8)}</span>
                                  {b.warnings.length > 0 && (
                                    <span
                                      className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-900"
                                      title={b.warnings.join("\n")}
                                    >
                                      <AlertTriangle className="w-3 h-3" />
                                      {b.warnings.length}
                                    </span>
                                  )}
                                </div>
                                {b.warnings.length > 0 && (
                                  <ul className="mt-1 text-[11px] text-amber-800 list-disc list-inside">
                                    {b.warnings.map((w, i) => (
                                      <li key={i}>{w}</li>
                                    ))}
                                  </ul>
                                )}
                                {b.existingStatus === "archived" && b.archivedAt && (
                                  <div className="mt-1 text-[11px] text-muted-foreground">
                                    Archived {fmtDateTime(b.archivedAt)}
                                    {b.archivedByEmail ? ` by ${b.archivedByEmail}` : ""}
                                    {b.archiveReason ? <> — <span className="italic">“{b.archiveReason}”</span></> : null}
                                  </div>
                                )}
                              </td>
                              <td className="px-3 py-2 text-right">{b.totalHours.toFixed(2)}</td>
                              <td className="px-3 py-2 text-right">{fmtUsd(b.hourlyRate)}</td>
                              <td className="px-3 py-2 text-right font-semibold">{fmtUsd(b.grossPay)}</td>
                              <td className="px-3 py-2 text-xs text-muted-foreground">
                                {b.existingStatus === "archived" ? (
                                  <span title="Totals were snapshotted when this week was archived — restore it to the board to see live time entries">
                                    snapshot
                                  </span>
                                ) : (
                                  <button
                                    type="button"
                                    className="inline-flex items-center gap-1 hover:underline"
                                    onClick={() => {
                                      const next = new Set(openBuckets);
                                      if (next.has(k)) next.delete(k); else next.add(k);
                                      setOpenBuckets(next);
                                    }}
                                    title="Show underlying time entries"
                                  >
                                    {bucketOpen
                                      ? <ChevronDown className="w-3 h-3" />
                                      : <ChevronRight className="w-3 h-3" />}
                                    {b.entries.length} entr{b.entries.length === 1 ? "y" : "ies"}
                                  </button>
                                )}
                              </td>
                              <td className="px-3 py-2">
                                {b.existingStatus
                                  ? <span className={`text-xs px-2 py-0.5 rounded ${
                                      b.existingStatus === "paid" ? "bg-green-100 text-green-800" :
                                      b.existingStatus === "processed" ? "bg-blue-100 text-blue-800" :
                                      "bg-gray-100 text-gray-700"
                                    }`}>{b.existingStatus}</span>
                                  : <span className="text-xs px-2 py-0.5 rounded bg-green-100 text-green-800">ready</span>}
                              </td>
                            </tr>
                            {bucketOpen && (
                              <tr className="bg-gray-50/40">
                                <td colSpan={7} className="px-3 py-2">
                                  <table className="w-full text-xs">
                                    <thead className="text-[10px] uppercase tracking-wider text-muted-foreground">
                                      <tr>
                                        <th className="px-2 py-1 text-left">Clock-in (UTC)</th>
                                        <th className="px-2 py-1 text-right">Hours</th>
                                        <th className="px-2 py-1 text-right">Rate</th>
                                        <th className="px-2 py-1 text-right">Line gross</th>
                                        <th className="px-2 py-1 text-left">Time entry ID</th>
                                      </tr>
                                    </thead>
                                    <tbody>
                                      {b.entries.map((e) => (
                                        <tr key={e.id} className={`border-t border-gray-200 ${!e.hasClockOut ? "bg-amber-50/60" : ""}`}>
                                          <td className="px-2 py-1">
                                            <div className="flex items-center gap-1.5">
                                              <span>{new Date(e.clockInTime).toLocaleString()}</span>
                                              {e.holiday && (
                                                <span
                                                  className="inline-flex items-center rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-900"
                                                  title={`${e.holiday} — holiday pay (1.5×)`}
                                                >
                                                  Holiday 1.5×
                                                </span>
                                              )}
                                            </div>
                                          </td>
                                          <td className="px-2 py-1 text-right">
                                            {e.hasClockOut ? e.hoursWorked.toFixed(2) : <span className="text-amber-800">— no clock-out</span>}
                                          </td>
                                          <td className="px-2 py-1 text-right">{fmtUsd(e.rate)}</td>
                                          <td className="px-2 py-1 text-right">{fmtUsd(e.hoursWorked * e.rate)}</td>
                                          <td className="px-2 py-1 font-mono text-[10px] text-muted-foreground">
                                            <div className="flex items-center gap-2">
                                              <span>{e.id}</span>
                                              {e.lastEditedAt && (
                                                <button
                                                  type="button"
                                                  onClick={() => openHistory({ id: e.id, lastEditedByEmail: e.lastEditedByEmail, lastEditedAt: e.lastEditedAt })}
                                                  className="inline-flex items-center gap-1 rounded-full bg-amber-100 text-amber-800 border border-amber-300 px-1.5 py-0.5 text-[10px] font-medium leading-none hover:bg-amber-200 focus:outline-none focus:ring-2 focus:ring-amber-400 cursor-pointer font-sans normal-case"
                                                  title={`Edited by ${e.lastEditedByEmail ?? "an admin"} on ${fmtDateTime(e.lastEditedAt)} — view full change history`}
                                                >
                                                  <Pencil className="w-2.5 h-2.5" />
                                                  Edited
                                                </button>
                                              )}
                                              {e.employeeEdited && (
                                                <span
                                                  className="inline-flex items-center rounded-full bg-violet-100 text-violet-800 border border-violet-300 px-1.5 py-0.5 text-[10px] font-medium leading-none font-sans normal-case"
                                                  title={[
                                                    e.originalClockInTime || e.originalClockOutTime
                                                      ? `Recorded: ${e.originalClockInTime ? new Date(e.originalClockInTime).toLocaleString() : "—"} → ${e.originalClockOutTime ? new Date(e.originalClockOutTime).toLocaleString() : "—"}`
                                                      : null,
                                                    `Submitted: ${new Date(e.clockInTime).toLocaleString()} → ${e.clockOutTime ? new Date(e.clockOutTime).toLocaleString() : "—"}`,
                                                    e.employeeEditReason ? `Reason: ${e.employeeEditReason}` : null,
                                                  ].filter(Boolean).join("\n") || "Officer edited their times before submitting."}
                                                >
                                                  Edited by officer
                                                </span>
                                              )}
                                              {!e.hasClockOut && (
                                                <Button
                                                  size="sm"
                                                  variant="outline"
                                                  className="h-6 px-2 text-[10px] gap-1"
                                                  onClick={() => {
                                                    setFixEntry({
                                                      id: e.id,
                                                      clockInTime: e.clockInTime,
                                                      scheduledEnd: e.scheduledEnd,
                                                      employeeName: b.employeeName,
                                                    });
                                                    setFixMode(e.scheduledEnd ? "scheduled" : "custom");
                                                    setFixCustom("");
                                                  }}
                                                  title="Patch the missing clock-out so this entry becomes payable"
                                                >
                                                  <Clock className="w-3 h-3" />
                                                  Set clock-out
                                                </Button>
                                              )}
                                            </div>
                                          </td>
                                        </tr>
                                      ))}
                                    </tbody>
                                  </table>
                                </td>
                              </tr>
                            )}
                          </Fragment>
                        );
                      })}
                    </tbody>
                  </table>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <Dialog open={!!fixEntry} onOpenChange={(o) => { if (!o) setFixEntry(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Set missing clock-out</DialogTitle>
            <DialogDescription>
              {fixEntry?.employeeName ?? "This officer"} clocked in at{" "}
              {fixEntry && new Date(fixEntry.clockInTime).toLocaleString()} but never clocked out.
              Pick a clock-out time and we'll recompute their hours. This is recorded in the audit log.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <label className={`flex items-start gap-3 p-3 border rounded ${fixEntry?.scheduledEnd ? "cursor-pointer hover:bg-gray-50" : "opacity-60 cursor-not-allowed"}`}>
              <input
                type="radio"
                name="fixMode"
                value="scheduled"
                checked={fixMode === "scheduled"}
                onChange={() => setFixMode("scheduled")}
                disabled={!fixEntry?.scheduledEnd}
                className="mt-1"
              />
              <div>
                <div className="font-medium">Use scheduled shift end</div>
                <div className="text-xs text-muted-foreground">
                  {fixEntry?.scheduledEnd
                    ? new Date(fixEntry.scheduledEnd).toLocaleString()
                    : "No linked shift — pick a custom time instead."}
                </div>
              </div>
            </label>
            <label className="flex items-start gap-3 p-3 border rounded cursor-pointer hover:bg-gray-50">
              <input
                type="radio"
                name="fixMode"
                value="custom"
                checked={fixMode === "custom"}
                onChange={() => setFixMode("custom")}
                className="mt-1"
              />
              <div className="flex-1">
                <div className="font-medium">Enter a clock-out time</div>
                <Input
                  type="datetime-local"
                  className="h-9 mt-2"
                  value={fixCustom}
                  onChange={(e) => { setFixCustom(e.target.value); setFixMode("custom"); }}
                />
              </div>
            </label>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setFixEntry(null)} disabled={fixBusy}>Cancel</Button>
            <Button onClick={submitFix} disabled={fixBusy} className="bg-brand-navy text-white hover:opacity-90">
              {fixBusy ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
              Save clock-out
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Process {selectedBuckets.length} officer{selectedBuckets.length === 1 ? "" : "s"}</DialogTitle>
            <DialogDescription>
              How should we hand these off to Pay Run? You'll be taken to Pay Run with the rows pre-selected.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <label className="flex items-start gap-3 p-3 border rounded cursor-pointer hover:bg-gray-50">
              <input
                type="radio"
                name="mode"
                value="ach_csv"
                checked={mode === "ach_csv"}
                onChange={() => setMode("ach_csv")}
                className="mt-1"
              />
              <div>
                <div className="font-medium">Send to Pay Run for ACH CSV export</div>
                <div className="text-xs text-muted-foreground">Pay Run will export a bank-ready CSV and mark these rows as "processed".</div>
              </div>
            </label>
            <label className="flex items-start gap-3 p-3 border rounded cursor-pointer hover:bg-gray-50">
              <input
                type="radio"
                name="mode"
                value="manual"
                checked={mode === "manual"}
                onChange={() => setMode("manual")}
                className="mt-1"
              />
              <div>
                <div className="font-medium">Send to Pay Run for manual payment</div>
                <div className="text-xs text-muted-foreground">Pay Run will let you record a bank reference and mark as paid directly.</div>
              </div>
            </label>
            <div className="text-xs text-muted-foreground border-t pt-2">
              Total gross: <strong>{fmtUsd(selGross)}</strong>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)} disabled={busy}>Cancel</Button>
            <Button onClick={submitProcess} disabled={busy} className="bg-brand-navy text-white hover:opacity-90">
              {busy ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
              Confirm
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={rateDialogOpen} onOpenChange={setRateDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Apply pay rate</DialogTitle>
            <DialogDescription>
              Set a per-entry pay rate on the time entries inside the {selectedBuckets.length}
              {" "}selected officer-week{selectedBuckets.length === 1 ? "" : "s"}.
              This overrides the shift’s pay rate and the employee’s default rate for these entries only;
              the change is recorded in the audit log.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div>
              <Label className="text-xs">Pay rate (USD per hour)</Label>
              <Input
                type="number"
                min="0"
                step="0.01"
                placeholder="e.g. 18.50"
                value={rateInput}
                onChange={(e) => setRateInput(e.target.value)}
                className="h-9 mt-1"
                autoFocus
              />
            </div>
            <label className="flex items-start gap-3 p-3 border rounded cursor-pointer hover:bg-gray-50">
              <input
                type="checkbox"
                checked={onlyZeroRate}
                onChange={(e) => setOnlyZeroRate(e.target.checked)}
                className="mt-1"
              />
              <div>
                <div className="font-medium">Only fill in entries that currently have $0/hr</div>
                <div className="text-xs text-muted-foreground">
                  Safer for wide selections — valid rates already on file won’t change.
                  Uncheck to force-overwrite every entry in the selection.
                </div>
              </div>
            </label>
            <div className="text-xs text-muted-foreground border-t pt-2">
              Scope: {selectedBuckets.reduce((acc, b) => acc + b.entries.length, 0)} time entr{selectedBuckets.reduce((acc, b) => acc + b.entries.length, 0) === 1 ? "y" : "ies"} in {selectedBuckets.length} bucket{selectedBuckets.length === 1 ? "" : "s"}
              {onlyZeroRate && (
                <> · {selectedBuckets.reduce((acc, b) => acc + b.entries.filter((e) => e.rate <= 0).length, 0)} currently at $0/hr</>
              )}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRateDialogOpen(false)} disabled={rateBusy}>Cancel</Button>
            <Button onClick={submitApplyRate} disabled={rateBusy} className="bg-brand-navy text-white hover:opacity-90">
              {rateBusy ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
              Apply
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={archiveDialogOpen} onOpenChange={setArchiveDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Archive {selectedBuckets.length} officer-week{selectedBuckets.length === 1 ? "" : "s"}</DialogTitle>
            <DialogDescription>
              Archived weeks leave the working board and won't be processed or paid, but nothing is
              deleted — find them any time under the "Archived" status filter, where you can restore
              them to the board. Weeks already processed or paid are skipped.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div>
              <Label className="text-xs">Reason (optional)</Label>
              <textarea
                className="mt-1 w-full border rounded p-2 text-sm min-h-[70px]"
                maxLength={500}
                placeholder="e.g. duplicate entries, disputed hours, wrong site…"
                value={archiveReason}
                onChange={(e) => setArchiveReason(e.target.value)}
              />
            </div>
            <div className="text-xs text-muted-foreground border-t pt-2">
              Total gross being archived: <strong>{fmtUsd(selGross)}</strong>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setArchiveDialogOpen(false)} disabled={archiveBusy}>Cancel</Button>
            <Button onClick={submitArchive} disabled={archiveBusy} className="bg-brand-navy text-white hover:opacity-90">
              {archiveBusy ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Archive className="w-4 h-4 mr-2" />}
              Archive
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Per-entry correction history dialog */}
      <Dialog open={!!historyTarget} onOpenChange={(open) => { if (!open) setHistoryTarget(null); }}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Change History</DialogTitle>
            {historyTarget && (
              <DialogDescription>
                Corrections to time entry <span className="font-mono">{historyTarget.id}</span>
              </DialogDescription>
            )}
          </DialogHeader>
          <div className="text-sm">
            {historyLoading ? (
              <div className="text-muted-foreground p-4">Loading…</div>
            ) : historyError ? (
              <div className="flex items-center gap-2 text-red-600 bg-red-50 border border-red-200 rounded p-3">
                <AlertTriangle className="w-4 h-4 shrink-0" />
                {historyError}
              </div>
            ) : historyRows.length === 0 ? (
              <div className="text-muted-foreground p-4 text-center border rounded-lg bg-slate-50">
                No recorded edits for this entry.
              </div>
            ) : (
              <div className="space-y-4 max-h-[60vh] overflow-y-auto pr-1">
                {historyRows.map((row) => {
                  const before = row.metadata?.before ?? {};
                  const after = row.metadata?.after ?? {};
                  const changes = HISTORY_FIELDS.filter(
                    (f) => (before[f.key] ?? null) !== (after[f.key] ?? null),
                  );
                  return (
                    <div key={row.id} className="border rounded-lg p-3 space-y-2">
                      <div className="flex items-center justify-between gap-2 text-xs">
                        <span className="font-medium text-slate-700">
                          {row.actorEmail ?? "an admin"}
                        </span>
                        <span className="text-muted-foreground">{fmtDateTime(row.createdAt)}</span>
                      </div>
                      {changes.length === 0 ? (
                        <p className="text-xs text-muted-foreground">No field-level changes recorded.</p>
                      ) : (
                        <div className="overflow-x-auto" tabIndex={0} role="region" aria-label="Change history table">
                        <table className="w-full text-xs">
                          <thead>
                            <tr className="text-left text-muted-foreground">
                              <th className="font-medium pb-1">Field</th>
                              <th className="font-medium pb-1">Before</th>
                              <th className="font-medium pb-1">After</th>
                            </tr>
                          </thead>
                          <tbody>
                            {changes.map((f) => (
                              <tr key={f.key} className="align-top">
                                <td className="pr-3 py-0.5 font-medium text-slate-600">{f.label}</td>
                                <td className="pr-3 py-0.5 text-red-700 line-through">
                                  {fmtSnapshotValue(before[f.key], !!f.isDate)}
                                </td>
                                <td className="py-0.5 text-emerald-700">
                                  {fmtSnapshotValue(after[f.key], !!f.isDate)}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setHistoryTarget(null)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
