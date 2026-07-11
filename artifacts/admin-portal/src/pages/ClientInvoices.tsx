import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { Receipt, Download, CreditCard, CheckCircle2, AlertTriangle, ChevronDown, ChevronUp } from "lucide-react";
import { api, fetchWithAuth } from "@/lib/api";
import { formatDate } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";

type LineItem = { description: string; hours?: number | null; rate?: number | null; amount: number };
type Invoice = {
  id: string;
  invoiceNumber: string;
  siteId: string | null;
  siteName: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  clientName: string | null;
  lineItems: LineItem[] | null;
  subtotal: string | null;
  taxAmount: string | null;
  totalAmount: string | null;
  status: string;
  dueDate: string | null;
  paidAt: string | null;
  stripeCheckoutSessionId: string | null;
  createdAt: string;
};

function fmtUsd(n: string | number | null) {
  if (n == null) return "—";
  const v = parseFloat(String(n));
  return isNaN(v) ? "—" : v.toLocaleString("en-US", { style: "currency", currency: "USD" });
}
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;
function fmt(d: string | null) {
  if (!d) return "—";
  const opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric", year: "numeric" };
  // periodStart/periodEnd/dueDate are pg `date` columns (literal calendar
  // dates → render in UTC); paidAt is a timestamp → render in Central.
  return DATE_ONLY_RE.test(d) ? formatDate(d + "T00:00:00Z", opts, "UTC") : formatDate(d, opts);
}

const STATUS_CFG: Record<string, { label: string; cls: string; icon: React.ReactNode }> = {
  sent: { label: "Payment due", cls: "bg-blue-100 text-blue-700", icon: <Receipt className="w-3 h-3" /> },
  overdue: { label: "Overdue", cls: "bg-red-100 text-red-700", icon: <AlertTriangle className="w-3 h-3" /> },
  paid: { label: "Paid", cls: "bg-green-100 text-green-700", icon: <CheckCircle2 className="w-3 h-3" /> },
};

