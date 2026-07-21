import { useEffect, useMemo, useRef, useState } from "react";
import { Banknote, Download, CheckCircle2, AlertTriangle, Loader2, Zap, Building2, X } from "lucide-react";
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
  paidMethod: string | null;
  paymentReference: string | null;
};

type PreviewRow = PayrollRow & {
  employeeEmail: string | null;
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

type SystemStatus = {
  pncConfigured?: boolean;
};

const fmtUsd = (n: number | string) =>
  `$${Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const maskAccount = (s: string | null) => (s ? `••••${s.slice(-4)}` : "—");

// Settlement label derived from a raw PNC status response. PNC's exact schema
// varies by API version, so we scan the payload for status-like string fields
// and bucket them: rejected > settled > accepted > pending (most-specific wins).
type PncSettlement = "pending" | "accepted" | "settled" | "rejected" | "error";

const derivePncSettlement = (data: unknown): PncSettlement => {
  const statuses: string[] = [];
  const walk = (v: unknown): void => {
    if (v == null) return;
    if (Array.isArray(v)) { v.forEach(walk); return; }
    if (typeof v === "object") {
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        if (typeof val === "string" && /status|state/i.test(k)) statuses.push(val.toLowerCase());
        else walk(val);
      }
    }
  };
  walk(data);
  if (statuses.some((s) => /reject|fail|return|error|cancel/.test(s))) return "rejected";
  if (statuses.some((s) => /settl|complet|paid|success/.test(s))) return "settled";
  if (statuses.some((s) => /accept|approv|process|submit/.test(s))) return "accepted";
  return "pending";
};

const PNC_BADGE_STYLES: Record<PncSettlement, string> = {
  pending: "bg-gray-100 text-gray-700 border-gray-300",
  accepted: "bg-yellow-100 text-yellow-800 border-yellow-300",
  settled: "bg-green-100 text-green-800 border-green-300",
  rejected: "bg-red-100 text-red-800 border-red-300",
  error: "bg-gray-100 text-gray-500 border-gray-300",
};

const PNC_BADGE_LABELS: Record<PncSettlement, string> = {
  pending: "PNC: Pending",
  accepted: "PNC: Accepted",
  settled: "PNC: Settled",
  rejected: "PNC: Rejected",
  error: "PNC: Unavailable",
};

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
  const [systemStatus, setSystemStatus] = useState<SystemStatus>({});
  // PNC error alert — persists until dismissed (more prominent than a toast).
  const [pncError, setPncError] = useState<{ message: string; detail?: unknown } | null>(null);
  // PNC status modal — shows the full raw PNC response for one reference.
  const [pncStatusModal, setPncStatusModal] = useState<{ customerReference: string; data: unknown } | null>(null);
  // Inline settlement badges: paymentReference → derived status + raw payload.
  // Fetched once per reload (page load / manual Refresh), never on a timer.
  const [pncStatuses, setPncStatuses] = useState<Record<string, { settlement: PncSettlement; data: unknown }>>({});
  const [pncStatusesLoading, setPncStatusesLoading] = useState(false);
  // Post-success cooldown on the "Send via PNC" button (~2s) to absorb
  // accidental double-clicks on slow networks.
  const [pncCooldown, setPncCooldown] = useState(false);
  // Per-attempt idempotency key: generated once when a submission attempt
  // starts and reused for any rapid duplicate invocation (double-click) until
  // the attempt fully settles (request done + cooldown elapsed). The server
  // replays the original response for duplicate keys instead of re-submitting.
  const pncIdemKeyRef = useRef<string | null>(null);

  const exportBtnRef = useRef<HTMLButtonElement | null>(null);
  const markPaidBtnRef = useRef<HTMLButtonElement | null>(null);
  const paidRefInputRef = useRef<HTMLInputElement | null>(null);
  const presetMode = initialPreselect.mode;
  useEffect(() => {
    if (!presetMode || loading || rows.length === 0) return;
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

  // Fetch system status once on mount to know if PNC is configured.
  useEffect(() => {
    fetchWithAuth("/api/admin/system/status")
      .then((r) => r.json())
      .then((d) => setSystemStatus(d as SystemStatus))
      .catch(() => {});
  }, []);

  // Fetch live PNC settlement status for every unique paymentReference among
  // processed pnc_api rows. One request per unique reference, only on explicit
  // reloads (mount, filter change, Refresh click) — never on a timer.
  const pncFetchGeneration = useRef(0);
  const fetchPncStatuses = async (list: PayrollRow[]) => {
    const generation = ++pncFetchGeneration.current;
    const refs = Array.from(new Set(
      list
        .filter((r) => r.status === "processed" && r.paidMethod === "pnc_api" && r.paymentReference)
        .map((r) => r.paymentReference as string),
    ));
    if (refs.length === 0) {
      if (generation === pncFetchGeneration.current) setPncStatuses({});
      return;
    }
    setPncStatusesLoading(true);
    try {
      const results = await Promise.all(refs.map(async (ref) => {
        try {
          const res = await fetchWithAuth(`/api/payroll/pay-run/pnc-status?customerReference=${encodeURIComponent(ref)}`);
          const data: unknown = await res.json();
          if (!res.ok) return [ref, { settlement: "error" as PncSettlement, data }] as const;
          return [ref, { settlement: derivePncSettlement(data), data }] as const;
        } catch (e) {
          return [ref, { settlement: "error" as PncSettlement, data: { message: (e as Error).message } }] as const;
        }
      }));
      // Drop stale results if a newer reload has started since this fetch began.
      if (generation === pncFetchGeneration.current) setPncStatuses(Object.fromEntries(results));
    } finally {
      if (generation === pncFetchGeneration.current) setPncStatusesLoading(false);
    }
  };

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
      setSelected((prev) => {
        const ids = new Set(list.map((r) => r.id));
        const kept = new Set(Array.from(prev).filter((id) => ids.has(id)));
        return kept;
      });
      setPreview(null);
      void fetchPncStatuses(list);
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

  const sendViaPnc = async () => {
    if (selected.size === 0 || pncCooldown) return;
    // Reuse the in-flight attempt's key if a duplicate click slips through;
    // only mint a new key when starting a fresh attempt.
    if (!pncIdemKeyRef.current) pncIdemKeyRef.current = crypto.randomUUID();
    const idempotencyKey = pncIdemKeyRef.current;
    setPncError(null);
    setBusy("pnc");
    try {
      const res = await fetchWithAuth("/api/payroll/pay-run/pnc", {
        method: "POST",
        headers: authHeaders,
        // idempotencyKey: server dedupes duplicate submissions of this exact
        // request within a 5-minute window (double-click / retry protection).
        body: JSON.stringify({ ids: Array.from(selected), idempotencyKey }),
      });
      const j = await res.json();
      if (!res.ok) {
        // Rotate the key so a deliberate retry is a fresh submission.
        pncIdemKeyRef.current = null;
        setPncError({
          message: j.message || `PNC submission failed (HTTP ${res.status})`,
          detail: j.pncErrors ?? j.skipped ?? undefined,
        });
        return;
      }
      showToast("ok", `Sent to PNC — batch ${j.multipaymentId} · ${j.processed} row(s) processed.`);
      // Keep the button disabled briefly after success so a lagging second
      // click on a slow network can't fire another submission. The key is
      // held through the cooldown (duplicates replay), then rotated so the
      // next intentional submission is fresh.
      setPncCooldown(true);
      window.setTimeout(() => {
        setPncCooldown(false);
        pncIdemKeyRef.current = null;
      }, 2000);
      await reload();
    } catch (e) {
      pncIdemKeyRef.current = null;
      setPncError({ message: `Network error: ${(e as Error).message}` });
    } finally {
      setBusy(null);
    }
  };

  // Inline settlement badge for a processed PNC row. Clicking it opens the
  // full raw-response modal (data already cached from the batch fetch).
  const renderPncBadge = (paymentReference: string) => {
    const entry = pncStatuses[paymentReference];
    if (!entry) {
      return (
        <span className="text-xs px-1.5 py-0.5 rounded border bg-gray-50 text-gray-500 border-gray-200">
          {pncStatusesLoading ? "PNC: Checking…" : "PNC"}
        </span>
      );
    }
    return (
      <button
        type="button"
        aria-label={`${PNC_BADGE_LABELS[entry.settlement]} — view full PNC response`}
        title="View full PNC response"
        onClick={() => setPncStatusModal({ customerReference: paymentReference, data: entry.data })}
        className={`text-xs px-1.5 py-0.5 rounded border cursor-pointer hover:opacity-80 ${PNC_BADGE_STYLES[entry.settlement]}`}
      >
        {PNC_BADGE_LABELS[entry.settlement]}
      </button>
    );
  };

  const pncConfigured = systemStatus.pncConfigured ?? false;
  const selectedRows = rows.filter((r) => selected.has(r.id));
  const selTotal = selectedRows.reduce((a, r) => a + Number(r.netPay), 0);

  return (
    <div className="flex-1 overflow-auto p-6 max-w-[1400px] mx-auto w-full">
      <div className="flex items-center gap-3 mb-1">
        <Banknote className="w-7 h-7 brand-gold" />
        <h1 className="text-2xl font-semibold text-brand-navy">Pay Run</h1>
      </div>
      <p className="text-sm text-muted-foreground mb-6">
        Select payroll entries → preview → export an ACH/CSV file for your bank or send directly via PNC, then mark as paid once funds settle.
      </p>

      {toast && (
        <div className={`mb-4 px-4 py-3 rounded border ${toast.kind === "ok" ? "bg-green-50 border-green-300 text-green-900" : "bg-red-50 border-red-300 text-red-900"}`}>
          {toast.msg}
        </div>
      )}

      {/* PNC error alert — persists until dismissed */}
      {pncError && (
        <div className="mb-4 px-4 py-3 rounded border border-red-400 bg-red-50 text-red-900">
          <div className="flex items-start justify-between gap-3">
            <div className="flex-1">
              <div className="font-semibold flex items-center gap-2 mb-1">
                <AlertTriangle className="w-4 h-4" /> PNC submission failed
              </div>
              <div className="text-sm">{pncError.message}</div>
              {pncError.detail !== undefined && (
                <pre className="mt-2 text-xs bg-red-100 rounded p-2 overflow-x-auto whitespace-pre-wrap break-all">
                  {JSON.stringify(pncError.detail, null, 2)}
                </pre>
              )}
            </div>
            <button
              type="button"
              aria-label="Dismiss PNC error"
              onClick={() => setPncError(null)}
              className="shrink-0 opacity-60 hover:opacity-100"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
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
        <Button variant="outline" aria-label="Refresh" onClick={() => void reload()} disabled={loading}>
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

        {/* PNC button */}
        <div title={pncConfigured ? undefined : "PNC not configured — add API credentials in Settings"}>
          <Button
            className="bg-blue-700 text-white hover:bg-blue-800 disabled:opacity-50"
            onClick={sendViaPnc}
            disabled={selected.size === 0 || busy !== null || pncCooldown || !pncConfigured}
            aria-label="Send selected payroll entries via PNC Bank"
          >
            {busy === "pnc" ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Building2 className="w-4 h-4 mr-2" />}
            Send via PNC
          </Button>
        </div>

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
                <AlertTriangle className="w-4 h-4" /> Rows with warnings (excluded from CSV/PNC)
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
                            const isPncRow = r.status === "processed" && r.paidMethod === "pnc_api" && r.paymentReference;
                            return (
                              <div key={r.id} className={`p-3 space-y-2 ${hasWarn ? "bg-amber-50/40" : ""}`}>
                                <div className="flex items-start gap-3">
                                  <input type="checkbox" className="mt-1" aria-label={`Select payroll row for ${r.employeeName ?? r.employeeId.slice(0, 8)}`} checked={selected.has(r.id)} onChange={() => toggle(r.id)} />
                                  <div className="flex-1 min-w-0">
                                    <div className="flex items-start justify-between gap-2">
                                      <span className="font-medium">{r.employeeName ?? r.employeeId.slice(0, 8)}</span>
                                      <div className="flex items-center gap-1 shrink-0">
                                        <span className={`text-xs px-2 py-0.5 rounded ${
                                          r.status === "paid" ? "bg-green-100 text-green-800" :
                                          r.status === "processed" ? "bg-blue-100 text-blue-800" :
                                          "bg-gray-100 text-gray-700"
                                        }`}>{r.status}</span>
                                        {isPncRow && r.paymentReference && renderPncBadge(r.paymentReference)}
                                      </div>
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
                            const isPncRow = r.status === "processed" && r.paidMethod === "pnc_api" && r.paymentReference;
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
                                  <div className="flex items-center gap-1">
                                    <span className={`text-xs px-2 py-0.5 rounded ${
                                      r.status === "paid" ? "bg-green-100 text-green-800" :
                                      r.status === "processed" ? "bg-blue-100 text-blue-800" :
                                      "bg-gray-100 text-gray-700"
                                    }`}>{r.status}</span>
                                    {isPncRow && r.paymentReference && renderPncBadge(r.paymentReference)}
                                  </div>
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
        Workflow: <strong>pending</strong> → export CSV or send via PNC marks rows <strong>processed</strong> → after your bank confirms settlement, click <strong>Mark Paid</strong> with the bank reference number.
        Stripe Connect transfers are scaffolded behind the <code>STRIPE_CONNECT_ENABLED</code> environment flag.
        PNC direct deposit is enabled when <code>PNC_CLIENT_ID</code>, <code>PNC_CLIENT_SECRET</code>, <code>PNC_INSTRUCTOR_ACCOUNT_NUMBER</code>, and <code>PNC_INSTRUCTOR_ROUTING_NUMBER</code> are set.
      </p>

      {/* PNC Status modal */}
      {pncStatusModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
          role="dialog"
          aria-modal="true"
          aria-label="PNC Payment Status"
          onClick={() => setPncStatusModal(null)}
        >
          <div
            className="bg-white rounded-lg shadow-xl max-w-lg w-full mx-4 max-h-[80vh] overflow-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between p-4 border-b">
              <h2 className="font-semibold text-brand-navy">PNC Payment Status</h2>
              <button
                type="button"
                aria-label="Close PNC status modal"
                onClick={() => setPncStatusModal(null)}
                className="opacity-60 hover:opacity-100"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="p-4">
              <p className="text-xs text-muted-foreground mb-2">Customer reference: <code className="font-mono">{pncStatusModal.customerReference}</code></p>
              <pre className="text-xs bg-gray-50 rounded p-3 overflow-x-auto whitespace-pre-wrap break-all border">
                {JSON.stringify(pncStatusModal.data, null, 2)}
              </pre>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
