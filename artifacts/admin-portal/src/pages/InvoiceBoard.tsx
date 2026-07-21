import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import {
  Receipt, Loader2, ChevronRight, ChevronDown, AlertTriangle,
  Lock, Pencil, RefreshCw, Send, CheckCircle2, FileText,
  Download, Mail, X, PlusCircle, Calendar,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api, fetchWithAuth } from "@/lib/api";

type LineItem = {
  description: string;
  hours?: number;
  rate?: number;
  amount: number;
};

type InvoiceRow = {
  id: string;
  invoiceNumber: string;
  clientId: string | null;
  siteId: string | null;
  siteName: string | null;
  periodStart: string;
  periodEnd: string;
  clientName: string | null;
  clientEmail: string | null;
  lineItems: LineItem[] | null;
  subtotal: string | null;
  taxAmount: string | null;
  totalAmount: string | null;
  status: "draft" | "sent" | "paid" | "overdue" | "void" | string;
  dueDate: string | null;
  paidAt: string | null;
  autoSynced: boolean;
  lockedAt: string | null;
  createdAt: string;
};

type WeekGroup = {
  key: string;
  periodStart: string;
  periodEnd: string;
  isCustomPeriod: boolean;
  invoices: InvoiceRow[];
  totalAmount: number;
  invoiceCount: number;
};

type ClientOption = {
  id: string;
  name: string;
  billingCycle: string;
};

// Computed per-row state. Mirrors the lifecycle in invoiceSync.ts so the
// admin can see, at a glance, which invoices are still updating, which
// were hand-edited, which are frozen at week-end, and which have shipped.
type SyncState =
  | "auto-syncing"   // draft + auto_synced + !locked   — still folding in approvals
  | "manual-edit"   // draft + !auto_synced + !locked  — admin took control
  | "locked"         // draft + locked                  — week ended, frozen
  | "sent"           // status=sent
  | "paid"           // status=paid
  | "overdue"        // status=overdue
  | "void"
  | "other";

type StatusFilter = "active" | "draft" | "sent" | "paid" | "all";