function InvoiceRow({ inv, onPaid }: { inv: Invoice; onPaid: () => void }) {
  const { toast } = useToast();
  const [expanded, setExpanded] = useState(false);
  const [paying, setPaying] = useState(false);
  const cfg = STATUS_CFG[inv.status] ?? { label: inv.status, cls: "bg-gray-100 text-gray-500", icon: null };

  async function downloadPdf() {
    const res = await fetchWithAuth(`/api/client/invoices/${inv.id}/pdf`);
    if (!res.ok) { toast({ title: "PDF not available.", variant: "destructive" }); return; }
    const blob = await res.blob();
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `invoice-${inv.invoiceNumber}.pdf`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  async function pay() {
    setPaying(true);
    try {
      const res = await api<{ checkoutUrl: string | null; stripeConfigured: boolean }>(
        `/client/invoices/${inv.id}/checkout`,
        { method: "POST" },
      );
      if (!res.stripeConfigured || !res.checkoutUrl) {
        toast({
          title: "Online payment not available",
          description: "Please contact your account manager to arrange payment.",
          variant: "destructive",
        });
        return;
      }
      window.location.href = res.checkoutUrl;
    } catch (err: any) {
      toast({ title: err?.message ?? "Payment failed.", variant: "destructive" });
    } finally {
      setPaying(false);
    }
  }

  return (
    <div className="border rounded-lg bg-card overflow-hidden">
      <div
        className="flex items-center gap-4 px-4 py-3 cursor-pointer hover:bg-muted/30 transition-colors"
        onClick={() => setExpanded((e) => !e)}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => e.key === "Enter" && setExpanded((x) => !x)}
      >
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-semibold text-sm">{inv.invoiceNumber}</span>
            <span className={`inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full uppercase tracking-wide ${cfg.cls}`}>
              {cfg.icon}{cfg.label}
            </span>
          </div>
          <div className="text-xs text-muted-foreground mt-0.5 flex flex-wrap gap-x-3">
            {inv.siteName && <span>{inv.siteName}</span>}
            {inv.periodStart && inv.periodEnd && (
              <span>{fmt(inv.periodStart)} – {fmt(inv.periodEnd)}</span>
            )}
            {inv.dueDate && inv.status !== "paid" && (
              <span>Due {fmt(inv.dueDate)}</span>
            )}
            {inv.paidAt && (
              <span className="text-green-600">Paid {fmt(inv.paidAt)}</span>
            )}
          </div>
        </div>
        <div className="text-right shrink-0">
          <div className="font-bold text-base">{fmtUsd(inv.totalAmount)}</div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {(inv.status === "sent" || inv.status === "overdue") && (
            <Button
              size="sm"
              className="gap-1 h-8"
              onClick={(e) => { e.stopPropagation(); pay(); }}
              disabled={paying}
            >
              <CreditCard className="w-3.5 h-3.5" />
              {paying ? "Redirecting…" : "Pay online"}
            </Button>
          )}
          {expanded ? <ChevronUp className="w-4 h-4 text-muted-foreground" /> : <ChevronDown className="w-4 h-4 text-muted-foreground" />}
        </div>
      </div>

      {expanded && (
        <div className="border-t px-4 py-4 bg-muted/20 space-y-4">
          {inv.lineItems && inv.lineItems.length > 0 && (
            <div>
              <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">Line items</div>
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-xs text-muted-foreground border-b">
                    <th className="text-left pb-1 font-medium">Description</th>
                    <th className="text-right pb-1 font-medium">Hrs</th>
                    <th className="text-right pb-1 font-medium">Rate</th>
                    <th className="text-right pb-1 font-medium">Amount</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {inv.lineItems.map((li, i) => (
                    <tr key={i} className="text-xs">
                      <td className="py-1.5 pr-2">{li.description}</td>
                      <td className="py-1.5 text-right text-muted-foreground">{li.hours != null ? li.hours.toFixed(2) : "—"}</td>
                      <td className="py-1.5 text-right text-muted-foreground">{li.rate != null ? fmtUsd(li.rate) : "—"}</td>
                      <td className="py-1.5 text-right font-medium">{fmtUsd(li.amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="border-t pt-2 mt-2 space-y-1 text-sm">
                <div className="flex justify-between text-muted-foreground text-xs">
                  <span>Subtotal</span><span>{fmtUsd(inv.subtotal)}</span>
                </div>
                {inv.taxAmount && parseFloat(inv.taxAmount) > 0 && (
                  <div className="flex justify-between text-muted-foreground text-xs">
                    <span>Tax</span><span>{fmtUsd(inv.taxAmount)}</span>
                  </div>
                )}
                <div className="flex justify-between font-bold">
                  <span>Total</span><span>{fmtUsd(inv.totalAmount)}</span>
                </div>
              </div>
            </div>
          )}
          <Button size="sm" variant="outline" className="gap-1" onClick={downloadPdf}>
            <Download className="w-3.5 h-3.5" /> Download PDF
          </Button>
        </div>
      )}
    </div>
  );
}

export default function ClientInvoices() {
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [loading, setLoading] = useState(true);
  const [location] = useLocation();
  const { toast } = useToast();

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const payment = params.get("payment");
    if (payment === "success") {
      toast({ title: "Payment successful!", description: "Your invoice will be marked paid shortly." });
    } else if (payment === "cancelled") {
      toast({ title: "Payment cancelled.", description: "Your invoice is still outstanding." });
    }
  }, []);

  function refresh() {
    return api<Invoice[]>("/client/invoices").then(setInvoices);
  }

  useEffect(() => {
    refresh().finally(() => setLoading(false));
  }, []);

  const outstanding = invoices.filter((i) => i.status === "sent" || i.status === "overdue");
  const paid = invoices.filter((i) => i.status === "paid");

  return (
    <div className="max-w-3xl mx-auto px-4 py-8">
      <h1 className="text-xl font-bold flex items-center gap-2 mb-6">
        <Receipt className="w-5 h-5" /> Invoices
      </h1>

      {loading ? (
        <div className="text-center py-16 text-muted-foreground text-sm">Loading invoices…</div>
      ) : invoices.length === 0 ? (
        <div className="text-center py-16 text-muted-foreground">
          <Receipt className="w-10 h-10 mx-auto mb-3 opacity-30" />
          <p className="text-sm">No invoices yet.</p>
        </div>
      ) : (
        <div className="space-y-6">
          {outstanding.length > 0 && (
            <div>
              <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">
                Outstanding ({outstanding.length})
              </h2>
              <div className="space-y-3">
                {outstanding.map((inv) => (
                  <InvoiceRow key={inv.id} inv={inv} onPaid={refresh} />
                ))}
              </div>
            </div>
          )}
          {paid.length > 0 && (
            <div>
              <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">
                Paid ({paid.length})
              </h2>
              <div className="space-y-3">
                {paid.map((inv) => (
                  <InvoiceRow key={inv.id} inv={inv} onPaid={refresh} />
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
