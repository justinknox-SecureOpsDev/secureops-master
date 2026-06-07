import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import {
  Receipt, Loader2, ChevronRight, ChevronDown, AlertTriangle,
  Lock, Pencil, RefreshCw, Send, CheckCircle2, FileText,
  Download, Mail, X,
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
  periodStart: string; // YYYY-MM-DD (Monday UTC)
  periodEnd: string;   // YYYY-MM-DD (Sunday UTC)
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
  periodStart: string;
  periodEnd: string;
  invoices: InvoiceRow[];
  totalAmount: number;
  invoiceCount: number;
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

const fmtWeekRange = (periodStart: string, periodEnd: string) => {
  const opts: Intl.DateTimeFormatOptions = { weekday: "short", month: "short", day: "numeric" };
  const s = new Date(`${periodStart}T00:00:00`);
  const e = new Date(`${periodEnd}T00:00:00`);
  return `${s.toLocaleDateString("en-US", opts)} → ${e.toLocaleDateString("en-US", opts)}, ${e.getFullYear()}`;
};

const num = (s: string | null) => parseFloat(String(s ?? "0")) || 0;

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
  const [sites, setSites] = useState<Array<{ id: string; name: string }>>([]);
  const [sendTarget, setSendTarget] = useState<SendTarget | null>(null);
  const [sendEmailInput, setSendEmailInput] = useState("");
  const sendInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void (async () => {
      try {
        const list = await api<Array<{ id: string; name: string }>>("/sites");
        setSites(list);
      } catch { /* non-critical */ }
    })();
  }, []);

  const reload = async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (siteId) params.set("siteId", siteId);
      // status filter is applied server-side only when it maps 1:1 to the
      // DB column; "active" is a UI-level grouping (draft|sent|overdue).
      if (statusFilter === "draft" || statusFilter === "sent" || statusFilter === "paid") {
        params.set("status", statusFilter);
      }
      const data = await api<InvoiceRow[]>(`/invoices${params.toString() ? `?${params}` : ""}`);
      // Apply date range + "active" filter client-side so toggling is fast.
      const filtered = data.filter((r) => {
        if (statusFilter === "active" && (r.status === "paid" || r.status === "void")) return false;
        if (from && r.periodStart < from) return false;
        if (to && r.periodStart > to) return false;
        return true;
      });
      setRows(filtered);
      setSelected(new Set());
      // Auto-expand if a small number of weeks so admins see everything immediately.
      const weeks = new Set(filtered.map((r) => r.periodStart));
      if (weeks.size <= 4) setOpenWeeks(weeks);
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

  // Invoice PDF download. The admin portal authenticates with a bearer token
  // (not a cookie), so a plain <a href="/api/.../pdf"> opens an unauthenticated
  // request and the server replies 401 "No token provided". We fetch the PDF
  // with the token attached, then trigger a client-side blob download.
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

  // Group invoices by ISO week (periodStart). Newest week first.
  const weeks = useMemo<WeekGroup[]>(() => {
    const byWeek = new Map<string, InvoiceRow[]>();
    for (const r of rows) {
      const list = byWeek.get(r.periodStart) ?? [];
      list.push(r);
      byWeek.set(r.periodStart, list);
    }
    const groups: WeekGroup[] = [];
    for (const [periodStart, invoices] of byWeek.entries()) {
      // Sort invoices within a week by site, then by createdAt (older first).
      invoices.sort((a, b) => {
        const s = (a.siteName ?? "").localeCompare(b.siteName ?? "");
        if (s !== 0) return s;
        return a.createdAt.localeCompare(b.createdAt);
      });
      const totalAmount = invoices.reduce((s, r) => s + num(r.totalAmount), 0);
      groups.push({
        periodStart,
        periodEnd: invoices[0].periodEnd,
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

  const toggleWeekExpanded = (periodStart: string) => {
    const next = new Set(openWeeks);
    if (next.has(periodStart)) next.delete(periodStart); else next.add(periodStart);
    setOpenWeeks(next);
  };

  const toggleInvoiceExpanded = (id: string) => {
    const next = new Set(openInvoices);
    if (next.has(id)) next.delete(id); else next.add(id);
    setOpenInvoices(next);
  };

  // Open send dialog. If the invoice already has a clientEmail pre-fill it.
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

  // Send a single invoice. Optionally pass an email override.
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

  // Bulk send: email all selected that have a clientEmail, mark all sent.
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

  // Bulk status transition. Iterates selected rows and PUTs new status.
  // Server-side, PUT /invoices/:id with status !== 'draft' also flips
  // auto_synced=false so the row stops resyncing once admin sends/pays it.
  const bulkSetStatus = async (status: "sent" | "paid") => {
    if (selectedInvoices.length === 0) return;
    // Don't try to send/pay invoices that are already past that state.
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
        Client invoices grouped by site and week. Drafts auto-populate as time entries are approved.
        At week-end each draft is locked and ready to send; late-approved hours roll into an adjustment draft.
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
          <Label className="text-xs">Week from</Label>
          <Input type="date" className="h-9" value={from} onChange={(e) => setFrom(e.target.value)} />
        </div>
        <div>
          <Label className="text-xs">Week to</Label>
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
                  // periodStart is stored as a UTC ISO date, so anchor the
                  // "Monday of this week" calculation in UTC to avoid an
                  // off-by-one day for admins whose local clock is on the
                  // other side of midnight UTC.
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
        <Button variant="outline" onClick={() => void reload()} disabled={loading}>
          {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : "Refresh"}
        </Button>
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

      {/* Week groups */}
      {loading ? (
        <div className="bg-white border rounded-lg p-12 text-center text-muted-foreground">
          <Loader2 className="w-6 h-6 animate-spin inline" />
        </div>
      ) : weeks.length === 0 ? (
        <div className="bg-white border rounded-lg p-12 text-center text-muted-foreground">
          No invoices match these filters. Drafts appear here automatically when time entries are approved
          for a site with a default bill rate set.
        </div>
      ) : (
        <div className="space-y-3">
          {weeks.map((w) => {
            const selectableIds = w.invoices.filter(isSelectable).map((r) => r.id);
            const allSelected = selectableIds.length > 0 && selectableIds.every((id) => selected.has(id));
            const someSelected = selectableIds.some((id) => selected.has(id));
            const expanded = openWeeks.has(w.periodStart);
            return (
              <div key={w.periodStart} className="bg-white border rounded-lg overflow-hidden">
                <div className="flex items-center gap-3 px-4 py-3 bg-brand-navy text-white">
                  <input
                    type="checkbox"
                    checked={allSelected}
                    ref={(el) => { if (el) el.indeterminate = !allSelected && someSelected; }}
                    onChange={() => toggleWeek(w)}
                    className="w-4 h-4"
                    disabled={selectableIds.length === 0}
                    title={selectableIds.length === 0 ? "All invoices in this week are paid or void" : "Toggle all selectable invoices in this week"}
                  />
                  <button
                    type="button"
                    onClick={() => toggleWeekExpanded(w.periodStart)}
                    className="flex items-center gap-2 flex-1 text-left"
                  >
                    {expanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                    <div>
                      <div className="font-semibold">{fmtWeekRange(w.periodStart, w.periodEnd)}</div>
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
                        // When a week has >1 invoice for the same site, one is
                        // the original (locked at week-end) and the other(s)
                        // are adjustment drafts created by late-approved hours.
                        // Distinguish them so admins know which row is still
                        // accumulating vs. which has shipped to the client.
                        const siblings = w.invoices.filter((x) => x.siteId === r.siteId && r.siteId !== null);
                        const isSplit = siblings.length > 1;
                        // The "original" is whichever sibling locked first (or
                        // failing that, the oldest createdAt). Everything else
                        // in the group is an adjustment.
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
                                      title="Original invoice for this site/week. Another invoice exists as an adjustment for late-approved hours."
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
    </div>
  );
}
