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
 * Plain payroll-entry list for a caller who holds `finance.transactions` but
 * is NOT a company owner (a bookkeeper).
 *
 * The Payroll Board proper is an aggregate financial dashboard (gross totals,
 * pay-run hand-off) and stays owner-only. This is the transactional
 * counterpart: enough per-record detail to FIND a payroll entry and open it,
 * and nothing more. It reads GET /payroll, which the server already sanitizes
 * for a non-owner (grossPay / netPay are stripped before the response leaves
 * the API), so no money aggregate can reach this component even if it asked.
 */

type PayrollRow = {
  id: string;
  employeeId: string;
  employeeName: string | null;
  siteId: string | null;
  siteName: string | null;
  periodStart: string;
  periodEnd: string;
  totalHours: string | number | null;
  status: string | null;
  paidAt: string | null;
  paidMethod: string | null;
  paymentReference: string | null;
  createdAt: string;
};

const fmtDate = (iso: string | null | undefined): string => {
  if (!iso) return "—";
  const d = new Date(iso.length <= 10 ? `${iso}T00:00:00` : iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
};

const fmtHours = (v: string | number | null): string => {
  if (v === null || v === undefined || v === "") return "—";
  const n = Number(v);
  return isNaN(n) ? String(v) : `${n.toFixed(2)}h`;
};

const STATUS_PILL: Record<string, string> = {
  pending: "bg-amber-100 text-amber-900",
  processed: "bg-blue-100 text-blue-900",
  paid: "bg-green-100 text-green-900",
  archived: "bg-gray-200 text-gray-700",
};

function StatusPill({ status }: { status: string | null }) {
  const s = status ?? "unknown";
  return (
    <span className={`text-xs px-2 py-0.5 rounded ${STATUS_PILL[s] ?? "bg-gray-100 text-gray-800"}`}>
      {s}
    </span>
  );
}

export function PayrollTransactionList() {
  const { user } = useAuth();
  // The per-record admin grid (the existing single-record screen) is
  // requireAdmin server-side, so only offer the deep link to a role that can
  // actually open it. Everyone else still gets the row detail inline.
  const canOpenRecord = user?.role === "admin";

  const [rows, setRows] = useState<PayrollRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const [periodStart, setPeriodStart] = useState("");
  const [periodEnd, setPeriodEnd] = useState("");
  const [search, setSearch] = useState("");

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (status) params.set("status", status);
      if (periodStart) params.set("periodStart", periodStart);
      if (periodEnd) params.set("periodEnd", periodEnd);
      const data = await api<PayrollRow[]>(`/payroll${params.toString() ? `?${params}` : ""}`);
      setRows(data);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [status, periodStart, periodEnd]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) =>
      [r.employeeName, r.siteName, r.paymentReference].some((v) => (v ?? "").toLowerCase().includes(q)),
    );
  }, [rows, search]);

  const columns: ResponsiveColumn<PayrollRow>[] = [
    {
      id: "employee",
      header: "Officer",
      mobile: "title",
      cell: (r) => <span className="font-medium">{r.employeeName ?? "(unknown officer)"}</span>,
    },
    { id: "site", header: "Site", cell: (r) => r.siteName ?? "(no site)" },
    {
      id: "period",
      header: "Pay period",
      cell: (r) => `${fmtDate(r.periodStart)} → ${fmtDate(r.periodEnd)}`,
    },
    { id: "hours", header: "Hours", align: "right", cell: (r) => fmtHours(r.totalHours) },
    { id: "status", header: "Status", mobile: "meta", cell: (r) => <StatusPill status={r.status} /> },
    { id: "paidAt", header: "Paid", cell: (r) => fmtDate(r.paidAt) },
    {
      id: "reference",
      header: "Reference",
      cell: (r) => (
        <span className="text-xs text-muted-foreground">
          {r.paymentReference ?? (r.paidMethod ? r.paidMethod : "—")}
        </span>
      ),
    },
    {
      id: "open",
      header: "",
      align: "right",
      mobile: "actions",
      cell: (r) =>
        canOpenRecord ? (
          <Link
            href={`/tables/payroll_entries?focus=${r.id}`}
            className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
            data-testid={`link-open-payroll-${r.id}`}
          >
            Open <ExternalLink className="w-3.5 h-3.5" />
          </Link>
        ) : null,
    },
  ];

  return (
    <div data-testid="payroll-transaction-list">
      <div className="flex flex-wrap gap-3 items-end mb-4 p-4 bg-card border rounded-lg">
        <div>
          <Label className="text-xs" htmlFor="payroll-list-status">Status</Label>
          <select
            id="payroll-list-status"
            className="block border rounded h-9 px-2 text-sm"
            value={status}
            onChange={(e) => setStatus(e.target.value)}
          >
            <option value="">All statuses</option>
            <option value="pending">Pending</option>
            <option value="processed">Processed</option>
            <option value="paid">Paid</option>
            <option value="archived">Archived</option>
          </select>
        </div>
        <div>
          <Label className="text-xs" htmlFor="payroll-list-from">Period from</Label>
          <Input
            id="payroll-list-from"
            type="date"
            className="h-9"
            value={periodStart}
            onChange={(e) => setPeriodStart(e.target.value)}
          />
        </div>
        <div>
          <Label className="text-xs" htmlFor="payroll-list-to">Period to</Label>
          <Input
            id="payroll-list-to"
            type="date"
            className="h-9"
            value={periodEnd}
            onChange={(e) => setPeriodEnd(e.target.value)}
          />
        </div>
        <div className="flex-1 min-w-[180px]">
          <Label className="text-xs" htmlFor="payroll-list-search">Search</Label>
          <Input
            id="payroll-list-search"
            className="h-9"
            placeholder="Officer, site or reference"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <Button variant="outline" onClick={() => void load()} disabled={loading}>
          {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : "Refresh"}
        </Button>
      </div>

      {error && (
        <div className="mb-4 px-4 py-3 rounded border bg-red-50 border-red-300 text-red-900" role="alert">
          Couldn't load payroll entries: {error}
        </div>
      )}

      {loading ? (
        <div className="bg-card border rounded-lg p-12 text-center text-muted-foreground">
          <Loader2 className="w-6 h-6 animate-spin inline" />
        </div>
      ) : visible.length === 0 ? (
        <div className="bg-card border rounded-lg p-12 text-center text-muted-foreground">
          No payroll entries match these filters.
        </div>
      ) : (
        <ResponsiveTable
          data={visible}
          columns={columns}
          getRowKey={(r) => r.id}
          scrollAriaLabel="Payroll entries"
        />
      )}
    </div>
  );
}
