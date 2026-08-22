import { useEffect, useState } from "react";
import { Link, useParams } from "wouter";
import { ArrowLeft, Loader2, Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { api } from "@/lib/api";

/**
 * Single invoice read/edit view for a caller who holds `finance.transactions`
 * but is not a company owner or admin (a bookkeeper).
 *
 * This is the "Open" destination from InvoiceTransactionList for that role —
 * the admin data grid's per-record screen (/tables/invoices?focus=id) stays
 * requireAdmin-gated, so this is a separate, narrower surface, not a
 * loosening of it. It reads/writes GET|PUT /invoices/:id, which are gated the
 * same way (finance.transactions, independent of company-owner) as the
 * create/edit/send actions this role already has, so it shows exactly the
 * transaction-level fields that permission covers — no company totals or
 * cross-invoice aggregates.
 *
 * Deliberately no PDF download here — see InvoiceTransactionList's comment
 * on why that surface is withheld from this role.
 */

type LineItem = { description: string; hours?: number; rate?: number; amount: number; level?: number | null };

type Invoice = {
  id: string;
  invoiceNumber: string;
  clientId: string | null;
  siteId: string | null;
  siteName: string | null;
  clientName: string | null;
  clientEmail: string | null;
  clientAddress: string | null;
  periodStart: string;
  periodEnd: string;
  lineItems: LineItem[] | null;
  subtotal: string | number | null;
  taxAmount: string | number | null;
  totalAmount: string | number | null;
  processingFeeRate: string | number | null;
  processingFeeAmount: string | number | null;
  status: string;
  dueDate: string | null;
  paidAt: string | null;
  notes: string | null;
  autoSynced: boolean;
  createdAt: string;
};

const fmtDate = (iso: string | null | undefined): string => {
  if (!iso) return "—";
  const d = new Date(iso.length <= 10 ? `${iso}T00:00:00` : iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
};

const fmtMoney = (v: string | number | null): string => {
  if (v === null || v === undefined || v === "") return "—";
  const n = Number(v);
  return isNaN(n) ? String(v) : `$${n.toFixed(2)}`;
};

// yyyy-mm-dd for a <input type="date">, from any ISO date/datetime string.
const toDateInputValue = (iso: string | null | undefined): string => {
  if (!iso) return "";
  const d = new Date(iso.length <= 10 ? `${iso}T00:00:00` : iso);
  if (isNaN(d.getTime())) return "";
  return d.toISOString().slice(0, 10);
};

export function InvoiceDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const { toast } = useToast();

  const [invoice, setInvoice] = useState<Invoice | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const [notes, setNotes] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [saving, setSaving] = useState(false);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api<Invoice>(`/invoices/${id}`);
      setInvoice(data);
      setStatus(data.status ?? "");
      setNotes(data.notes ?? "");
      setDueDate(toDateInputValue(data.dueDate));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [id]);

  const save = async () => {
    setSaving(true);
    try {
      const updated = await api<Invoice>(`/invoices/${id}`, {
        method: "PUT",
        body: { status, notes, dueDate: dueDate || undefined },
      });
      setInvoice(updated);
      setStatus(updated.status ?? "");
      setNotes(updated.notes ?? "");
      setDueDate(toDateInputValue(updated.dueDate));
      toast({ title: "Invoice updated" });
    } catch (e) {
      toast({ title: "Couldn't save changes", description: (e as Error).message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="max-w-2xl mx-auto" data-testid="invoice-detail">
      <Link href="/invoices/board" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground mb-4">
        <ArrowLeft className="w-4 h-4" /> Back to invoices
      </Link>

      {loading ? (
        <div className="bg-card border rounded-lg p-12 text-center text-muted-foreground">
          <Loader2 className="w-6 h-6 animate-spin inline" />
        </div>
      ) : error ? (
        <div className="px-4 py-3 rounded border bg-red-50 border-red-300 text-red-900" role="alert">
          Couldn't load this invoice: {error}
        </div>
      ) : !invoice ? (
        <div className="bg-card border rounded-lg p-12 text-center text-muted-foreground">
          Invoice not found.
        </div>
      ) : (
        <div className="bg-card border rounded-lg p-6 space-y-6">
          <div>
            <h1 className="text-lg font-semibold">{invoice.invoiceNumber}</h1>
            <p className="text-sm text-muted-foreground">
              {invoice.clientName ?? "—"} · {invoice.siteName ?? "(no site)"} · {fmtDate(invoice.periodStart)} → {fmtDate(invoice.periodEnd)}
            </p>
          </div>

          <div className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <div className="text-xs text-muted-foreground">Subtotal</div>
              <div className="font-medium">{fmtMoney(invoice.subtotal)}</div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">Total</div>
              <div className="font-medium">{fmtMoney(invoice.totalAmount)}</div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">Paid</div>
              <div className="font-medium">{fmtDate(invoice.paidAt)}</div>
            </div>
          </div>

          {invoice.lineItems && invoice.lineItems.length > 0 && (
            <div className="border-t pt-4">
              <div className="text-xs text-muted-foreground mb-2">Line items</div>
              <div className="space-y-1 text-sm">
                {invoice.lineItems.map((li, i) => (
                  <div key={i} className="flex justify-between gap-4">
                    <span className="truncate">{li.description}</span>
                    <span className="shrink-0 font-medium">{fmtMoney(li.amount)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="border-t pt-4 space-y-4">
            <div>
              <Label className="text-xs" htmlFor="invoice-detail-status">Status</Label>
              <select
                id="invoice-detail-status"
                className="block border rounded h-9 px-2 text-sm mt-1 w-full max-w-[200px]"
                value={status}
                onChange={(e) => setStatus(e.target.value)}
              >
                <option value="draft">Draft</option>
                <option value="sent">Sent</option>
                <option value="paid">Paid</option>
                <option value="overdue">Overdue</option>
                <option value="void">Void</option>
              </select>
            </div>
            <div>
              <Label className="text-xs" htmlFor="invoice-detail-due-date">Due date</Label>
              <Input
                id="invoice-detail-due-date"
                type="date"
                className="mt-1 max-w-[200px]"
                value={dueDate}
                onChange={(e) => setDueDate(e.target.value)}
              />
            </div>
            <div>
              <Label className="text-xs" htmlFor="invoice-detail-notes">Notes</Label>
              <Textarea
                id="invoice-detail-notes"
                className="mt-1"
                rows={3}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
              />
            </div>
            <Button onClick={() => void save()} disabled={saving} data-testid="button-save-invoice">
              {saving ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Save className="w-4 h-4 mr-2" />}
              Save changes
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

export default InvoiceDetailPage;
