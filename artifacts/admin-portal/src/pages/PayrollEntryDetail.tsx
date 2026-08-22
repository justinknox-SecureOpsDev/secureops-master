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
 * Single payroll-entry read/edit view for a caller who holds
 * `finance.transactions` but is not a company owner or admin (a bookkeeper).
 *
 * This is the "Open" destination from PayrollTransactionList for that role —
 * the admin data grid's per-record screen (/tables/payroll_entries?focus=id)
 * stays requireAdmin-gated, so this is a separate, narrower surface, not a
 * loosening of it. It reads/writes GET|PUT /payroll/:id, which are gated the
 * same way (finance.transactions, independent of company-owner) as the
 * create/edit actions this role already has, so it shows exactly the
 * transaction-level fields that permission covers — no company totals or
 * cross-record aggregates.
 */

type PayrollEntry = {
  id: string;
  employeeId: string;
  employeeName: string | null;
  siteId: string | null;
  siteName: string | null;
  periodStart: string;
  periodEnd: string;
  totalHours: string | number | null;
  hourlyRate: string | number | null;
  grossPay: string | number | null;
  netPay: string | number | null;
  status: string | null;
  paidAt: string | null;
  paidMethod: string | null;
  paymentReference: string | null;
  notes: string | null;
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

const fmtHours = (v: string | number | null): string => {
  if (v === null || v === undefined || v === "") return "—";
  const n = Number(v);
  return isNaN(n) ? String(v) : `${n.toFixed(2)}h`;
};

// yyyy-mm-dd for a <input type="date">, from any ISO date/datetime string.
const toDateInputValue = (iso: string | null | undefined): string => {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return d.toISOString().slice(0, 10);
};

export function PayrollEntryDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const { toast } = useToast();

  const [entry, setEntry] = useState<PayrollEntry | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const [notes, setNotes] = useState("");
  const [paidAt, setPaidAt] = useState("");
  const [paidMethod, setPaidMethod] = useState("");
  const [paymentReference, setPaymentReference] = useState("");
  const [saving, setSaving] = useState(false);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api<PayrollEntry>(`/payroll/${id}`);
      setEntry(data);
      setStatus(data.status ?? "");
      setNotes(data.notes ?? "");
      setPaidAt(toDateInputValue(data.paidAt));
      setPaidMethod(data.paidMethod ?? "");
      setPaymentReference(data.paymentReference ?? "");
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
      const updated = await api<PayrollEntry>(`/payroll/${id}`, {
        method: "PUT",
        body: {
          status,
          notes,
          paidAt: paidAt || null,
          paidMethod: paidMethod || null,
          paymentReference: paymentReference || null,
        },
      });
      setEntry(updated);
      setStatus(updated.status ?? "");
      setNotes(updated.notes ?? "");
      setPaidAt(toDateInputValue(updated.paidAt));
      setPaidMethod(updated.paidMethod ?? "");
      setPaymentReference(updated.paymentReference ?? "");
      toast({ title: "Payroll entry updated" });
    } catch (e) {
      toast({ title: "Couldn't save changes", description: (e as Error).message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="max-w-2xl mx-auto" data-testid="payroll-entry-detail">
      <Link href="/payroll/board" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground mb-4">
        <ArrowLeft className="w-4 h-4" /> Back to payroll
      </Link>

      {loading ? (
        <div className="bg-card border rounded-lg p-12 text-center text-muted-foreground">
          <Loader2 className="w-6 h-6 animate-spin inline" />
        </div>
      ) : error ? (
        <div className="px-4 py-3 rounded border bg-red-50 border-red-300 text-red-900" role="alert">
          Couldn't load this payroll entry: {error}
        </div>
      ) : !entry ? (
        <div className="bg-card border rounded-lg p-12 text-center text-muted-foreground">
          Payroll entry not found.
        </div>
      ) : (
        <div className="bg-card border rounded-lg p-6 space-y-6">
          <div>
            <h1 className="text-lg font-semibold">{entry.employeeName ?? "(unknown officer)"}</h1>
            <p className="text-sm text-muted-foreground">
              {entry.siteName ?? "(no site)"} · {fmtDate(entry.periodStart)} → {fmtDate(entry.periodEnd)}
            </p>
          </div>

          <div className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <div className="text-xs text-muted-foreground">Hours</div>
              <div className="font-medium">{fmtHours(entry.totalHours)}</div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">Hourly rate</div>
              <div className="font-medium">{fmtMoney(entry.hourlyRate)}</div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">Gross pay</div>
              <div className="font-medium">{fmtMoney(entry.grossPay)}</div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">Net pay</div>
              <div className="font-medium">{fmtMoney(entry.netPay)}</div>
            </div>
          </div>

          <div className="border-t pt-4 space-y-4">
            <div>
              <Label className="text-xs" htmlFor="payroll-entry-status">Status</Label>
              <select
                id="payroll-entry-status"
                className="block border rounded h-9 px-2 text-sm mt-1 w-full max-w-[200px]"
                value={status}
                onChange={(e) => setStatus(e.target.value)}
              >
                <option value="pending">Pending</option>
                <option value="processed">Processed</option>
                <option value="paid">Paid</option>
                <option value="archived">Archived</option>
              </select>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <Label className="text-xs" htmlFor="payroll-entry-paid-at">Paid on</Label>
                <Input
                  id="payroll-entry-paid-at"
                  type="date"
                  className="mt-1"
                  value={paidAt}
                  onChange={(e) => setPaidAt(e.target.value)}
                />
              </div>
              <div>
                <Label className="text-xs" htmlFor="payroll-entry-paid-method">Payment method</Label>
                <select
                  id="payroll-entry-paid-method"
                  className="block border rounded h-9 px-2 text-sm mt-1 w-full"
                  value={paidMethod}
                  onChange={(e) => setPaidMethod(e.target.value)}
                >
                  <option value="">—</option>
                  <option value="manual">Manual</option>
                  <option value="ach_csv">ACH (bank file)</option>
                  <option value="stripe">Stripe</option>
                </select>
              </div>
            </div>
            <div>
              <Label className="text-xs" htmlFor="payroll-entry-payment-reference">Payment reference</Label>
              <Input
                id="payroll-entry-payment-reference"
                className="mt-1"
                value={paymentReference}
                onChange={(e) => setPaymentReference(e.target.value)}
                placeholder="Bank confirmation #, batch id, transfer id…"
              />
            </div>
            <div>
              <Label className="text-xs" htmlFor="payroll-entry-notes">Notes</Label>
              <Textarea
                id="payroll-entry-notes"
                className="mt-1"
                rows={3}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
              />
            </div>
            <Button onClick={() => void save()} disabled={saving} data-testid="button-save-payroll-entry">
              {saving ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Save className="w-4 h-4 mr-2" />}
              Save changes
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

export default PayrollEntryDetailPage;
