import { useEffect, useMemo, useState } from "react";
import { Banknote, Download, CheckCircle2, AlertTriangle, Loader2, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { fetchWithAuth } from "@/lib/api";

type InvoiceRow = {
  id: string;
  subcontractorId: string;
  companyName: string | null;
  invoiceNumber: string;
  description: string | null;
  issueDate: string | null;
  dueDate: string | null;
  totalAmount: string;
  status: string;
  paidAt: string | null;
};

type PreviewRow = InvoiceRow & {
  paidMethod: string | null;
  paymentReference: string | null;
  bankAccountName: string | null;
  bankAccountNumber: string | null;
  bankRoutingNumber: string | null;
  directDepositConsent: boolean | null;
  warnings: string[];
};

type Preview = {
  rows: PreviewRow[];
  counts: { total: number; payable: number; withWarnings: number; alreadyPaid: number };
  totals: { total: number };
};

const fmtUsd = (n: number | string) =>
  `$${Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const maskAccount = (s: string | null) => (s ? `••••${s.slice(-4)}` : "—");

const fmtDate = (d: string | null) => (d ? new Date(`${d}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }) : "—");

type VendorGroup = {
  subcontractorId: string;
  companyName: string;
  rows: InvoiceRow[];
  total: number;
};

const groupByVendor = (rows: InvoiceRow[]): VendorGroup[] => {
  const vendors = new Map<string, VendorGroup>();
  for (const r of rows) {
    const key = r.subcontractorId;
    let g = vendors.get(key);
    if (!g) {
      g = { subcontractorId: r.subcontractorId, companyName: r.companyName ?? "(Unknown vendor)", rows: [], total: 0 };
      vendors.set(key, g);
    }
    g.rows.push(r);
    g.total += Number(r.totalAmount);
  }
  return Array.from(vendors.values()).sort((a, b) => a.companyName.localeCompare(b.companyName));
};

