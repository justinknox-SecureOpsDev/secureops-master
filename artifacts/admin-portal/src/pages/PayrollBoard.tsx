import { Fragment, useEffect, useMemo, useState } from "react";
import { useLocation } from "wouter";
import { Banknote, Loader2, ChevronRight, ChevronDown, ArrowRight, AlertTriangle } from "lucide-react";
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
  entries: Array<{ id: string; clockInTime: string; hoursWorked: number; rate: number }>;
  existingPayrollEntryId: string | null;
  existingStatus: string | null;
  warnings: string[];
};

type BoardGroup = {
  siteId: string | null;
  siteName: string | null;
  periodStart: string;
  periodEnd: string;
  buckets: BoardBucket[];
  status: "ready" | "partial" | "processed";
  totalHours: number;
  grossPay: number;
  officerCount: number;
};

type StatusFilter = "ready" | "partial" | "processed" | "all";

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
  };
  const label = status === "ready" ? "Ready" : status === "partial" ? "Partially processed" : "Processed";
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
  const [toast, setToast] = useState<{ kind: "ok" | "err"; msg: string } | null>(null);
  const [sites, setSites] = useState<Array<{ id: string; name: string }>>([]);

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
        <Button
          className="bg-brand-gold text-brand-navy hover:bg-brand-gold/90"
          onClick={() => setDialogOpen(true)}
          disabled={selectedBuckets.length === 0 || busy}
        >
          {busy ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <ArrowRight className="w-4 h-4 mr-2" />}
          Process selected
        </Button>
      </div>

      {/* Groups */}
      {loading ? (
        <div className="bg-white border rounded-lg p-12 text-center text-muted-foreground">
          <Loader2 className="w-6 h-6 animate-spin inline" />
        </div>
      ) : visibleGroups.length === 0 ? (
        <div className="bg-white border rounded-lg p-12 text-center text-muted-foreground">
          {groups.length > 0 && hideWarnings
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
                              </td>
                              <td className="px-3 py-2 text-right">{b.totalHours.toFixed(2)}</td>
                              <td className="px-3 py-2 text-right">{fmtUsd(b.hourlyRate)}</td>
                              <td className="px-3 py-2 text-right font-semibold">{fmtUsd(b.grossPay)}</td>
                              <td className="px-3 py-2 text-xs text-muted-foreground">
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
                                        <tr key={e.id} className="border-t border-gray-200">
                                          <td className="px-2 py-1">{new Date(e.clockInTime).toLocaleString()}</td>
                                          <td className="px-2 py-1 text-right">{e.hoursWorked.toFixed(2)}</td>
                                          <td className="px-2 py-1 text-right">{fmtUsd(e.rate)}</td>
                                          <td className="px-2 py-1 text-right">{fmtUsd(e.hoursWorked * e.rate)}</td>
                                          <td className="px-2 py-1 font-mono text-[10px] text-muted-foreground">{e.id}</td>
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
                )}
              </div>
            );
          })}
        </div>
      )}

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
    </div>
  );
}
