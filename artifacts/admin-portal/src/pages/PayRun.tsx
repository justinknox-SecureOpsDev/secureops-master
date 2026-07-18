import { useEffect, useMemo, useRef, useState } from "react";
import { Banknote, Download, CheckCircle2, AlertTriangle, Loader2, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { fetchWithAuth } from "@/lib/api";
import { useIsMobile } from "@/hooks/use-mobile";

type PayrollRow = {
  id: string;
  employeeId: string;
  employeeName: string | null;
  siteId: string | null;
  siteName: string | null;
  periodStart: string;
  periodEnd: string;
  totalHours: string;
  hourlyRate: string;
  grossPay: string;
  tax: string;
  netPay: string;
  status: string;
  paidAt: string | null;
};

type PreviewRow = PayrollRow & {
  employeeEmail: string | null;
  paidMethod: string | null;
  paymentReference: string | null;
  bankAccountName: string | null;
  bankAccountNumber: string | null;
  bankBsb: string | null;
  directDepositConsent: boolean | null;
  warnings: string[];
};

type Preview = {
  rows: PreviewRow[];
  counts: { total: number; payable: number; withWarnings: number; alreadyPaid: number };
  totals: { gross: number; tax: number; net: number };
};

const fmtUsd = (n: number | string) =>
  `$${Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const maskAccount = (s: string | null) => (s ? `••••${s.slice(-4)}` : "—");

// Week label "Mon Jan 6 → Sun Jan 12, 2025" from a YYYY-MM-DD start date.
const fmtWeekRange = (periodStart: string, periodEnd: string) => {
  const opts: Intl.DateTimeFormatOptions = { weekday: "short", month: "short", day: "numeric" };
  const s = new Date(`${periodStart}T00:00:00`);
  const e = new Date(`${periodEnd}T00:00:00`);
  const yr = e.getFullYear();
  return `${s.toLocaleDateString("en-US", opts)} → ${e.toLocaleDateString("en-US", opts)}, ${yr}`;
};

type SiteGroup = {
  siteId: string | null;
  siteName: string;
  weeks: Map<string, PayrollRow[]>; // key = periodStart
  total: number;
  count: number;
};

// Group rows by Site → Week (periodStart). Sites alphabetical, weeks newest first.
const groupBySiteAndWeek = (rows: PayrollRow[]): SiteGroup[] => {
  const sites = new Map<string, SiteGroup>();
  for (const r of rows) {
    const key = r.siteId ?? "__nosite__";
    let g = sites.get(key);
    if (!g) {
      g = {
        siteId: r.siteId,
        siteName: r.siteName ?? "(No site)",
        weeks: new Map(),
        total: 0,
        count: 0,
      };
      sites.set(key, g);
    }
    const wk = g.weeks.get(r.periodStart) ?? [];
    wk.push(r);
    g.weeks.set(r.periodStart, wk);
    g.total += Number(r.netPay);
    g.count += 1;
  }
  return Array.from(sites.values())
    .sort((a, b) => {
      // "(No site)" sinks to the bottom.
      if (a.siteId === null && b.siteId !== null) return 1;
      if (b.siteId === null && a.siteId !== null) return -1;
      return a.siteName.localeCompare(b.siteName);
    })
    .map((g) => ({
      ...g,
      weeks: new Map(
        Array.from(g.weeks.entries()).sort(([a], [b]) => b.localeCompare(a)),
      ),
    }));
};

export default function PayRunPage() {
  // Honor `?ids=a,b,c&mode=ach_csv|manual` so the Payroll Board can hand off a
  // pre-selected batch. We parse once at mount and feed `preselectIds` into the
  // load effect so the rows are highlighted as soon as they arrive.
  const initialPreselect = useMemo(() => {
    if (typeof window === "undefined") return { ids: [] as string[], mode: null as null | "ach_csv" | "manual" };
    const qs = new URLSearchParams(window.location.search);
    const idsParam = qs.get("ids") ?? "";
    const ids = idsParam.split(",").map((s) => s.trim()).filter(Boolean);
    const modeParam = qs.get("mode");
    const mode: "ach_csv" | "manual" | null =
      modeParam === "ach_csv" || modeParam === "manual" ? modeParam : null;
    return { ids, mode };
  }, []);

  const isMobile = useIsMobile();
  const [rows, setRows] = useState<PayrollRow[]>([]);
  const [loading, setLoading] = useState(true);
  // When a board handoff arrives we widen the filter so the preselected rows
  // are guaranteed to show up regardless of their current status.
  const [statusFilter, setStatusFilter] = useState<"pending" | "processed" | "all">(
    initialPreselect.ids.length > 0 ? "all" : "pending",
  );
  const [periodStart, setPeriodStart] = useState("");
  const [periodEnd, setPeriodEnd] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set(initialPreselect.ids));
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [toast, setToast] = useState<{ kind: "ok" | "err"; msg: string } | null>(null);
  const [paidRef, setPaidRef] = useState("");
  const [handoffBanner, setHandoffBanner] = useState<null | { count: number; mode: "ach_csv" | "manual" }>(
    initialPreselect.ids.length > 0 && initialPreselect.mode
      ? { count: initialPreselect.ids.length, mode: initialPreselect.mode }
      : null,
  );
  // When the Payroll Board hands off a batch with a chosen mode, we actually
  // preset the corresponding action: scroll its button into view, focus it
  // (or the bank-reference input for manual), and ring it for visual emphasis.
  const exportBtnRef = useRef<HTMLButtonElement | null>(null);
  const markPaidBtnRef = useRef<HTMLButtonElement | null>(null);
  const paidRefInputRef = useRef<HTMLInputElement | null>(null);
  const presetMode = initialPreselect.mode;
  useEffect(() => {
    if (!presetMode || loading || rows.length === 0) return;
    // Run once when rows first arrive after a handoff.
    if (presetMode === "ach_csv") {
      exportBtnRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
      exportBtnRef.current?.focus();
    } else if (presetMode === "manual") {
      markPaidBtnRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
      paidRefInputRef.current?.focus();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading]);

  const authHeaders = useMemo(
    () => ({ "Content-Type": "application/json" }),
    [],
  );

  const reload = async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (statusFilter !== "all") params.set("status", statusFilter);
      if (periodStart) params.set("periodStart", periodStart);
      if (periodEnd) params.set("periodEnd", periodEnd);
      const res = await fetchWithAuth(`/api/payroll?${params.toString()}`, { headers: authHeaders });
      const data = await res.json();
      const list: PayrollRow[] = Array.isArray(data) ? data : [];
      setRows(list);
      // Preserve a preselection that arrived via ?ids=… on first load, but
      // narrow it to ids actually present in the current result set so the
      // selected count never lies.
      setSelected((prev) => {
        const ids = new Set(list.map((r) => r.id));
        const kept = new Set(Array.from(prev).filter((id) => ids.has(id)));
        return kept;
      });
      setPreview(null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void reload(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [statusFilter, periodStart, periodEnd]);

  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id); else next.add(id);
    setSelected(next);
  };
  const toggleAll = () => {
    if (selected.size === rows.length) setSelected(new Set());
    else setSelected(new Set(rows.map((r) => r.id)));
  };
  // Bulk-toggle a group of ids: if every id is selected, deselect all; otherwise select all.
  const toggleMany = (ids: string[]) => {
    const allSelected = ids.length > 0 && ids.every((id) => selected.has(id));
    const next = new Set(selected);
    if (allSelected) ids.forEach((id) => next.delete(id));
    else ids.forEach((id) => next.add(id));
    setSelected(next);
  };

  const showToast = (kind: "ok" | "err", msg: string) => {
    setToast({ kind, msg });
    setTimeout(() => setToast(null), 5000);
  };

  const runPreview = async () => {
    if (selected.size === 0) return;
    setBusy("preview");
    try {
      const res = await fetchWithAuth("/api/payroll/pay-run/preview", {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({ ids: Array.from(selected) }),
      });
      if (!res.ok) throw new Error(await res.text());
      setPreview(await res.json());
    } catch (e) {
      showToast("err", `Preview failed: ${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  };

  const exportCsv = async () => {
    if (selected.size === 0) return;
    setBusy("csv");
    try {
      const res = await fetchWithAuth("/api/payroll/pay-run/export-csv", {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({ ids: Array.from(selected) }),
      });
      if (!res.ok) {
        const txt = await res.text();
        throw new Error(txt || `HTTP ${res.status}`);
      }
      const batch = res.headers.get("X-Pay-Run-Batch") || "batch";
      const count = res.headers.get("X-Pay-Run-Count") || "0";
      const skipped = res.headers.get("X-Pay-Run-Skipped") || "0";
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `wcsg-payroll-${batch}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      showToast("ok", `Exported ${count} row(s) (${skipped} skipped). Batch ${batch}. Status set to "processed".`);
      await reload();
    } catch (e) {
      showToast("err", `Export failed: ${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  };

  const markPaid = async () => {
    if (selected.size === 0) return;
    setBusy("paid");
    try {
      const res = await fetchWithAuth("/api/payroll/pay-run/mark-paid", {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({ ids: Array.from(selected), paymentReference: paidRef || null, method: "manual" }),
      });
      if (!res.ok) throw new Error(await res.text());
      const j = await res.json();
      showToast("ok", `Marked ${j.marked} as paid.`);
      setPaidRef("");
      await reload();
    } catch (e) {
      showToast("err", `Mark paid failed: ${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  };

  const stripePay = async () => {
    setBusy("stripe");
    try {
      const res = await fetchWithAuth("/api/payroll/pay-run/stripe", {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({ ids: Array.from(selected) }),
      });
      const j = await res.json();
      showToast("err", j.message || `Stripe Connect not enabled.`);
    } finally {
      setBusy(null);
    }
  };

  const selectedRows = rows.filter((r) => selected.has(r.id));
  const selTotal = selectedRows.reduce((a, r) => a + Number(r.netPay), 0);

  return (
    <div className="flex-1 overflow-auto p-6 max-w-[1400px] mx-auto w-full">
      <div className="flex items-center gap-3 mb-1">
        <Banknote className="w-7 h-7 brand-gold" />
        <h1 className="text-2xl font-semibold text-brand-navy">Pay Run</h1>
      </div>
      <p className="text-sm text-muted-foreground mb-6">
        Select payroll entries → preview → export an ACH/CSV file for your bank, then mark as paid once funds settle.
      </p>

      {toast && (
        <div className={`mb-4 px-4 py-3 rounded border ${toast.kind === "ok" ? "bg-green-50 border-green-300 text-green-900" : "bg-red-50 border-red-300 text-red-900"}`}>
          {toast.msg}
        </div>
      )}

      {handoffBanner && (
        <div className="mb-4 px-4 py-3 rounded border border-amber-300 bg-amber-50 text-amber-900 flex items-center justify-between gap-3">
          <div className="text-sm">
            <strong>{handoffBanner.count}</strong> row{handoffBanner.count === 1 ? "" : "s"} pre-selected from the Payroll Board.
            {handoffBanner.mode === "ach_csv"
              ? <> Use <strong>Export ACH/CSV</strong> below to send the batch to your bank.</>
              : <> Use <strong>Mark as paid</strong> below once you've sent the manual payment.</>}
          </div>
          <button
            type="button"
            className="text-xs underline opacity-70 hover:opacity-100"
            onClick={() => setHandoffBanner(null)}
          >dismiss</button>
        </div>
      )}

      {/* Filters */}
      <div className="flex flex-wrap gap-3 items-end mb-4 p-4 bg-white border rounded-lg">
        <div>
          <Label className="text-xs">Status</Label>
          <select
            aria-label="Filter by status"
            className="block border rounded h-9 px-2 text-sm"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as typeof statusFilter)}
          >
            <option value="pending">Pending</option>
            <option value="processed">Processed (CSV exported)</option>
            <option value="all">All</option>
          </select>
        </div>
        <div>
          <Label className="text-xs">Period start ≥</Label>
          <Input aria-label="Period start on or after" type="date" className="h-9" value={periodStart} onChange={(e) => setPeriodStart(e.target.value)} />
        </div>
        <div>
          <Label className="text-xs">Period end ≤</Label>
          <Input aria-label="Period end on or before" type="date" className="h-9" value={periodEnd} onChange={(e) => setPeriodEnd(e.target.value)} />
        </div>
        <Button variant="outline" onClick={() => void reload()} disabled={loading}>
          {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : "Refresh"}
        </Button>
      </div>

      {/* Selection summary + actions */}
      <div className="flex flex-wrap items-center gap-3 mb-4 p-4 bg-brand-navy text-white rounded-lg">
        <div className="flex-1 min-w-[200px]">
          <div className="text-xs uppercase tracking-wider opacity-70">Selected</div>
          <div className="text-xl font-semibold">
            {selected.size} <span className="text-sm font-normal opacity-80">of {rows.length}</span>
            <span className="ml-4 brand-gold">{fmtUsd(selTotal)}</span>
          </div>
        </div>
        <Button variant="outline" className="text-brand-navy" onClick={runPreview} disabled={selected.size === 0 || busy !== null}>
          {busy === "preview" ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
          Preview
        </Button>
        <Button
          ref={exportBtnRef}
          className={`bg-brand-gold text-brand-navy hover:bg-brand-gold/90 ${presetMode === "ach_csv" ? "ring-2 ring-offset-2 ring-offset-brand-navy ring-brand-gold animate-pulse" : ""}`}
          onClick={exportCsv}
          disabled={selected.size === 0 || busy !== null}
        >
          {busy === "csv" ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Download className="w-4 h-4 mr-2" />}
          Export ACH CSV
        </Button>
        <div className={`flex gap-2 items-center ${presetMode === "manual" ? "ring-2 ring-offset-2 ring-offset-brand-navy ring-brand-gold rounded p-1" : ""}`}>
          <Input
            ref={paidRefInputRef}
            placeholder="Bank ref. (optional)"
            className="h-9 w-44 text-brand-navy"
            value={paidRef}
            onChange={(e) => setPaidRef(e.target.value)}
          />
          <Button
            ref={markPaidBtnRef}
            variant="outline"
            className="text-brand-navy"
            onClick={markPaid}
            disabled={selected.size === 0 || busy !== null}
          >
            {busy === "paid" ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <CheckCircle2 className="w-4 h-4 mr-2" />}
            Mark Paid
          </Button>
        </div>
        <Button
          variant="outline"
          className="text-brand-navy opacity-70"
          title="Stripe Connect scaffold — set STRIPE_CONNECT_ENABLED=true to activate"
          onClick={stripePay}
          disabled={selected.size === 0 || busy !== null}
        >
          {busy === "stripe" ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Zap className="w-4 h-4 mr-2" />}
          Pay via Stripe
        </Button>
      </div>

      {/* Preview panel */}
      {preview && (
        <div className="mb-4 p-4 bg-amber-50 border border-amber-300 rounded-lg">
          <div className="font-semibold text-brand-navy mb-2">Pay-run preview</div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm mb-3">
            <div><span className="text-muted-foreground">Total rows:</span> <strong>{preview.counts.total}</strong></div>
            <div><span className="text-muted-foreground">Payable now:</span> <strong className="text-green-700">{preview.counts.payable}</strong></div>
            <div><span className="text-muted-foreground">With warnings:</span> <strong className="text-amber-700">{preview.counts.withWarnings}</strong></div>
            <div><span className="text-muted-foreground">Already paid:</span> <strong>{preview.counts.alreadyPaid}</strong></div>
            <div><span className="text-muted-foreground">Gross:</span> <strong>{fmtUsd(preview.totals.gross)}</strong></div>
            <div><span className="text-muted-foreground">Net (to pay):</span> <strong className="brand-gold">{fmtUsd(preview.totals.net)}</strong></div>
          </div>
          {preview.rows.some((r) => r.warnings.length > 0) && (
            <div className="text-sm">
              <div className="font-medium text-amber-800 flex items-center gap-1 mb-1">
                <AlertTriangle className="w-4 h-4" /> Rows with warnings (excluded from CSV)
              </div>
              <ul className="text-xs space-y-0.5">
                {preview.rows.filter((r) => r.warnings.length > 0).map((r) => (
                  <li key={r.id}>
                    <strong>{r.employeeName}</strong> — {r.warnings.join("; ")}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {/* Grouped by Site → Week */}
      {loading ? (
        <div className="bg-white border rounded-lg p-12 text-center text-muted-foreground">
          <Loader2 className="w-6 h-6 animate-spin inline" />
        </div>
      ) : rows.length === 0 ? (
        <div className="bg-white border rounded-lg p-12 text-center text-muted-foreground">
          No payroll entries match these filters.
        </div>
      ) : (
        <div className="space-y-4">
          {groupBySiteAndWeek(rows).map((site) => {
            const siteIds = Array.from(site.weeks.values()).flat().map((r) => r.id);
            const siteAllSelected = siteIds.every((id) => selected.has(id));
            const siteSomeSelected = siteIds.some((id) => selected.has(id));
            return (
              <div key={site.siteId ?? "__nosite__"} className="bg-white border rounded-lg overflow-hidden">
                {/* Site header */}
                <div className="flex items-center gap-3 px-4 py-3 bg-brand-navy text-white">
                  <input
                    type="checkbox"
                    aria-label="Select all rows for this site"
                    checked={siteAllSelected}
                    ref={(el) => { if (el) el.indeterminate = !siteAllSelected && siteSomeSelected; }}
                    onChange={() => toggleMany(siteIds)}
                    className="w-4 h-4"
                  />
                  <div className="flex-1">
                    <div className="font-semibold text-base">{site.siteName}</div>
                    <div className="text-xs opacity-70">
                      {site.count} entr{site.count === 1 ? "y" : "ies"} · {site.weeks.size} week{site.weeks.size === 1 ? "" : "s"}
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="text-xs uppercase tracking-wider opacity-70">Site total (net)</div>
                    <div className="brand-gold text-lg font-semibold">{fmtUsd(site.total)}</div>
                  </div>
                </div>

                {/* Weeks */}
                {Array.from(site.weeks.entries()).map(([weekStart, weekRows]) => {
                  const weekIds = weekRows.map((r) => r.id);
                  const weekTotal = weekRows.reduce((a, r) => a + Number(r.netPay), 0);
                  const weekAll = weekIds.every((id) => selected.has(id));
                  const weekSome = weekIds.some((id) => selected.has(id));
                  return (
                    <div key={weekStart} className="border-t">
                      <div className="flex items-center gap-3 px-4 py-2 bg-gray-50 border-b">
                        <input
                          type="checkbox"
                          aria-label="Select all rows for this week"
                          checked={weekAll}
                          ref={(el) => { if (el) el.indeterminate = !weekAll && weekSome; }}
                          onChange={() => toggleMany(weekIds)}
                          className="w-3.5 h-3.5"
                        />
                        <div className="flex-1 text-sm">
                          <span className="font-medium text-brand-navy">Week of {fmtWeekRange(weekRows[0].periodStart, weekRows[0].periodEnd)}</span>
                          <span className="ml-2 text-xs text-muted-foreground">({weekRows.length} employee{weekRows.length === 1 ? "" : "s"})</span>
                        </div>
                        <div className="text-sm text-muted-foreground">
                          Week net: <strong className="text-brand-navy">{fmtUsd(weekTotal)}</strong>
                        </div>
                      </div>
                      {isMobile ? (
                        <div className="divide-y">
                          {weekRows.map((r) => {
                            const pv = preview?.rows.find((p) => p.id === r.id);
                            const hasWarn = pv && pv.warnings.length > 0;
                            return (
                              <div key={r.id} className={`p-3 space-y-2 ${hasWarn ? "bg-amber-50/40" : ""}`}>
                                <div className="flex items-start gap-3">
                                  <input type="checkbox" className="mt-1" aria-label={`Select payroll row for ${r.employeeName ?? r.employeeId.slice(0, 8)}`} checked={selected.has(r.id)} onChange={() => toggle(r.id)} />
                                  <div className="flex-1 min-w-0">
                                    <div className="flex items-start justify-between gap-2">
                                      <span className="font-medium">{r.employeeName ?? r.employeeId.slice(0, 8)}</span>
                                      <span className={`text-xs px-2 py-0.5 rounded shrink-0 ${
                                        r.status === "paid" ? "bg-green-100 text-green-800" :
                                        r.status === "processed" ? "bg-blue-100 text-blue-800" :
                                        "bg-gray-100 text-gray-700"
                                      }`}>{r.status}</span>
                                    </div>
                                    {pv && (
                                      <div className="text-xs text-muted-foreground mt-0.5 break-words">
                                        {pv.bankAccountName ?? "—"} · rt {pv.bankBsb ?? "—"} · acct {maskAccount(pv.bankAccountNumber)}
                                        {hasWarn && (
                                          <span className="ml-2 text-amber-700">⚠ {pv.warnings[0]}{pv.warnings.length > 1 ? ` (+${pv.warnings.length - 1})` : ""}</span>
                                        )}
                                      </div>
                                    )}
                                  </div>
                                </div>
                                <div className="grid grid-cols-4 gap-2 text-center text-sm pl-7">
                                  <div>
                                    <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Hours</div>
                                    <div>{Number(r.totalHours).toFixed(2)}</div>
                                  </div>
                                  <div>
                                    <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Rate</div>
                                    <div>{fmtUsd(r.hourlyRate)}</div>
                                  </div>
                                  <div>
                                    <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Gross</div>
                                    <div>{fmtUsd(r.grossPay)}</div>
                                  </div>
                                  <div>
                                    <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Net</div>
                                    <div className="font-semibold">{fmtUsd(r.netPay)}</div>
                                  </div>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      ) : (
                      <div className="overflow-x-auto" tabIndex={0} role="region" aria-label="Weekly payroll rows table">
                      <table className="w-full text-sm">
                        <thead className="text-left text-[10px] uppercase tracking-wider text-muted-foreground">
                          <tr>
                            <th className="px-3 py-1.5 w-8"></th>
                            <th className="px-3 py-1.5">Employee</th>
                            <th className="px-3 py-1.5 text-right">Hours</th>
                            <th className="px-3 py-1.5 text-right">Rate</th>
                            <th className="px-3 py-1.5 text-right">Gross</th>
                            <th className="px-3 py-1.5 text-right">Net</th>
                            <th className="px-3 py-1.5">Status</th>
                          </tr>
                        </thead>
                        <tbody>
                          {weekRows.map((r) => {
                            const pv = preview?.rows.find((p) => p.id === r.id);
                            const hasWarn = pv && pv.warnings.length > 0;
                            return (
                              <tr key={r.id} className={`border-t hover:bg-gray-50 ${hasWarn ? "bg-amber-50/40" : ""}`}>
                                <td className="px-3 py-2">
                                  <input type="checkbox" aria-label={`Select payroll row for ${r.employeeName ?? r.employeeId.slice(0, 8)}`} checked={selected.has(r.id)} onChange={() => toggle(r.id)} />
                                </td>
                                <td className="px-3 py-2">
                                  <div className="font-medium">{r.employeeName ?? r.employeeId.slice(0, 8)}</div>
                                  {pv && (
                                    <div className="text-xs text-muted-foreground">
                                      {pv.bankAccountName ?? "—"} · rt {pv.bankBsb ?? "—"} · acct {maskAccount(pv.bankAccountNumber)}
                                      {hasWarn && (
                                        <span className="ml-2 text-amber-700">⚠ {pv.warnings[0]}{pv.warnings.length > 1 ? ` (+${pv.warnings.length - 1})` : ""}</span>
                                      )}
                                    </div>
                                  )}
                                </td>
                                <td className="px-3 py-2 text-right">{Number(r.totalHours).toFixed(2)}</td>
                                <td className="px-3 py-2 text-right">{fmtUsd(r.hourlyRate)}</td>
                                <td className="px-3 py-2 text-right">{fmtUsd(r.grossPay)}</td>
                                <td className="px-3 py-2 text-right font-semibold">{fmtUsd(r.netPay)}</td>
                                <td className="px-3 py-2">
                                  <span className={`text-xs px-2 py-0.5 rounded ${
                                    r.status === "paid" ? "bg-green-100 text-green-800" :
                                    r.status === "processed" ? "bg-blue-100 text-blue-800" :
                                    "bg-gray-100 text-gray-700"
                                  }`}>{r.status}</span>
                                </td>
                              </tr>
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
            );
          })}

          {/* Quick "select all" button below for the rare bulk case */}
          <div className="flex items-center justify-end gap-2 text-xs text-muted-foreground pt-1">
            <button onClick={toggleAll} className="underline hover:text-brand-navy">
              {selected.size === rows.length ? "Deselect all" : `Select all (${rows.length})`}
            </button>
          </div>
        </div>
      )}

      <p className="text-xs text-muted-foreground mt-4">
        Workflow: <strong>pending</strong> → exporting the CSV marks rows <strong>processed</strong> (file batch ID stored as reference) → after your bank confirms settlement, click <strong>Mark Paid</strong> with the bank reference number.
        Stripe Connect transfers are scaffolded behind the <code>STRIPE_CONNECT_ENABLED</code> environment flag.
      </p>
    </div>
  );
}
