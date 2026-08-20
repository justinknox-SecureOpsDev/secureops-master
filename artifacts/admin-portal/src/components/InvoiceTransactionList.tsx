import { useEffect, useMemo, useState } from "react";
import { Loader2, ExternalLink } from "lucide-react";
import { Link } from "wouter";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { ResponsiveTable, type ResponsiveColumn } from "@/components/ResponsiveTable";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";

/**
 * Plain invoice list for a caller who holds `finance.transactions` but is NOT
 * a company owner (a bookkeeper).
 *
 * The Invoice Board proper is an aggregate financial dashboard (period totals,
 * bulk send, revenue roll-ups) and stays owner-only. This is the transactional
 * counterpart: enough per-record detail to FIND an invoice and open it. It
 * reads GET /invoices, which the server already sanitizes for a non-owner
 * (subtotal / totalAmount are stripped before the response leaves the API).
 */

type InvoiceListRow = {
  id: string;
  invoiceNumber: string;
  clientName: string | null;
  siteName: string | null;
  periodStart: string;
  periodEnd: string;
  status: string;
  dueDate: string | null;
  paidAt: string | null;
  createdAt: string;
};

const fmtDate = (iso: string | null | undefined): string => {
  if (!iso) return "—";
  const d = new Date(iso.length <= 10 ? `${iso}T00:00:00` : iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
};

const STATUS_PILL: Record<string, string> = {
  draft: "bg-gray-100 text-gray-800",
  sent: "bg-blue-100 text-blue-900",
  paid: "bg-green-100 text-green-900",
  overdue: "bg-red-100 text-red-900",
  void: "bg-gray-200 text-gray-700",
};

function StatusPill({ status }: { status: string }) {
  return (
    <span className={`text-xs px-2 py-0.5 rounded ${STATUS_PILL[status] ?? "bg-gray-100 text-gray-800"}`}>
      {status}
    </span>
  );
}

export function InvoiceTransactionList() {
  const { user } = useAuth();
  // The per-record admin grid (the existing single-record screen) is
  // requireAdmin server-side, so only offer the deep link to a role that can
  // actually open it.
  //
  // Deliberately NO invoice-PDF action here: the generated PDF carries
  // subtotal, tax, processing fees, total and every line item — exactly the
  // company money detail this list is sanitized of. Offering it beside rows
  // that hand out every invoice id would make that detail one click away and
  // defeat the sanitization. Any future download for this role needs its own
  // sanitized document and authorization decision, not this button.
  const canOpenRecord = user?.role === "admin";

  const [rows, setRows] = useState<InvoiceListRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [search, setSearch] = useState("");

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (status) params.set("status", status);
      // The server requires the overlap window to be complete or absent.
      if (from && to) {
        params.set("overlapStart", from);
        params.set("overlapEnd", to);
      }
      const data = await api<InvoiceListRow[]>(`/invoices${params.toString() ? `?${params}` : ""}`);
      setRows(data);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [status, from, to]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) =>
      [r.invoiceNumber, r.clientName, r.siteName].some((v) => (v ?? "").toLowerCase().includes(q)),
    );
  }, [rows, search]);

  const columns: ResponsiveColumn<InvoiceListRow>[] = [
    {
      id: "number",
      header: "Invoice",
      mobile: "title",
      cell: (r) => <span className="font-medium">{r.invoiceNumber}</span>,
    },
    { id: "client", header: "Client", cell: (r) => r.clientName ?? "—" },
    { id: "site", header: "Site", cell: (r) => r.siteName ?? "(no site)" },
    {
      id: "period",
      header: "Period",
      cell: (r) => `${fmtDate(r.periodStart)} → ${fmtDate(r.periodEnd)}`,
    },
    { id: "status", header: "Status", mobile: "meta", cell: (r) => <StatusPill status={r.status} /> },
    { id: "due", header: "Due", cell: (r) => fmtDate(r.dueDate) },
    { id: "paid", header: "Paid", cell: (r) => fmtDate(r.paidAt) },
    ...(canOpenRecord
      ? [{
          id: "actions",
          header: "",
          align: "right" as const,
          mobile: "actions" as const,
          cell: (r: InvoiceListRow) => (
            <Link
              href={`/tables/invoices?focus=${r.id}`}
              className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
              data-testid={`link-open-invoice-${r.id}`}
            >
              Open <ExternalLink className="w-3.5 h-3.5" />
            </Link>
          ),
        }]
      : []),
  ];

  return (
    <div data-testid="invoice-transaction-list">
      <div className="flex flex-wrap gap-3 items-end mb-4 p-4 bg-card border rounded-lg">
        <div>
          <Label className="text-xs" htmlFor="invoice-list-status">Status</Label>
          <select
            id="invoice-list-status"
            className="block border rounded h-9 px-2 text-sm"
            value={status}
            onChange={(e) => setStatus(e.target.value)}
          >
            <option value="">All statuses</option>
            <option value="draft">Draft</option>
            <option value="sent">Sent</option>
            <option value="paid">Paid</option>
            <option value="overdue">Overdue</option>
            <option value="void">Void</option>
          </select>
        </div>
        <div>
          <Label className="text-xs" htmlFor="invoice-list-from">Period from</Label>
          <Input
            id="invoice-list-from"
            type="date"
            className="h-9"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
          />
        </div>
        <div>
          <Label className="text-xs" htmlFor="invoice-list-to">Period to</Label>
          <Input
            id="invoice-list-to"
            type="date"
            className="h-9"
            value={to}
            onChange={(e) => setTo(e.target.value)}
          />
        </div>
        <div className="flex-1 min-w-[180px]">
          <Label className="text-xs" htmlFor="invoice-list-search">Search</Label>
          <Input
            id="invoice-list-search"
            className="h-9"
            placeholder="Invoice number, client or site"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <Button variant="outline" onClick={() => void load()} disabled={loading}>
          {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : "Refresh"}
        </Button>
      </div>

      {(from && !to) || (!from && to) ? (
        <p className="text-xs text-muted-foreground mb-3">
          Set both period dates to filter by date range.
        </p>
      ) : null}

      {error && (
        <div className="mb-4 px-4 py-3 rounded border bg-red-50 border-red-300 text-red-900" role="alert">
          {error}
        </div>
      )}

      {loading ? (
        <div className="bg-card border rounded-lg p-12 text-center text-muted-foreground">
          <Loader2 className="w-6 h-6 animate-spin inline" />
        </div>
      ) : visible.length === 0 ? (
        <div className="bg-card border rounded-lg p-12 text-center text-muted-foreground">
          No invoices match these filters.
        </div>
      ) : (
        <ResponsiveTable
          data={visible}
          columns={columns}
          getRowKey={(r) => r.id}
          scrollAriaLabel="Invoices"
        />
      )}
    </div>
  );
}
