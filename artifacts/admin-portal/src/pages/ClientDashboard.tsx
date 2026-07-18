import { useEffect, useState } from "react";
import { Link } from "wouter";
import {
  Users,
  CalendarClock,
  FileText,
  Receipt,
  ArrowRight,
  CheckCircle2,
  Clock,
  AlertTriangle,
} from "lucide-react";
import { api } from "@/lib/api";

type ClientMe = {
  client: { id: string; name: string; contactName: string | null; paymentTermsDays: number | null };
  sites: Array<{ id: string; name: string; address: string | null }>;
};
type Shift = { id: string; title: string; siteName: string | null; startTime: string; status: string; officers: { name: string; licenseLevel: number | null }[] };
type CoverageRequest = { id: string; status: string; siteName: string | null; startDate: string; endDate: string; createdAt: string };
type Invoice = { id: string; invoiceNumber: string; totalAmount: string | null; status: string; dueDate: string | null };

function useClientData() {
  const [me, setMe] = useState<ClientMe | null>(null);
  const [shifts, setShifts] = useState<Shift[]>([]);
  const [requests, setRequests] = useState<CoverageRequest[]>([]);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    Promise.all([
      api<ClientMe>("/client/me"),
      api<Shift[]>("/client/shifts"),
      api<CoverageRequest[]>("/client/shift-requests"),
      api<Invoice[]>("/client/invoices"),
    ])
      .then(([me, shifts, requests, invoices]) => {
        if (!active) return;
        setMe(me);
        setShifts(shifts.slice(0, 4));
        setRequests(requests.slice(0, 5));
        setInvoices(invoices.slice(0, 5));
      })
      .catch(() => {})
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  return { me, shifts, requests, invoices, loading };
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    pending: "bg-amber-100 text-amber-700",
    approved: "bg-green-100 text-green-700",
    declined: "bg-red-100 text-red-700",
    sent: "bg-blue-100 text-blue-700",
    paid: "bg-green-100 text-green-700",
    overdue: "bg-red-100 text-red-700",
    upcoming: "bg-sky-100 text-sky-700",
    active: "bg-emerald-100 text-emerald-700",
  };
  return (
    <span className={`inline-block px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wide ${map[status] ?? "bg-gray-100 text-gray-600"}`}>
      {status}
    </span>
  );
}

function fmt(d: string) {
  return new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}
function fmtTime(d: string) {
  return new Date(d).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}
function fmtUsd(n: string | null) {
  if (!n) return "—";
  return parseFloat(n).toLocaleString("en-US", { style: "currency", currency: "USD" });
}

