import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import {
  Receipt, Loader2, ChevronRight, ChevronDown, AlertTriangle,
  Lock, Pencil, RefreshCw, Send, CheckCircle2, FileText,
  Download, Mail, X, PlusCircle, Calendar, RotateCcw,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api, fetchWithAuth } from "@/lib/api";

type LineItem = {
  description: string;
  level?: number | null;
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
  processingFeeAmount: string | null;
  processingFeeRate: string | null;
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
  siteName: string | null;
  periodStart: string;
  periodEnd: string;
  email: string;
  lineItems: LineItem[] | null;
  subtotal: string | null;
  taxAmount: string | null;
  processingFeeAmount: string | null;
  processingFeeRate: string | null;
  totalAmount: string | null;
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
  // Default to the Monday of the current week so only current invoices load.
  // Admins can widen the range with the date pickers or quick-range buttons.
  const [from, setFrom] = useState(() => {
    const now = new Date();
    const dow = now.getUTCDay(); // 0=Sun … 6=Sat
    const monday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    monday.setUTCDate(monday.getUTCDate() - ((dow + 6) % 7));
    return monday.toISOString().slice(0, 10);
  });
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
  // Ids of pre-existing non-void invoices whose period overlaps the invoice
  // just created via the New Invoice dialog — possible double-billing.
  const [overlapWarningIds, setOverlapWarningIds] = useState<string[]>([]);
  // Approved hours the server could not price (no bill rate) on the last
  // generate — persistent banner, not a transient toast: this means the
  // draft under-bills and the admin must fix the site's rate + regenerate.
  const [unpricedWarningHours, setUnpricedWarningHours] = useState<number>(0);
  // Live pre-check inside the New Invoice dialog: existing non-void invoices
  // that already cover the chosen site + date range, surfaced BEFORE the
  // admin submits so they can cancel instead of voiding a duplicate.
  const [niOverlaps, setNiOverlaps] = useState<Array<{ id: string; invoiceNumber: string; periodStart: string; periodEnd: string; status: string }>>([]);
  const [niOverlapChecking, setNiOverlapChecking] = useState(false);

  const openNewInvoiceDialog = () => {
    setNiClientId("");
    setNiSiteId("");
    setNiPeriodStart("");
    setNiPeriodEnd("");
    setNiError("");
    setNiSubmitting(false);
    setNiOverlaps([]);
    setNiOverlapChecking(false);
    setShowNewInvoice(true);
  };

  const closeNewInvoiceDialog = () => {
    setShowNewInvoice(false);
    setNiError("");
    setNiOverlaps([]);
    setNiOverlapChecking(false);
  };

  // Pre-submission double-billing check: as soon as site + a valid date range
  // are chosen, ask the server for existing non-void invoices overlapping
  // that range. Debounced; stale responses are ignored via a cancel flag.
  useEffect(() => {
    if (!showNewInvoice) return;
    if (!niSiteId || !niPeriodStart || !niPeriodEnd || niPeriodEnd < niPeriodStart) {
      setNiOverlaps([]);
      setNiOverlapChecking(false);
      return;
    }
    let cancelled = false;
    // Clear previous results immediately so a stale warning from an earlier
    // site/range doesn't linger while the new check is in flight.
    setNiOverlaps([]);
    setNiOverlapChecking(true);
    const t = setTimeout(() => {
      void (async () => {
        try {
          const params = new URLSearchParams({
            siteId: niSiteId,
            overlapStart: niPeriodStart,
            overlapEnd: niPeriodEnd,
          });
          const found = await api<Array<{ id: string; invoiceNumber: string; periodStart: string; periodEnd: string; status: string }>>(
            `/invoices?${params}`,
          );
          if (!cancelled) setNiOverlaps(found);
        } catch {
          // Pre-check is advisory only — the post-create banner remains the backstop.
          if (!cancelled) setNiOverlaps([]);
        } finally {
          if (!cancelled) setNiOverlapChecking(false);
        }
      })();
    }, 350);
    return () => { cancelled = true; clearTimeout(t); };
  }, [showNewInvoice, niSiteId, niPeriodStart, niPeriodEnd]);

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
      const created = await api<InvoiceRow & { overlappingInvoiceIds?: string[]; unpricedHours?: number }>("/invoices/generate", {
        method: "POST",
        body: { siteId: niSiteId, periodStart: niPeriodStart, periodEnd: niPeriodEnd },
      });
      closeNewInvoiceDialog();
      setOverlapWarningIds(created.overlappingInvoiceIds ?? []);
      setUnpricedWarningHours(created.unpricedHours && created.unpricedHours > 0 ? created.unpricedHours : 0);
      if (!created.unpricedHours) {
        showToast("ok", "Draft invoice created successfully.");
      }
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

  const [recalcBusy, setRecalcBusy] = useState<Set<string>>(new Set());
  const recalculateFee = async (r: InvoiceRow) => {
    setRecalcBusy((s) => new Set(s).add(r.id));
    try {
      const updated = await api<InvoiceRow & { feeRecalculated: boolean; previousTotal: string | null }>(`/invoices/${r.id}/recalculate-fee`, { method: "POST" });
      const prevTotal = parseFloat(String(updated.previousTotal ?? "0")) || 0;
      const newTotal = parseFloat(String(updated.totalAmount ?? "0")) || 0;
      const feeAmt = parseFloat(String(updated.processingFeeAmount ?? "0")) || 0;
      if (feeAmt > 0) {
        showToast("ok", `Fee recalculated for ${r.invoiceNumber}: total updated from ${fmtUsd(prevTotal)} → ${fmtUsd(newTotal)}. Open the send dialog to resend the corrected invoice.`);
      } else {
        showToast("ok", `Fee recalculated for ${r.invoiceNumber}: no fee applies at current site settings (total unchanged).`);
      }
      await reload();
    } catch (e) {
      showToast("err", `Recalculate failed: ${(e as Error).message}`);
    } finally {
      setRecalcBusy((s) => { const n = new Set(s); n.delete(r.id); return n; });
    }
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

  // From the double-billing warning banner: expand the conflicting invoice's
  // period group and scroll its row into view.
  const jumpToInvoice = (id: string) => {
    const inv = rows.find((r) => r.id === id);
    if (!inv) return;
    setOpenWeeks((prev) => new Set(prev).add(`${inv.periodStart}::${inv.periodEnd}`));
    setTimeout(() => {
      document.getElementById(`invoice-row-${id}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 60);
  };

  const openSendDialog = (r: InvoiceRow) => {
    setSendTarget({
      id: r.id,
      invoiceNumber: r.invoiceNumber,
      clientName: r.clientName,
      siteName: r.siteName,
      periodStart: r.periodStart,
      periodEnd: r.periodEnd,
      email: r.clientEmail ?? "",
      lineItems: r.lineItems,
      subtotal: r.subtotal,
      taxAmount: r.taxAmount,
      processingFeeAmount: r.processingFeeAmount,
      processingFeeRate: r.processingFeeRate,
      totalAmount: r.totalAmount,
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

      {unpricedWarningHours > 0 && (
        <div className="mb-4 px-4 py-3 rounded border bg-red-50 border-red-300 text-red-900 flex items-start gap-3">
          <AlertTriangle className="w-5 h-5 shrink-0 mt-0.5" />
          <div className="flex-1">
            <div className="font-semibold">Draft created, but it under-bills</div>
            <div className="text-sm mt-0.5">
              {unpricedWarningHours} approved hour{unpricedWarningHours === 1 ? "" : "s"} in this period could not
              be billed because no bill rate applied — the entries have no shift bill rate and the site has no
              default bill rate. Set the site&apos;s default bill rate (Sites page), then regenerate this invoice
              and delete the short draft.
            </div>
          </div>
          <button
            type="button"
            onClick={() => setUnpricedWarningHours(0)}
            aria-label="Dismiss unbilled-hours warning"
            className="p-1 rounded hover:bg-red-100"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {overlapWarningIds.length > 0 && (
        <div className="mb-4 px-4 py-3 rounded border bg-amber-50 border-amber-300 text-amber-900 flex items-start gap-3">
          <AlertTriangle className="w-5 h-5 shrink-0 mt-0.5" />
          <div className="flex-1">
            <div className="font-semibold">Possible double-billing</div>
            <div className="text-sm mt-0.5">
              {overlapWarningIds.length === 1
                ? "1 existing invoice already covers"
                : `${overlapWarningIds.length} existing invoices already cover`}{" "}
              this site and overlapping dates. Review before sending — you may want to void one.
            </div>
            <div className="flex flex-wrap gap-2 mt-2">
              {overlapWarningIds.map((id) => {
                const inv = rows.find((r) => r.id === id);
                return (
                  <button
                    key={id}
                    type="button"
                    className="text-xs font-mono px-2 py-1 rounded border border-amber-400 bg-white hover:bg-amber-100 underline"
                    onClick={() => jumpToInvoice(id)}
                    title={inv ? `View invoice ${inv.invoiceNumber}` : "This invoice is hidden by the current filters — clear filters to see it"}
                  >
                    {inv ? `${inv.invoiceNumber} (${fmtDateRange(inv.periodStart, inv.periodEnd)})` : `Invoice ${id.slice(0, 8)}… (hidden by filters)`}
                  </button>
                );
              })}
            </div>
          </div>
          <button
            type="button"
            onClick={() => setOverlapWarningIds([])}
            aria-label="Dismiss double-billing warning"
            className="p-1 rounded hover:bg-amber-100"
          >
            <X className="w-4 h-4" />
          </button>
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
                        // Custom-period regeneration intentionally creates a NEW draft each
                        // time, superseding the earlier (possibly hand-edited) one — the
                        // newest draft is the one to send. Weekly split is different: a locked
                        // original plus a late-hours adjustment draft, both meant to ship.
                        let splitRole:
                          | "original" | "adjustment" | "current" | "superseded" | null = null;
                        if (isSplit) {
                          if (w.isCustomPeriod) {
                            const draftSiblings = siblings.filter((x) => x.status === "draft");
                            if (draftSiblings.length > 1 && r.status === "draft") {
                              const current = draftSiblings
                                .slice()
                                .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
                              splitRole = current.id === r.id ? "current" : "superseded";
                            }
                          } else {
                            const lockedSiblings = siblings.filter((x) => x.lockedAt);
                            const original = lockedSiblings.length > 0
                              ? lockedSiblings.sort((a, b) => (a.lockedAt ?? "").localeCompare(b.lockedAt ?? ""))[0]
                              : siblings.slice().sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
                            splitRole = original.id === r.id ? "original" : "adjustment";
                          }
                        }
                        return (
                          <Fragment key={r.id}>
                            <tr id={`invoice-row-${r.id}`} className={`border-t ${selectable ? "hover:bg-gray-50" : "bg-gray-50/60 opacity-70"}`}>
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
                                  {splitRole === "current" && (
                                    <span
                                      className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-900 border border-emerald-300 font-medium uppercase tracking-wider"
                                      title="Current draft: the most recently generated invoice for this site & period. This is the one to send — earlier drafts are superseded."
                                    >
                                      Current
                                    </span>
                                  )}
                                  {splitRole === "superseded" && (
                                    <span
                                      className="text-[10px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-900 border border-amber-300 font-medium uppercase tracking-wider"
                                      title="Superseded: a newer draft was generated for this same site & period. Don't send this one — void it or send the current draft instead."
                                    >
                                      Superseded
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
                              <td className="px-3 py-2 text-right font-semibold">
                                <span>{fmtUsd(num(r.totalAmount))}</span>
                                {r.processingFeeAmount === null && (r.status === "sent" || r.status === "overdue") && (
                                  <span
                                    className="ml-1.5 inline-flex items-center gap-0.5 text-[10px] px-1 py-0.5 rounded bg-amber-100 text-amber-800 border border-amber-300 font-medium"
                                    title="This invoice was generated before processing fees were configured. Click 'Recalculate fee' in the actions to update the total."
                                  >
                                    <AlertTriangle className="w-2.5 h-2.5" />
                                    no fee
                                  </span>
                                )}
                              </td>
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
                                  {/* Recalculate fee button — shown on sent/overdue invoices that
                                      have no processingFeeAmount (generated before toggle was on). */}
                                  {r.processingFeeAmount === null && (r.status === "sent" || r.status === "overdue") && (
                                    <button
                                      type="button"
                                      onClick={() => void recalculateFee(r)}
                                      disabled={recalcBusy.has(r.id)}
                                      className="inline-flex items-center justify-center w-7 h-7 rounded hover:bg-amber-100 text-amber-700 hover:text-amber-900 transition-colors disabled:opacity-40"
                                      title="Recalculate processing fee using current site settings, then resend the corrected invoice"
                                    >
                                      {recalcBusy.has(r.id)
                                        ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                        : <RotateCcw className="w-3.5 h-3.5" />}
                                    </button>
                                  )}
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
                                            <td className="px-2 py-1 text-right" colSpan={3}>Processing fee</td>
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

      {/* Send invoice — preview + confirm dialog */}
      {sendTarget && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4"
          onClick={(e) => { if (e.target === e.currentTarget) closeSendDialog(); }}
        >
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-2xl flex flex-col max-h-[90vh] overflow-hidden">
            {/* Header */}
            <div className="bg-brand-navy px-5 py-4 flex items-center justify-between shrink-0">
              <div className="flex items-center gap-2 text-white">
                <Mail className="w-4 h-4 text-brand-gold" />
                <span className="font-semibold text-sm">Review &amp; Send Invoice</span>
              </div>
              <button type="button" onClick={closeSendDialog} className="text-white/60 hover:text-white transition-colors">
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Scrollable body */}
            <div className="overflow-y-auto flex-1 px-5 py-5 space-y-5">

              {/* Invoice meta */}
              <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
                <div>
                  <span className="text-muted-foreground text-xs uppercase tracking-wide mr-1">Invoice</span>
                  <span className="font-mono font-semibold text-gray-800">{sendTarget.invoiceNumber}</span>
                </div>
                {sendTarget.clientName && (
                  <div>
                    <span className="text-muted-foreground text-xs uppercase tracking-wide mr-1">Client</span>
                    <span className="font-medium text-gray-800">{sendTarget.clientName}</span>
                  </div>
                )}
                {sendTarget.siteName && (
                  <div>
                    <span className="text-muted-foreground text-xs uppercase tracking-wide mr-1">Site</span>
                    <span className="text-gray-700">{sendTarget.siteName}</span>
                  </div>
                )}
                <div>
                  <span className="text-muted-foreground text-xs uppercase tracking-wide mr-1">Period</span>
                  <span className="text-gray-700">{fmtDateRange(sendTarget.periodStart, sendTarget.periodEnd)}</span>
                </div>
              </div>

              {/* Line items preview */}
              {sendTarget.lineItems && sendTarget.lineItems.length > 0 ? (
                <div className="border border-gray-200 rounded-lg overflow-hidden">
                  <table className="w-full text-xs">
                    <thead className="bg-gray-50 border-b border-gray-200">
                      <tr>
                        <th className="px-3 py-2 text-left text-[10px] uppercase tracking-wider text-muted-foreground">Officer</th>
                        <th className="px-3 py-2 text-center text-[10px] uppercase tracking-wider text-muted-foreground w-20">Level</th>
                        <th className="px-3 py-2 text-right text-[10px] uppercase tracking-wider text-muted-foreground w-16">Hours</th>
                        <th className="px-3 py-2 text-right text-[10px] uppercase tracking-wider text-muted-foreground w-20">Rate</th>
                        <th className="px-3 py-2 text-right text-[10px] uppercase tracking-wider text-muted-foreground w-24">Amount</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {sendTarget.lineItems.map((li, i) => {
                        const levelLabel = li.level != null
                          ? ({ 1: "Support Staff", 2: "Unarmed", 3: "Armed" } as Record<number, string>)[li.level] ?? `L${li.level}`
                          : "—";
                        return (
                          <tr key={i} className="hover:bg-gray-50/60">
                            <td className="px-3 py-2 text-gray-700">{li.description}</td>
                            <td className="px-3 py-2 text-center text-muted-foreground">{levelLabel}</td>
                            <td className="px-3 py-2 text-right text-gray-700">{li.hours != null ? li.hours.toFixed(2) : "—"}</td>
                            <td className="px-3 py-2 text-right text-gray-700">{li.rate != null ? fmtUsd(li.rate) : "—"}</td>
                            <td className="px-3 py-2 text-right font-medium text-gray-800">{fmtUsd(li.amount)}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                    <tfoot className="bg-gray-50 border-t border-gray-200">
                      <tr>
                        <td className="px-3 py-2 text-right text-xs text-muted-foreground" colSpan={4}>Subtotal</td>
                        <td className="px-3 py-2 text-right text-xs font-semibold text-gray-800">{fmtUsd(num(sendTarget.subtotal))}</td>
                      </tr>
                      {num(sendTarget.taxAmount) > 0 && (
                        <tr>
                          <td className="px-3 py-2 text-right text-xs text-muted-foreground" colSpan={4}>Processing fee</td>
                          <td className="px-3 py-2 text-right text-xs text-gray-700">{fmtUsd(num(sendTarget.taxAmount))}</td>
                        </tr>
                      )}
                      {num(sendTarget.processingFeeAmount) > 0 && (
                        <tr>
                          <td className="px-3 py-2 text-right text-xs text-muted-foreground" colSpan={4}>
                            Platform fee ({(parseFloat(String(sendTarget.processingFeeRate ?? "0")) || 0).toFixed(2)}%)
                          </td>
                          <td className="px-3 py-2 text-right text-xs text-gray-700">{fmtUsd(num(sendTarget.processingFeeAmount))}</td>
                        </tr>
                      )}
                      <tr className="border-t border-gray-300">
                        <td className="px-3 py-2 text-right text-xs font-bold text-brand-navy" colSpan={4}>Total Due</td>
                        <td className="px-3 py-2 text-right text-sm font-bold text-brand-navy">{fmtUsd(num(sendTarget.totalAmount))}</td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              ) : (
                <p className="text-xs text-muted-foreground italic">No line items on this invoice yet.</p>
              )}

              {/* Email field */}
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
                <p className="text-xs text-muted-foreground">
                  A branded PDF will be attached and the invoice will be marked <strong>sent</strong>.
                </p>
              </div>
            </div>

            {/* Footer actions — always visible */}
            <div className="shrink-0 flex justify-end gap-2 px-5 py-4 border-t border-gray-100 bg-gray-50/60">
              <Button variant="outline" size="sm" onClick={closeSendDialog}>Cancel</Button>
              <Button
                size="sm"
                className="bg-brand-navy text-white hover:bg-brand-navy/90"
                onClick={() => void confirmSend()}
                disabled={!sendEmailInput.trim()}
              >
                <Mail className="w-3.5 h-3.5 mr-1.5" />
                Confirm &amp; Send PDF
              </Button>
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

              {niSiteId && niPeriodStart && niPeriodEnd && niOverlaps.length > 0 && (
                <div className="text-xs text-amber-800 bg-amber-50 border border-amber-300 rounded px-3 py-2 space-y-1" role="alert">
                  <p className="font-semibold flex items-center gap-1.5">
                    <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                    {niOverlaps.length === 1
                      ? "An invoice already covers these dates"
                      : `${niOverlaps.length} invoices already cover these dates`}
                  </p>
                  <ul className="list-disc pl-4 space-y-0.5">
                    {niOverlaps.slice(0, 5).map((inv) => (
                      <li key={inv.id}>
                        {inv.invoiceNumber} · {inv.periodStart} → {inv.periodEnd} · {inv.status}
                      </li>
                    ))}
                    {niOverlaps.length > 5 && <li>…and {niOverlaps.length - 5} more</li>}
                  </ul>
                  <p>
                    Generating another draft may double-bill this client. You can still proceed if this is
                    an intentional adjustment.
                  </p>
                </div>
              )}
              {niOverlapChecking && niOverlaps.length === 0 && (
                <p className="text-xs text-muted-foreground flex items-center gap-1.5">
                  <Loader2 className="w-3 h-3 animate-spin" /> Checking for existing invoices…
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