const fmtUsd = (n: number) =>
  `$${Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const fmtDateRange = (periodStart: string, periodEnd: string) => {
  const opts: Intl.DateTimeFormatOptions = { weekday: "short", month: "short", day: "numeric" };
  const s = new Date(`${periodStart}T00:00:00`);
  const e = new Date(`${periodEnd}T00:00:00`);
  return `${s.toLocaleDateString("en-US", opts)} → ${e.toLocaleDateString("en-US", opts)}, ${e.getFullYear()}`;
};

const num = (s: string | null) => parseFloat(String(s ?? "0")) || 0;

/** True when this row is a custom (non-ISO-week) period. */
function isCustomPeriodRow(row: InvoiceRow): boolean {
  if (!row.periodStart || !row.periodEnd) return false;
  const startDate = new Date(`${row.periodStart}T00:00:00Z`);
  const endDate = new Date(`${row.periodEnd}T00:00:00Z`);
  const spanDays = Math.round((endDate.getTime() - startDate.getTime()) / 86_400_000);
  // Weekly = starts on a Monday AND spans exactly 6 days (Mon–Sun).
  return startDate.getUTCDay() !== 1 || spanDays !== 6;
}

const computeSyncState = (row: InvoiceRow): SyncState => {
  if (row.status === "paid") return "paid";
  if (row.status === "sent") return "sent";
  if (row.status === "overdue") return "overdue";
  if (row.status === "void") return "void";
  if (row.status === "draft") {
    if (row.lockedAt) return "locked";
    if (!row.autoSynced) return "manual-edit";
    return "auto-syncing";
  }
  return "other";
};

const stateLabel = (s: SyncState): { label: string; cls: string; Icon: typeof RefreshCw } => {
  switch (s) {
    case "auto-syncing":
      return { label: "Auto-syncing", cls: "bg-green-100 text-green-900", Icon: RefreshCw };
    case "manual-edit":
      return { label: "Manual edit", cls: "bg-amber-100 text-amber-900", Icon: Pencil };
    case "locked":
      return { label: "Locked (week ended)", cls: "bg-blue-100 text-blue-900", Icon: Lock };
    case "sent":
      return { label: "Sent", cls: "bg-indigo-100 text-indigo-900", Icon: Send };
    case "paid":
      return { label: "Paid", cls: "bg-emerald-100 text-emerald-900", Icon: CheckCircle2 };
    case "overdue":
      return { label: "Overdue", cls: "bg-red-100 text-red-900", Icon: AlertTriangle };
    case "void":
      return { label: "Void", cls: "bg-gray-200 text-gray-700", Icon: FileText };
    default:
      return { label: "Other", cls: "bg-gray-100 text-gray-700", Icon: FileText };
  }
};

// Selectable = not paid/void. Sent + draft can still be marked-paid; locked
// drafts can be marked-sent. Paid and void are terminal so we lock them out.
const isSelectable = (row: InvoiceRow) =>
  row.status !== "paid" && row.status !== "void";

type SendTarget = {
  id: string;
  invoiceNumber: string;
  clientName: string | null;
  email: string;
};

/** Compute a sensible default date range for the "+ New Invoice" dialog based on the client's billing cycle. */
function defaultPeriodForCycle(cycle: string): { start: string; end: string } {
  const now = new Date();
  const iso = (d: Date) => d.toISOString().slice(0, 10);

  if (cycle === "weekly" || cycle === "biweekly") {
    const dow = now.getUTCDay();
    const lastMon = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - ((dow + 6) % 7) - 7));
    const spanWeeks = cycle === "biweekly" ? 2 : 1;
    const rangeStart = new Date(lastMon);
    rangeStart.setUTCDate(lastMon.getUTCDate() - (spanWeeks - 1) * 7);
    const rangeEnd = new Date(lastMon);
    rangeEnd.setUTCDate(lastMon.getUTCDate() + 6);
    return { start: iso(rangeStart), end: iso(rangeEnd) };
  }

  if (cycle === "monthly") {
    const firstOfLastMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
    const lastOfLastMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0));
    return { start: iso(firstOfLastMonth), end: iso(lastOfLastMonth) };
  }

  if (cycle === "semi_monthly") {
    const d = now.getUTCDate();
    const m = now.getUTCMonth();
    const y = now.getUTCFullYear();
    if (d < 16) {
      // We're in the first half; last period = 16th–end of previous month.
      const prevY = m === 0 ? y - 1 : y;
      const prevM = m === 0 ? 11 : m - 1;
      const lastOfPrev = new Date(Date.UTC(y, m, 0));
      return {
        start: `${prevY}-${String(prevM + 1).padStart(2, "0")}-16`,
        end: iso(lastOfPrev),
      };
    } else {
      // We're in the second half; last period = 1st–15th of current month.
      const mm = String(m + 1).padStart(2, "0");
      return { start: `${y}-${mm}-01`, end: `${y}-${mm}-15` };
    }
  }

  // custom / fallback: last 30 days
  const end = new Date(now);
  const start = new Date(now);
  start.setUTCDate(start.getUTCDate() - 30);
  return { start: iso(start), end: iso(end) };
}

export default function InvoiceBoardPage() {
  const [rows, setRows] = useState<InvoiceRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("active");
  const [siteId, setSiteId] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [openWeeks, setOpenWeeks] = useState<Set<string>>(new Set());
  const [openInvoices, setOpenInvoices] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [rowBusy, setRowBusy] = useState<Set<string>>(new Set());
  const [toast, setToast] = useState<{ kind: "ok" | "err"; msg: string } | null>(null);
  const [sites, setSites] = useState<Array<{ id: string; name: string; clientId?: string | null }>>([]);
  const [clients, setClients] = useState<ClientOption[]>([]);
  const [sendTarget, setSendTarget] = useState<SendTarget | null>(null);
  const [sendEmailInput, setSendEmailInput] = useState("");
  const sendInputRef = useRef<HTMLInputElement>(null);

  // New Invoice dialog state
  const [showNewInvoice, setShowNewInvoice] = useState(false);
  const [niClientId, setNiClientId] = useState("");
  const [niSiteId, setNiSiteId] = useState("");
  const [niPeriodStart, setNiPeriodStart] = useState("");
  const [niPeriodEnd, setNiPeriodEnd] = useState("");
  const [niSubmitting, setNiSubmitting] = useState(false);
  const [niError, setNiError] = useState("");

  const openNewInvoiceDialog = () => {
    setNiClientId("");
    setNiSiteId("");
    setNiPeriodStart("");
    setNiPeriodEnd("");
    setNiError("");
    setNiSubmitting(false);
    setShowNewInvoice(true);
  };

  const closeNewInvoiceDialog = () => {
    setShowNewInvoice(false);
    setNiError("");
  };

  // When the client changes, auto-fill a sensible period and clear the site.
  const handleNiClientChange = (cid: string) => {
    setNiClientId(cid);
    setNiSiteId("");
    setNiError("");
    if (!cid) {
      setNiPeriodStart("");
      setNiPeriodEnd("");
      return;
    }
    const c = clients.find((x) => x.id === cid);
    const { start, end } = defaultPeriodForCycle(c?.billingCycle ?? "custom");
    setNiPeriodStart(start);
    setNiPeriodEnd(end);
  };

  const handleNiSubmit = async () => {
    if (!niClientId || !niSiteId || !niPeriodStart || !niPeriodEnd) {
      setNiError("All fields are required.");
      return;
    }
    if (niPeriodEnd < niPeriodStart) {
      setNiError("End date must be on or after the start date.");
      return;
    }
    setNiSubmitting(true);
    setNiError("");
    try {
      await api("/invoices/generate", {
        method: "POST",
        body: { siteId: niSiteId, periodStart: niPeriodStart, periodEnd: niPeriodEnd },
      });
      closeNewInvoiceDialog();
      showToast("ok", "Draft invoice created successfully.");
      await reload();
    } catch (e) {
      setNiError((e as Error).message || "Failed to generate invoice.");
    } finally {
      setNiSubmitting(false);
    }
  };

  // Sites in the new-invoice dialog — filtered to the selected client.
  const niSites = useMemo(
    () => (niClientId ? sites.filter((s) => s.clientId === niClientId) : []),
    [niClientId, sites],
  );

  useEffect(() => {
    void (async () => {
      try {
        const [siteList, clientList] = await Promise.all([
          api<Array<{ id: string; name: string; clientId?: string | null }>>("/sites"),
          api<ClientOption[]>("/clients"),
        ]);
        setSites(siteList);
        setClients(clientList);
      } catch { /* non-critical */ }
    })();
  }, []);

  const reload = async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (siteId) params.set("siteId", siteId);
      if (statusFilter === "draft" || statusFilter === "sent" || statusFilter === "paid") {
        params.set("status", statusFilter);
      }
      const data = await api<InvoiceRow[]>(`/invoices${params.toString() ? `?${params}` : ""}`);
      const filtered = data.filter((r) => {
        if (statusFilter === "active" && (r.status === "paid" || r.status === "void")) return false;
        if (from && r.periodStart < from) return false;
        if (to && r.periodStart > to) return false;
        return true;
      });
      setRows(filtered);
      setSelected(new Set());
      // Auto-expand if a small number of groups so admins see everything immediately.
      const keys = new Set(filtered.map((r) => `${r.periodStart}::${r.periodEnd}`));
      if (keys.size <= 4) setOpenWeeks(keys);
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

  const [pdfBusy, setPdfBusy] = useState<Set<string>>(new Set());
  const downloadPdf = async (id: string, invoiceNumber: string) => {
    setPdfBusy((s) => new Set(s).add(id));
    try {
      const res = await fetchWithAuth(`/api/invoices/${id}/pdf`);
      if (!res.ok) {
        showToast("err", `Could not download PDF for invoice ${invoiceNumber}.`);
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `invoice-${invoiceNumber}.pdf`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      showToast("err", `Could not download PDF: ${(e as Error).message}`);
    } finally {
      setPdfBusy((s) => { const n = new Set(s); n.delete(id); return n; });
    }
  };

  // Group invoices by compound key (periodStart::periodEnd) so custom-period
  // invoices with a different end date never collapse into an existing weekly group.
  const weeks = useMemo<WeekGroup[]>(() => {
    const byKey = new Map<string, InvoiceRow[]>();
    for (const r of rows) {
      const k = `${r.periodStart}::${r.periodEnd}`;
      const list = byKey.get(k) ?? [];
      list.push(r);
      byKey.set(k, list);
    }
    const groups: WeekGroup[] = [];
    for (const [key, invoices] of byKey.entries()) {
      invoices.sort((a, b) => {
        const s = (a.siteName ?? "").localeCompare(b.siteName ?? "");
        if (s !== 0) return s;
        return a.createdAt.localeCompare(b.createdAt);
      });
      const totalAmount = invoices.reduce((s, r) => s + num(r.totalAmount), 0);
      const custom = isCustomPeriodRow(invoices[0]);
      groups.push({
        key,
        periodStart: invoices[0].periodStart,
        periodEnd: invoices[0].periodEnd,
        isCustomPeriod: custom,
        invoices,
        totalAmount,
        invoiceCount: invoices.length,
      });
    }
    groups.sort((a, b) => b.periodStart.localeCompare(a.periodStart));
    return groups;
  }, [rows]);

  const allInvoices = useMemo(() => weeks.flatMap((w) => w.invoices), [weeks]);
  const selectedInvoices = useMemo(
    () => allInvoices.filter((r) => selected.has(r.id)),
    [allInvoices, selected],
  );
  const selTotal = selectedInvoices.reduce((s, r) => s + num(r.totalAmount), 0);

  const toggleRow = (r: InvoiceRow) => {
    if (!isSelectable(r)) return;
    const next = new Set(selected);
    if (next.has(r.id)) next.delete(r.id); else next.add(r.id);
    setSelected(next);
  };

  const toggleWeek = (w: WeekGroup) => {
    const ids = w.invoices.filter(isSelectable).map((r) => r.id);
    const all = ids.length > 0 && ids.every((id) => selected.has(id));
    const next = new Set(selected);
    if (all) ids.forEach((id) => next.delete(id));
    else ids.forEach((id) => next.add(id));
    setSelected(next);
  };

  const toggleWeekExpanded = (key: string) => {
    const next = new Set(openWeeks);
    if (next.has(key)) next.delete(key); else next.add(key);
    setOpenWeeks(next);
  };

  const toggleInvoiceExpanded = (id: string) => {
    const next = new Set(openInvoices);
    if (next.has(id)) next.delete(id); else next.add(id);
    setOpenInvoices(next);
  };

  const openSendDialog = (r: InvoiceRow) => {
    setSendTarget({
      id: r.id,
      invoiceNumber: r.invoiceNumber,
      clientName: r.clientName,
      email: r.clientEmail ?? "",
    });
    setSendEmailInput(r.clientEmail ?? "");
    setTimeout(() => sendInputRef.current?.focus(), 50);
  };

  const closeSendDialog = () => { setSendTarget(null); setSendEmailInput(""); };

  const sendInvoice = async (id: string, emailOverride?: string) => {
    setRowBusy((s) => new Set(s).add(id));
    try {
      const body: Record<string, string> = {};
      if (emailOverride?.trim()) body.email = emailOverride.trim();
      const r = await api<{
        emailSent: boolean;
        emailStatus: string;
        emailAddress: string | null;
        invoiceNumber: string;
        message?: string;
      }>(`/invoices/${id}/send`, { method: "POST", body });
      if (r.emailSent) {
        showToast("ok", `Invoice ${r.invoiceNumber} emailed to ${r.emailAddress} and marked sent.`);
      } else if (r.emailStatus === "no_recipient") {
        showToast("ok", `Invoice ${r.invoiceNumber} marked sent (no client email — PDF not sent).`);
      } else {
        showToast("err", `Invoice ${r.invoiceNumber} marked sent but email failed (${r.emailStatus}).`);
      }
      await reload();
    } catch (e) {
      showToast("err", `Send failed: ${(e as Error).message}`);
    } finally {
      setRowBusy((s) => { const n = new Set(s); n.delete(id); return n; });
    }
  };

  const confirmSend = async () => {
    if (!sendTarget) return;
    closeSendDialog();
    await sendInvoice(sendTarget.id, sendEmailInput || undefined);
  };

  const bulkSendToClients = async () => {
    if (selectedInvoices.length === 0) return;
    const todo = selectedInvoices.filter((r) => r.status !== "paid" && r.status !== "void");
    if (todo.length === 0) { showToast("err", "Nothing to send."); return; }
    setBusy(true);
    let emailed = 0, noEmail = 0, failed = 0;
    for (const inv of todo) {
      try {
        const r = await api<{ emailSent: boolean; emailStatus: string }>(
          `/invoices/${inv.id}/send`, { method: "POST", body: {} },
        );
        if (r.emailSent) emailed++;
        else if (r.emailStatus === "no_recipient") noEmail++;
        else failed++;
      } catch { failed++; }
    }
    setBusy(false);
    const parts = [];
    if (emailed > 0) parts.push(`${emailed} emailed`);
    if (noEmail > 0) parts.push(`${noEmail} marked sent (no email on file)`);
    if (failed > 0) parts.push(`${failed} failed`);
    showToast(failed > 0 ? "err" : "ok", parts.join(" · "));
    await reload();
  };

  const bulkSetStatus = async (status: "sent" | "paid") => {
    if (selectedInvoices.length === 0) return;
    const todo = selectedInvoices.filter((r) => {
      if (status === "sent") return r.status === "draft";
      if (status === "paid") return r.status === "draft" || r.status === "sent" || r.status === "overdue";
      return false;
    });
    if (todo.length === 0) {
      showToast("err", `Selected invoices are already ${status} or later.`);
      return;
    }
    setBusy(true);
    let ok = 0, fail = 0;
    for (const inv of todo) {
      try {
        await api(`/invoices/${inv.id}`, { method: "PUT", body: { status } });
        ok += 1;
      } catch {
        fail += 1;
      }
    }
    setBusy(false);
    const skipped = selectedInvoices.length - todo.length;
    const parts = [`${ok} marked ${status}`];
    if (fail > 0) parts.push(`${fail} failed`);
    if (skipped > 0) parts.push(`${skipped} already past that state`);
    showToast(fail > 0 ? "err" : "ok", parts.join(" · "));
    await reload();
  };

  return (
    <div className="flex-1 overflow-auto p-6 max-w-[1400px] mx-auto w-full">
      <div className="flex items-center gap-3 mb-1">
        <Receipt className="w-7 h-7 brand-gold" />
        <h1 className="text-2xl font-semibold text-brand-navy">Invoice Board</h1>
      </div>
      <p className="text-sm text-muted-foreground mb-6">
        Client invoices grouped by billing period. Weekly-cycle clients auto-populate as time entries are approved;
        non-weekly clients use the <strong>+ New Invoice</strong> button to generate custom-period drafts.
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
            <option value="active">Active (draft / sent / overdue)</option>
            <option value="draft">Draft only</option>
            <option value="sent">Sent only</option>
            <option value="paid">Paid only</option>
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
          <Label className="text-xs">Period from</Label>
          <Input type="date" className="h-9" value={from} onChange={(e) => setFrom(e.target.value)} />
        </div>
        <div>
          <Label className="text-xs">Period to</Label>
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
                  const utcDow = now.getUTCDay();
                  const monday = new Date(Date.UTC(
                    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(),
                  ));
                  monday.setUTCDate(monday.getUTCDate() - ((utcDow + 6) % 7));
                  const start = new Date(monday);
                  start.setUTCDate(monday.getUTCDate() + days);
                  const end = new Date(monday);
                  end.setUTCDate(monday.getUTCDate() + 6);
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
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => void reload()} disabled={loading}>
            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : "Refresh"}
          </Button>
          <Button
            className="bg-brand-gold text-brand-navy hover:bg-brand-gold/90"
            onClick={openNewInvoiceDialog}
          >
            <PlusCircle className="w-4 h-4 mr-2" />
            New Invoice
          </Button>
        </div>
      </div>

      {/* Sticky selection toolbar */}
      <div className="sticky top-0 z-10 flex flex-wrap items-center gap-3 mb-4 p-4 bg-brand-navy text-white rounded-lg shadow">
        <div className="flex-1 min-w-[200px]">
          <div className="text-xs uppercase tracking-wider opacity-70">Selected</div>
          <div className="text-xl font-semibold">
            {selectedInvoices.length} invoice{selectedInvoices.length === 1 ? "" : "s"}
            <span className="ml-4 brand-gold">· {fmtUsd(selTotal)} total</span>
          </div>
        </div>
        <Button
          variant="outline"
          className="bg-white/10 border-white/30 text-white hover:bg-white/20"
          onClick={() => void bulkSendToClients()}
          disabled={selectedInvoices.length === 0 || busy}
          title="Email PDF to each client and mark sent. Invoices without a stored client email are still marked sent."
        >
          {busy ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Mail className="w-4 h-4 mr-2" />}
          Email to clients
        </Button>
        <Button
          variant="outline"
          className="bg-white/10 border-white/30 text-white hover:bg-white/20"
          onClick={() => void bulkSetStatus("sent")}
          disabled={selectedInvoices.length === 0 || busy}
          title="Mark selected draft invoices as sent (status change only, no email)"
        >
          {busy ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Send className="w-4 h-4 mr-2" />}
          Mark sent
        </Button>
        <Button
          className="bg-brand-gold text-brand-navy hover:bg-brand-gold/90"
          onClick={() => void bulkSetStatus("paid")}
          disabled={selectedInvoices.length === 0 || busy}
          title="Mark selected invoices as paid (records paidAt timestamp)"
        >
          {busy ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <CheckCircle2 className="w-4 h-4 mr-2" />}
          Mark paid
        </Button>
      </div>

      {/* Period groups */}
      {loading ? (
        <div className="bg-white border rounded-lg p-12 text-center text-muted-foreground">
          <Loader2 className="w-6 h-6 animate-spin inline" />
        </div>
      ) : weeks.length === 0 ? (
        <div className="bg-white border rounded-lg p-12 text-center text-muted-foreground">
          No invoices match these filters. Weekly-cycle drafts appear automatically when time entries are approved
          for a site with a default bill rate. For other billing cycles, use <strong>+ New Invoice</strong>.
        </div>
      ) : (
        <div className="space-y-3">
          {weeks.map((w) => {
            const selectableIds = w.invoices.filter(isSelectable).map((r) => r.id);
            const allSelected = selectableIds.length > 0 && selectableIds.every((id) => selected.has(id));
            const someSelected = selectableIds.some((id) => selected.has(id));
            const expanded = openWeeks.has(w.key);
            return (
              <div key={w.key} className="bg-white border rounded-lg overflow-hidden">
                <div className={`flex items-center gap-3 px-4 py-3 text-white ${w.isCustomPeriod ? "bg-brand-navy/85" : "bg-brand-navy"}`}>
                  <input
                    type="checkbox"
                    checked={allSelected}
                    ref={(el) => { if (el) el.indeterminate = !allSelected && someSelected; }}
                    onChange={() => toggleWeek(w)}
                    className="w-4 h-4"
                    disabled={selectableIds.length === 0}
                    title={selectableIds.length === 0 ? "All invoices in this period are paid or void" : "Toggle all selectable invoices in this period"}
                  />
                  <button
                    type="button"
                    onClick={() => toggleWeekExpanded(w.key)}
                    className="flex items-center gap-2 flex-1 text-left"
                  >
                    {expanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                    <div>
                      <div className="font-semibold flex items-center gap-2">
                        {w.isCustomPeriod && (
                          <span className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded bg-brand-gold/20 text-brand-gold border border-brand-gold/30 font-medium uppercase tracking-wider">
                            <Calendar className="w-3 h-3" />
                            Custom Period
                          </span>
                        )}
                        {fmtDateRange(w.periodStart, w.periodEnd)}
                      </div>
                      <div className="text-xs opacity-70">
                        {w.invoiceCount} invoice{w.invoiceCount === 1 ? "" : "s"}
                      </div>
                    </div>
                  </button>
                  <div className="text-right">
                    <div className="text-xs uppercase tracking-wider opacity-70">Total billable</div>
                    <div className="brand-gold text-lg font-semibold">{fmtUsd(w.totalAmount)}</div>
                  </div>
                </div>

                {expanded && (
                  <div className="overflow-x-auto" tabIndex={0} role="region" aria-label="Invoice line items table">
                  <table className="w-full text-sm">
                    <thead className="text-left text-[10px] uppercase tracking-wider text-muted-foreground">
                      <tr>
                        <th className="px-3 py-1.5 w-8"></th>
                        <th className="px-3 py-1.5">Invoice #</th>
                        <th className="px-3 py-1.5">Site / Client</th>
                        <th className="px-3 py-1.5 text-right">Lines</th>
                        <th className="px-3 py-1.5 text-right">Subtotal</th>
                        <th className="px-3 py-1.5 text-right">Total</th>
                        <th className="px-3 py-1.5">Due</th>
                        <th className="px-3 py-1.5">State</th>
                        <th className="px-3 py-1.5 text-right">Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {w.invoices.map((r) => {
                        const sel = selected.has(r.id);
                        const selectable = isSelectable(r);
                        const state = computeSyncState(r);
                        const { label, cls, Icon: StIcon } = stateLabel(state);
                        const lineCount = r.lineItems?.length ?? 0;
                        const open = openInvoices.has(r.id);
                        const siblings = w.invoices.filter((x) => x.siteId === r.siteId && r.siteId !== null);
                        const isSplit = siblings.length > 1;
                        const lockedSiblings = siblings.filter((x) => x.lockedAt);
                        const original = lockedSiblings.length > 0
                          ? lockedSiblings.sort((a, b) => (a.lockedAt ?? "").localeCompare(b.lockedAt ?? ""))[0]
                          : siblings.slice().sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
                        const splitRole: "original" | "adjustment" | null = !isSplit
                          ? null
                          : original.id === r.id ? "original" : "adjustment";
                        return (
                          <Fragment key={r.id}>
                            <tr className={`border-t ${selectable ? "hover:bg-gray-50" : "bg-gray-50/60 opacity-70"}`}>
                              <td className="px-3 py-2">
                                <input
                                  type="checkbox"
                                  checked={sel}
                                  onChange={() => toggleRow(r)}
                                  disabled={!selectable}
                                  title={selectable ? undefined : `${r.status} — terminal state`}
                                />
                              </td>
                              <td className="px-3 py-2 font-mono text-xs">
                                <div className="flex items-center gap-2">
                                  <span>{r.invoiceNumber}</span>
                                  {splitRole === "original" && (
                                    <span
                                      className="text-[10px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-800 border border-gray-300"
                                      title="Original invoice for this site/period. Another invoice exists as an adjustment for late-approved hours."
                                    >
                                      orig
                                    </span>
                                  )}
                                  {splitRole === "adjustment" && (
                                    <span
                                      className="text-[10px] px-1.5 py-0.5 rounded bg-blue-50 text-blue-900 border border-blue-200"
                                      title="Adjustment draft: late-approved hours that arrived after the original invoice was locked. Send alongside the original."
                                    >
                                      adj
                                    </span>
                                  )}
                                </div>
                              </td>
                              <td className="px-3 py-2">
                                <div className="font-medium">{r.siteName ?? "(No site)"}</div>
                                <div className="text-xs text-muted-foreground">{r.clientName ?? "—"}</div>
                              </td>
                              <td className="px-3 py-2 text-right text-xs text-muted-foreground">
                                <button
                                  type="button"
                                  className="inline-flex items-center gap-1 hover:underline"
                                  onClick={() => toggleInvoiceExpanded(r.id)}
                                  title="Show invoice line items"
                                >
                                  {open ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                                  {lineCount} line{lineCount === 1 ? "" : "s"}
                                </button>
                              </td>
                              <td className="px-3 py-2 text-right">{fmtUsd(num(r.subtotal))}</td>
                              <td className="px-3 py-2 text-right font-semibold">{fmtUsd(num(r.totalAmount))}</td>
                              <td className="px-3 py-2 text-xs">
                                {r.dueDate
                                  ? new Date(`${r.dueDate}T00:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
                                  : "—"}
                              </td>
                              <td className="px-3 py-2">
                                <span className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded ${cls}`}>
                                  <StIcon className="w-3 h-3" />
                                  {label}
                                </span>
                              </td>
                              <td className="px-3 py-2">
                                <div className="flex items-center justify-end gap-1">
                                  <button
                                    type="button"
                                    onClick={() => downloadPdf(r.id, r.invoiceNumber)}
                                    disabled={pdfBusy.has(r.id)}
                                    className="inline-flex items-center justify-center w-7 h-7 rounded hover:bg-gray-100 text-muted-foreground hover:text-brand-navy transition-colors disabled:opacity-40"
                                    title={`Download PDF — Invoice ${r.invoiceNumber}`}
                                  >
                                    {pdfBusy.has(r.id)
                                      ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                      : <Download className="w-3.5 h-3.5" />}
                                  </button>
                                  {r.status !== "paid" && r.status !== "void" && (
                                    <button
                                      type="button"
                                      onClick={() => openSendDialog(r)}
                                      disabled={rowBusy.has(r.id)}
                                      className="inline-flex items-center justify-center w-7 h-7 rounded hover:bg-gray-100 text-muted-foreground hover:text-brand-navy transition-colors disabled:opacity-40"
                                      title={r.clientEmail ? `Email to ${r.clientEmail}` : "Send — no client email on file (you can enter one)"}
                                    >
                                      {rowBusy.has(r.id)
                                        ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                        : <Mail className="w-3.5 h-3.5" />}
                                    </button>
                                  )}
                                </div>
                              </td>
                            </tr>
                            {open && (
                              <tr className="bg-gray-50/40">
                                <td colSpan={9} className="px-3 py-2">
                                  {lineCount === 0 ? (
                                    <div className="text-xs text-muted-foreground italic px-2 py-1">
                                      No line items yet. They populate as approved time entries roll in.
                                    </div>
                                  ) : (
                                    <table className="w-full text-xs">
                                      <thead className="text-[10px] uppercase tracking-wider text-muted-foreground">
                                        <tr>
                                          <th className="px-2 py-1 text-left">Description</th>
                                          <th className="px-2 py-1 text-right">Hours</th>
                                          <th className="px-2 py-1 text-right">Rate</th>
                                          <th className="px-2 py-1 text-right">Amount</th>
                                        </tr>
                                      </thead>
                                      <tbody>
                                        {r.lineItems!.map((li, i) => (
                                          <tr key={i} className="border-t border-gray-200">
                                            <td className="px-2 py-1">{li.description}</td>
                                            <td className="px-2 py-1 text-right">{li.hours != null ? li.hours.toFixed(2) : "—"}</td>
                                            <td className="px-2 py-1 text-right">{li.rate != null ? fmtUsd(li.rate) : "—"}</td>
                                            <td className="px-2 py-1 text-right font-medium">{fmtUsd(li.amount)}</td>
                                          </tr>
                                        ))}
                                      </tbody>
                                      <tfoot>
                                        <tr className="border-t border-gray-300 bg-gray-100/60">
                                          <td className="px-2 py-1 text-right font-medium" colSpan={3}>Subtotal</td>
                                          <td className="px-2 py-1 text-right font-semibold">{fmtUsd(num(r.subtotal))}</td>
                                        </tr>
                                        {num(r.taxAmount) > 0 && (
                                          <tr className="bg-gray-100/60">
                                            <td className="px-2 py-1 text-right" colSpan={3}>Tax</td>
                                            <td className="px-2 py-1 text-right">{fmtUsd(num(r.taxAmount))}</td>
                                          </tr>
                                        )}
                                        <tr className="bg-gray-100/60">
                                          <td className="px-2 py-1 text-right font-medium" colSpan={3}>Total</td>
                                          <td className="px-2 py-1 text-right font-bold brand-navy">{fmtUsd(num(r.totalAmount))}</td>
                                        </tr>
                                      </tfoot>
                                    </table>
                                  )}
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

      {/* Send email confirmation dialog */}
      {sendTarget && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm"
          onClick={(e) => { if (e.target === e.currentTarget) closeSendDialog(); }}
        >
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-md mx-4 overflow-hidden">
            <div className="bg-brand-navy px-5 py-4 flex items-center justify-between">
              <div className="flex items-center gap-2 text-white">
                <Mail className="w-4 h-4 text-brand-gold" />
                <span className="font-semibold text-sm">Send Invoice</span>
              </div>
              <button type="button" onClick={closeSendDialog} className="text-white/60 hover:text-white">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="px-5 py-5 space-y-4">
              <div>
                <p className="text-sm text-gray-600">
                  Invoice <span className="font-mono font-semibold text-gray-800">{sendTarget.invoiceNumber}</span>
                  {sendTarget.clientName ? <> for <span className="font-medium text-gray-800">{sendTarget.clientName}</span></> : ""}.
                </p>
                <p className="text-xs text-muted-foreground mt-1">
                  A branded PDF will be emailed as an attachment and the invoice will be marked <strong>sent</strong>.
                  {!sendTarget.email && (
                    <> No client email is stored on this invoice — enter one below.</>
                  )}
                </p>
              </div>
              <div className="space-y-1">
                <Label htmlFor="send-email-input" className="text-xs font-medium">
                  Recipient email {!sendTarget.email && <span className="text-red-500">*</span>}
                </Label>
                <Input
                  id="send-email-input"
                  ref={sendInputRef}
                  type="email"
                  placeholder="client@example.com"
                  value={sendEmailInput}
                  onChange={(e) => setSendEmailInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter" && sendEmailInput.trim()) void confirmSend(); }}
                  className="h-9 text-sm"
                />
                {!sendTarget.email && sendEmailInput.trim() && (
                  <p className="text-xs text-blue-600">This email will be saved to the invoice.</p>
                )}
              </div>
              <div className="flex justify-end gap-2 pt-1">
                <Button variant="outline" size="sm" onClick={closeSendDialog}>Cancel</Button>
                <Button
                  size="sm"
                  className="bg-brand-navy text-white hover:bg-brand-navy/90"
                  onClick={() => void confirmSend()}
                  disabled={!sendEmailInput.trim()}
                >
                  <Mail className="w-3.5 h-3.5 mr-1.5" />
                  Send PDF
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* New Invoice dialog */}
      {showNewInvoice && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm"
          onClick={(e) => { if (e.target === e.currentTarget) closeNewInvoiceDialog(); }}
        >
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-lg mx-4 overflow-hidden">
            <div className="bg-brand-navy px-5 py-4 flex items-center justify-between">
              <div className="flex items-center gap-2 text-white">
                <PlusCircle className="w-4 h-4 text-brand-gold" />
                <span className="font-semibold text-sm">New Invoice</span>
              </div>
              <button type="button" onClick={closeNewInvoiceDialog} className="text-white/60 hover:text-white">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="px-5 py-5 space-y-4">
              <p className="text-xs text-muted-foreground">
                Generate a draft invoice from approved time entries for any date range. The line items are
                built using the same logic as auto-synced weekly invoices.
              </p>

              {/* Client */}
              <div className="space-y-1">
                <Label className="text-xs font-medium">Client <span className="text-red-500">*</span></Label>
                <select
                  className="w-full border rounded h-9 px-2 text-sm"
                  value={niClientId}
                  onChange={(e) => handleNiClientChange(e.target.value)}
                >
                  <option value="">Select client…</option>
                  {clients.map((c) => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </select>
              </div>

              {/* Site */}
              <div className="space-y-1">
                <Label className="text-xs font-medium">Site <span className="text-red-500">*</span></Label>
                <select
                  className="w-full border rounded h-9 px-2 text-sm"
                  value={niSiteId}
                  onChange={(e) => { setNiSiteId(e.target.value); setNiError(""); }}
                  disabled={!niClientId}
                >
                  <option value="">
                    {niClientId
                      ? (niSites.length === 0 ? "No sites for this client" : "Select site…")
                      : "Select a client first"}
                  </option>
                  {niSites.map((s) => (
                    <option key={s.id} value={s.id}>{s.name}</option>
                  ))}
                </select>
              </div>

              {/* Period dates */}
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label className="text-xs font-medium">Period start <span className="text-red-500">*</span></Label>
                  <Input
                    type="date"
                    className="h-9 text-sm"
                    value={niPeriodStart}
                    onChange={(e) => { setNiPeriodStart(e.target.value); setNiError(""); }}
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs font-medium">Period end <span className="text-red-500">*</span></Label>
                  <Input
                    type="date"
                    className="h-9 text-sm"
                    value={niPeriodEnd}
                    min={niPeriodStart || undefined}
                    onChange={(e) => { setNiPeriodEnd(e.target.value); setNiError(""); }}
                  />
                </div>
              </div>

              {niClientId && clients.find((c) => c.id === niClientId)?.billingCycle !== "weekly" && (
                <p className="text-xs text-blue-700 bg-blue-50 border border-blue-200 rounded px-3 py-2">
                  This client uses a <strong>{clients.find((c) => c.id === niClientId)?.billingCycle?.replace(/_/g, "-")}</strong> billing
                  cycle. The date range above was pre-filled based on their cycle — adjust as needed.
                </p>
              )}

              {niError && (
                <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded px-3 py-2">
                  {niError}
                </p>
              )}

              <div className="flex justify-end gap-2 pt-1">
                <Button variant="outline" size="sm" onClick={closeNewInvoiceDialog} disabled={niSubmitting}>
                  Cancel
                </Button>
                <Button
                  size="sm"
                  className="bg-brand-navy text-white hover:bg-brand-navy/90"
                  onClick={() => void handleNiSubmit()}
                  disabled={niSubmitting || !niClientId || !niSiteId || !niPeriodStart || !niPeriodEnd}
                >
                  {niSubmitting ? <Loader2 className="w-3.5 h-3.5 animate-spin mr-1.5" /> : <PlusCircle className="w-3.5 h-3.5 mr-1.5" />}
                  Generate draft
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