export default function ClientDashboard() {
  const { me, shifts, requests, invoices, loading } = useClientData();

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64 text-muted-foreground text-sm">
        Loading…
      </div>
    );
  }

  const pendingInvoices = invoices.filter((i) => i.status === "sent" || i.status === "overdue");
  const pendingRequests = requests.filter((r) => r.status === "pending");

  return (
    <div className="max-w-5xl mx-auto px-4 py-8 space-y-8">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-foreground">
          Welcome, {me?.client.name ?? "Client"}
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          {me?.sites.length ?? 0} site{me?.sites.length !== 1 ? "s" : ""} ·{" "}
          {me?.client.paymentTermsDays ? `Net ${me.client.paymentTermsDays} payment terms` : ""}
        </p>
      </div>

      {/* Quick stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard
          icon={<Users className="w-5 h-5 text-blue-600" />}
          label="Officers on shift"
          value={String(shifts.filter((s) => s.status === "active").length)}
          sub="currently active"
          bg="bg-blue-50"
        />
        <StatCard
          icon={<CalendarClock className="w-5 h-5 text-amber-600" />}
          label="Coverage requests"
          value={String(pendingRequests.length)}
          sub="awaiting review"
          bg="bg-amber-50"
        />
        <StatCard
          icon={<Receipt className="w-5 h-5 text-red-600" />}
          label="Invoices due"
          value={String(pendingInvoices.length)}
          sub="need payment"
          bg="bg-red-50"
        />
        <StatCard
          icon={<CheckCircle2 className="w-5 h-5 text-green-600" />}
          label="Sites covered"
          value={String(me?.sites.length ?? 0)}
          sub="under contract"
          bg="bg-green-50"
        />
      </div>

      {/* Two column: shifts + requests */}
      <div className="grid md:grid-cols-2 gap-6">
        {/* Upcoming shifts */}
        <div className="border rounded-lg overflow-hidden">
          <div className="flex items-center justify-between px-4 py-3 bg-muted/40 border-b">
            <span className="text-sm font-semibold flex items-center gap-2">
              <Users className="w-4 h-4" /> Upcoming shifts
            </span>
            <Link href="/client/shifts" className="text-xs text-primary flex items-center gap-1 hover:underline">
              See all <ArrowRight className="w-3 h-3" />
            </Link>
          </div>
          {shifts.length === 0 ? (
            <div className="p-6 text-center text-sm text-muted-foreground">No upcoming shifts in the next 14 days.</div>
          ) : (
            <ul className="divide-y">
              {shifts.map((s) => (
                <li key={s.id} className="px-4 py-3 text-sm flex items-start gap-3">
                  <Clock className="w-4 h-4 text-muted-foreground mt-0.5 shrink-0" />
                  <div className="min-w-0">
                    <div className="font-medium truncate">{s.title}</div>
                    <div className="text-muted-foreground text-xs">{fmtTime(s.startTime)} · {s.siteName}</div>
                    <div className="text-xs text-muted-foreground mt-0.5">
                      {s.officers.length} officer{s.officers.length !== 1 ? "s" : ""} assigned
                    </div>
                  </div>
                  <StatusBadge status={s.status} />
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Coverage requests */}
        <div className="border rounded-lg overflow-hidden">
          <div className="flex items-center justify-between px-4 py-3 bg-muted/40 border-b">
            <span className="text-sm font-semibold flex items-center gap-2">
              <CalendarClock className="w-4 h-4" /> Coverage requests
            </span>
            <Link href="/client/request" className="text-xs text-primary flex items-center gap-1 hover:underline">
              See all <ArrowRight className="w-3 h-3" />
            </Link>
          </div>
          {requests.length === 0 ? (
            <div className="p-6 text-center text-sm text-muted-foreground">
              No requests yet.{" "}
              <Link href="/client/request" className="text-primary hover:underline">Submit one.</Link>
            </div>
          ) : (
            <ul className="divide-y">
              {requests.map((r) => (
                <li key={r.id} className="px-4 py-3 text-sm flex items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="font-medium truncate">{r.siteName}</div>
                    <div className="text-muted-foreground text-xs">
                      {r.startDate === r.endDate ? fmt(r.startDate) : `${fmt(r.startDate)} – ${fmt(r.endDate)}`}
                    </div>
                  </div>
                  <StatusBadge status={r.status} />
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {/* Invoices */}
      {invoices.length > 0 && (
        <div className="border rounded-lg overflow-hidden">
          <div className="flex items-center justify-between px-4 py-3 bg-muted/40 border-b">
            <span className="text-sm font-semibold flex items-center gap-2">
              <Receipt className="w-4 h-4" /> Recent invoices
            </span>
            <Link href="/client/invoices" className="text-xs text-primary flex items-center gap-1 hover:underline">
              View all <ArrowRight className="w-3 h-3" />
            </Link>
          </div>
          <ul className="divide-y">
            {invoices.map((inv) => (
              <li key={inv.id} className="px-4 py-3 text-sm flex items-center gap-3">
                <div className="flex-1 min-w-0">
                  <span className="font-medium">{inv.invoiceNumber}</span>
                  {inv.dueDate && (
                    <span className="text-muted-foreground text-xs ml-2">Due {fmt(inv.dueDate)}</span>
                  )}
                </div>
                <span className="font-semibold text-foreground">{fmtUsd(inv.totalAmount)}</span>
                <StatusBadge status={inv.status} />
                {(inv.status === "sent" || inv.status === "overdue") && (
                  <Link
                    href="/client/invoices"
                    className="text-xs text-primary hover:underline flex items-center gap-1"
                  >
                    Pay <ArrowRight className="w-3 h-3" />
                  </Link>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {pendingInvoices.length > 0 && (
        <div className="flex items-start gap-3 bg-amber-50 border border-amber-200 rounded-lg px-4 py-3 text-sm text-amber-800">
          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
          <div>
            You have {pendingInvoices.length} outstanding invoice{pendingInvoices.length !== 1 ? "s" : ""}.{" "}
            <Link href="/client/invoices" className="font-semibold hover:underline">Pay now →</Link>
          </div>
        </div>
      )}
    </div>
  );
}

function StatCard({ icon, label, value, sub, bg }: { icon: React.ReactNode; label: string; value: string; sub: string; bg: string }) {
  return (
    <div className={`rounded-lg border p-4 ${bg}`}>
      <div className="flex items-center gap-2 mb-2">{icon}<span className="text-xs text-muted-foreground font-medium uppercase tracking-wide">{label}</span></div>
      <div className="text-2xl font-bold text-foreground">{value}</div>
      <div className="text-xs text-muted-foreground mt-0.5">{sub}</div>
    </div>
  );
}