export default function SubcontractorPayRunPage() {
  const [rows, setRows] = useState<InvoiceRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<"approved" | "processed" | "all">("approved");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [toast, setToast] = useState<{ kind: "ok" | "err"; msg: string } | null>(null);
  const [paidRef, setPaidRef] = useState("");

  const authHeaders = useMemo(
    () => ({ "Content-Type": "application/json" }),
    [],
  );

  const reload = async () => {
    setLoading(true);
    try {
      // The generic admin grid endpoint returns the full invoice list; we
      // filter client-side by status so the page stays self-contained (no new
      // list endpoint needed — payments use the dedicated pay-run endpoints).
      const res = await fetchWithAuth(`/api/admin/tables/subcontractor_invoices?limit=500&offset=0`, { headers: authHeaders });
      const data = await res.json();
      const list: InvoiceRow[] = Array.isArray(data?.rows) ? data.rows : Array.isArray(data) ? data : [];
      const filtered = statusFilter === "all" ? list : list.filter((r) => r.status === statusFilter);
      setRows(filtered);
      setSelected((prev) => {
        const ids = new Set(filtered.map((r) => r.id));
        return new Set(Array.from(prev).filter((id) => ids.has(id)));
      });
      setPreview(null);
    } catch (e) {
      showToast("err", `Load failed: ${(e as Error).message}`);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void reload(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [statusFilter]);

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
      const res = await fetchWithAuth("/api/subcontractor-pay-run/preview", {
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
      const res = await fetchWithAuth("/api/subcontractor-pay-run/export-csv", {
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
      a.download = `wcsg-subcontractor-${batch}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      showToast("ok", `Exported ${count} invoice(s) (${skipped} skipped). Batch ${batch}. Status set to "processed".`);
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
      const res = await fetchWithAuth("/api/subcontractor-pay-run/mark-paid", {
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
      const res = await fetchWithAuth("/api/subcontractor-pay-run/stripe", {
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
  const selTotal = selectedRows.reduce((a, r) => a + Number(r.totalAmount), 0);

  return (
    <div className="flex-1 overflow-auto p-6 max-w-[1400px] mx-auto w-full">
      <div className="flex items-center gap-3 mb-1">
        <Banknote className="w-7 h-7 brand-gold" />
        <h1 className="text-2xl font-semibold text-brand-navy">Subcontractor Pay Run</h1>
      </div>
      <p className="text-sm text-muted-foreground mb-6">
        Select <strong>approved</strong> subcontractor invoices → preview → export an ACH/CSV file for your bank, then mark as paid once funds settle. Approve invoices first from the Invoices grid.
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
            onChange={(e) => setStatusFilter(e.target.value as typeof statusFilter)}
          >
            <option value="approved">Approved (ready to pay)</option>
            <option value="processed">Processed (CSV exported)</option>
            <option value="all">All</option>
          </select>
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
          className="bg-brand-gold text-brand-navy hover:bg-brand-gold/90"
          onClick={exportCsv}
          disabled={selected.size === 0 || busy !== null}
        >
          {busy === "csv" ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Download className="w-4 h-4 mr-2" />}
          Export ACH CSV
        </Button>
        <div className="flex gap-2 items-center">
          <Input
            placeholder="Bank ref. (optional)"
            className="h-9 w-44 text-brand-navy"
            value={paidRef}
            onChange={(e) => setPaidRef(e.target.value)}
          />
          <Button variant="outline" className="text-brand-navy" onClick={markPaid} disabled={selected.size === 0 || busy !== null}>
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
            <div><span className="text-muted-foreground">Total invoices:</span> <strong>{preview.counts.total}</strong></div>
            <div><span className="text-muted-foreground">Payable now:</span> <strong className="text-green-700">{preview.counts.payable}</strong></div>
            <div><span className="text-muted-foreground">With warnings:</span> <strong className="text-amber-700">{preview.counts.withWarnings}</strong></div>
            <div><span className="text-muted-foreground">Already paid:</span> <strong>{preview.counts.alreadyPaid}</strong></div>
            <div><span className="text-muted-foreground">Total (to pay):</span> <strong className="brand-gold">{fmtUsd(preview.totals.total)}</strong></div>
          </div>
          {preview.rows.some((r) => r.warnings.length > 0) && (
            <div className="text-sm">
              <div className="font-medium text-amber-800 flex items-center gap-1 mb-1">
                <AlertTriangle className="w-4 h-4" /> Invoices with warnings (excluded from CSV)
              </div>
              <ul className="text-xs space-y-0.5">
                {preview.rows.filter((r) => r.warnings.length > 0).map((r) => (
                  <li key={r.id}>
                    <strong>{r.companyName} · {r.invoiceNumber}</strong> — {r.warnings.join("; ")}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {/* Grouped by vendor */}
      {loading ? (
        <div className="bg-white border rounded-lg p-12 text-center text-muted-foreground">
          <Loader2 className="w-6 h-6 animate-spin inline" />
        </div>
      ) : rows.length === 0 ? (
        <div className="bg-white border rounded-lg p-12 text-center text-muted-foreground">
          No subcontractor invoices match these filters.
        </div>
      ) : (
        <div className="space-y-4">
          {groupByVendor(rows).map((vendor) => {
            const vendorIds = vendor.rows.map((r) => r.id);
            const allSel = vendorIds.every((id) => selected.has(id));
            const someSel = vendorIds.some((id) => selected.has(id));
            return (
              <div key={vendor.subcontractorId} className="bg-white border rounded-lg overflow-hidden">
                <div className="flex items-center gap-3 px-4 py-3 bg-brand-navy text-white">
                  <input
                    type="checkbox"
                    checked={allSel}
                    ref={(el) => { if (el) el.indeterminate = !allSel && someSel; }}
                    onChange={() => toggleMany(vendorIds)}
                    className="w-4 h-4"
                  />
                  <div className="flex-1">
                    <div className="font-semibold text-base">{vendor.companyName}</div>
                    <div className="text-xs opacity-70">
                      {vendor.rows.length} invoice{vendor.rows.length === 1 ? "" : "s"}
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="text-xs uppercase tracking-wider opacity-70">Vendor total</div>
                    <div className="brand-gold text-lg font-semibold">{fmtUsd(vendor.total)}</div>
                  </div>
                </div>
                <table className="w-full text-sm">
                  <thead className="text-left text-[10px] uppercase tracking-wider text-muted-foreground">
                    <tr>
                      <th className="px-3 py-1.5 w-8"></th>
                      <th className="px-3 py-1.5">Invoice #</th>
                      <th className="px-3 py-1.5">Description</th>
                      <th className="px-3 py-1.5">Issued</th>
                      <th className="px-3 py-1.5">Due</th>
                      <th className="px-3 py-1.5 text-right">Amount</th>
                      <th className="px-3 py-1.5">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {vendor.rows.map((r) => {
                      const pv = preview?.rows.find((p) => p.id === r.id);
                      const hasWarn = pv && pv.warnings.length > 0;
                      return (
                        <tr key={r.id} className={`border-t hover:bg-gray-50 ${hasWarn ? "bg-amber-50/40" : ""}`}>
                          <td className="px-3 py-2">
                            <input type="checkbox" checked={selected.has(r.id)} onChange={() => toggle(r.id)} />
                          </td>
                          <td className="px-3 py-2">
                            <div className="font-medium">{r.invoiceNumber}</div>
                            {pv && (
                              <div className="text-xs text-muted-foreground">
                                {pv.bankAccountName ?? "—"} · rt {pv.bankRoutingNumber ?? "—"} · acct {maskAccount(pv.bankAccountNumber)}
                                {hasWarn && (
                                  <span className="ml-2 text-amber-700">⚠ {pv.warnings[0]}{pv.warnings.length > 1 ? ` (+${pv.warnings.length - 1})` : ""}</span>
                                )}
                              </div>
                            )}
                          </td>
                          <td className="px-3 py-2 text-muted-foreground max-w-[260px] truncate">{r.description ?? "—"}</td>
                          <td className="px-3 py-2">{fmtDate(r.issueDate)}</td>
                          <td className="px-3 py-2">{fmtDate(r.dueDate)}</td>
                          <td className="px-3 py-2 text-right font-semibold">{fmtUsd(r.totalAmount)}</td>
                          <td className="px-3 py-2">
                            <span className={`text-xs px-2 py-0.5 rounded ${
                              r.status === "paid" ? "bg-green-100 text-green-800" :
                              r.status === "processed" ? "bg-blue-100 text-blue-800" :
                              r.status === "approved" ? "bg-amber-100 text-amber-800" :
                              "bg-gray-100 text-gray-700"
                            }`}>{r.status}</span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            );
          })}

          <div className="flex items-center justify-end gap-2 text-xs text-muted-foreground pt-1">
            <button onClick={toggleAll} className="underline hover:text-brand-navy">
              {selected.size === rows.length ? "Deselect all" : `Select all (${rows.length})`}
            </button>
          </div>
        </div>
      )}

      <p className="text-xs text-muted-foreground mt-4">
        Workflow: approve invoices in the Invoices grid → <strong>approved</strong> → exporting the CSV marks them <strong>processed</strong> (file batch ID stored as reference) → after your bank confirms settlement, click <strong>Mark Paid</strong> with the bank reference number.
        Stripe Connect transfers are scaffolded behind the <code>STRIPE_CONNECT_ENABLED</code> environment flag.
      </p>
    </div>
  );
}
