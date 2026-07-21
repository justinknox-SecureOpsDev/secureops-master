import { useCallback, useEffect, useMemo, useState } from "react";
import {
  BarChart3, Download, FileText, Loader2, AlertTriangle,
  TrendingUp, TrendingDown, Archive, ArchiveRestore,
} from "lucide-react";
import {
  Bar, BarChart, CartesianGrid, Line, LineChart, XAxis, YAxis,
} from "recharts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig,
} from "@/components/ui/chart";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Checkbox } from "@/components/ui/checkbox";
import { api, fetchWithAuth, ApiError } from "@/lib/api";
import { useToast } from "@/hooks/use-toast";

// Response shapes mirror artifacts/api-server/src/lib/analytics.ts (contract
// lives in lib/api-spec/openapi.yaml — GET /analytics/summary + /officers).
type WeekBucket = {
  weekStart: string; // business-TZ Monday, YYYY-MM-DD
  revenue: number;
  laborCost: number;
  pnl: number;
  hoursWorked: number;
  incidentCount: number;
};

type SiteRow = {
  siteId: string;
  siteName: string;
  clientName: string | null;
  revenue: number;
  laborCost: number;
  pnl: number;
  hoursWorked: number;
  coveragePct: number | null;
};

type Summary = {
  revenue: number;
  laborCost: number;
  pnl: number;
  marginPct: number | null;
  hoursWorked: number;
  hoursScheduled: number;
  coveragePct: number | null;
  noShows: number;
  unfilledShifts: number;
  incidents: {
    total: number;
    low: number;
    medium: number;
    high: number;
    critical: number;
    open: number;
    resolved: number;
  };
  weeklyTrend: WeekBucket[];
  sites: SiteRow[];
};

// employeeId here is users.id (the FK used by time_entries.employee_id →
// users.id), so it can be passed directly to PUT /admin/tables/users/:id.
type OfficerRow = {
  employeeId: string;
  name: string;
  hoursWorked: number;
  shiftsCompleted: number;
  incidentsFiled: number;
  punctualityPct: number | null;
  status: string;
  trend: { weekStart: string; hoursWorked: number }[];
};

type ClientOption = { id: string; name: string };

const usd = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});
const usdCents = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
});

const fmtMoney = (n: number) => (Math.abs(n) >= 1000 ? usd.format(n) : usdCents.format(n));
const fmtPct = (n: number | null) => (n == null ? "—" : `${n.toFixed(1)}%`);
const fmtHours = (n: number) =>
  `${n.toLocaleString("en-US", { maximumFractionDigits: 1 })} h`;

/** Local calendar date as YYYY-MM-DD (matches the server's business-TZ day semantics closely enough for defaults). */
function localIso(d: Date): string {
  return d.toLocaleDateString("en-CA");
}

/** "2025-06-02" -> "Jun 2" for chart axis ticks. */
function weekLabel(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d!)).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

const moneyChartConfig = {
  revenue: { label: "Revenue", color: "hsl(var(--chart-1))" },
  laborCost: { label: "Labor cost", color: "hsl(var(--chart-2))" },
} satisfies ChartConfig;

const hoursChartConfig = {
  hoursWorked: { label: "Hours worked", color: "hsl(var(--chart-3))" },
} satisfies ChartConfig;

function punctualityBadge(pct: number | null) {
  if (pct == null) {
    return <span className="text-muted-foreground">—</span>;
  }
  const cls =
    pct >= 95
      ? "bg-emerald-100 text-emerald-800"
      : pct >= 85
        ? "bg-amber-100 text-amber-800"
        : "bg-red-100 text-red-800";
  return (
    <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${cls}`}>
      {pct.toFixed(1)}%
    </span>
  );
}

function KpiCard({ label, value, sub, tone }: {
  label: string;
  value: string;
  sub?: string;
  tone?: "good" | "bad";
}) {
  return (
    <div className="rounded-lg border bg-card p-4 shadow-sm">
      <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className={`mt-1 flex items-center gap-1.5 text-2xl font-semibold ${
        tone === "good" ? "text-emerald-700" : tone === "bad" ? "text-red-700" : "text-foreground"
      }`}>
        {tone === "good" && <TrendingUp className="h-5 w-5" aria-hidden="true" />}
        {tone === "bad" && <TrendingDown className="h-5 w-5" aria-hidden="true" />}
        {value}
      </div>
      {sub && <div className="mt-1 text-xs text-muted-foreground">{sub}</div>}
    </div>
  );
}

export default function AnalyticsPage() {
  const today = useMemo(() => new Date(), []);
  const [start, setStart] = useState(() =>
    localIso(new Date(today.getTime() - 55 * 86_400_000)));
  const [end, setEnd] = useState(() => localIso(today));
  const [clientId, setClientId] = useState<string>("all");

  const [clients, setClients] = useState<ClientOption[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [officers, setOfficers] = useState<OfficerRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState<"csv" | "pdf" | null>(null);

  // --- archive state ---
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [archivedIds, setArchivedIds] = useState<Set<string>>(new Set());
  const [archiveDialog, setArchiveDialog] = useState<OfficerRow[] | null>(null);
  const [archiving, setArchiving] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [reactivatingId, setReactivatingId] = useState<string | null>(null);
  const { toast } = useToast();

  useEffect(() => {
    let cancelled = false;
    api<Array<{ id: string; name: string }>>("/clients")
      .then((rows) => {
        if (!cancelled) setClients(rows.map((r) => ({ id: r.id, name: r.name })));
      })
      .catch(() => { /* filter dropdown is best-effort; page still works */ });
    return () => { cancelled = true; };
  }, []);

  const rangeInvalid =
    !/^\d{4}-\d{2}-\d{2}$/.test(start) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(end) ||
    end < start;

  const query = useMemo(() => {
    const qs = new URLSearchParams({ start, end });
    if (clientId !== "all") qs.set("clientId", clientId);
    return qs.toString();
  }, [start, end, clientId]);

  useEffect(() => {
    if (rangeInvalid) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    Promise.all([
      api<Summary>(`/analytics/summary?${query}`),
      api<OfficerRow[]>(`/analytics/officers?${query}`),
    ])
      .then(([s, o]) => {
        if (cancelled) return;
        setSummary(s);
        setOfficers(o);
        setSelectedIds(new Set());
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : "Failed to load analytics.");
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [query, rangeInvalid]);

  const download = useCallback(async (format: "csv" | "pdf") => {
    setError(null);
    setDownloading(format);
    try {
      const body: Record<string, string> = { start, end };
      if (clientId !== "all") body.clientId = clientId;
      const res = await fetchWithAuth(`/api/admin/analytics/export-${format}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        let msg = `Download failed (${res.status})`;
        try {
          const j = await res.json();
          if (j?.message) msg = j.message;
          else if (j?.error) msg = j.error;
        } catch { /* not JSON */ }
        throw new ApiError(res.status, msg);
      }
      const blob = await res.blob();
      const disp = res.headers.get("Content-Disposition") ?? "";
      const m = /filename="?([^";]+)"?/.exec(disp);
      const filename = m?.[1] ?? `analytics-${start}-to-${end}.${format}`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Download failed.");
    } finally {
      setDownloading(null);
    }
  }, [start, end, clientId]);

  // --- archive helpers ---

  /** Call PUT /admin/tables/users/:id with status=inactive for each target. */
  async function archiveOfficers(targets: OfficerRow[]) {
    setArchiving(true);
    const results = await Promise.allSettled(
      targets.map((o) =>
        fetchWithAuth(`/api/admin/tables/users/${o.employeeId}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: "inactive" }),
        }).then(async (res) => {
          if (!res.ok) {
            let msg = `Failed (${res.status})`;
            try {
              const j = await res.json();
              if (j?.message) msg = j.message;
              else if (j?.error) msg = j.error;
            } catch { /* not JSON */ }
            throw new Error(msg);
          }
          return o.employeeId;
        }),
      ),
    );

    const succeeded: string[] = [];
    const failed: { name: string; reason: string }[] = [];

    results.forEach((r, i) => {
      if (r.status === "fulfilled") {
        succeeded.push(r.value);
      } else {
        failed.push({
          name: targets[i]!.name,
          reason: r.reason instanceof Error ? r.reason.message : String(r.reason),
        });
      }
    });

    if (succeeded.length > 0) {
      setArchivedIds((prev) => {
        const next = new Set(prev);
        succeeded.forEach((id) => next.add(id));
        return next;
      });
    }

    // Always clear the full selection after the operation so the user starts
    // fresh — even if some requests failed (the task spec: "clear selection
    // state after the operation").
    setSelectedIds(new Set());
    setArchiving(false);
    setArchiveDialog(null);

    if (failed.length === 0) {
      toast({
        title: succeeded.length === 1
          ? `${targets[0]!.name} archived`
          : `${succeeded.length} officers archived`,
        description: "Their accounts have been set to inactive.",
      });
    } else if (succeeded.length > 0) {
      toast({
        variant: "destructive",
        title: "Some archives failed",
        description: failed.map((f) => `${f.name}: ${f.reason}`).join(" · "),
      });
    } else {
      toast({
        variant: "destructive",
        title: "Archive failed",
        description: failed.map((f) => `${f.name}: ${f.reason}`).join(" · "),
      });
    }
  }

  /** Reactivate a single archived officer: PUT status=active, then un-gray the row. */
  async function reactivateOfficer(target: OfficerRow) {
    setReactivatingId(target.employeeId);
    try {
      const res = await fetchWithAuth(`/api/admin/tables/users/${target.employeeId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "active" }),
      });
      if (!res.ok) {
        let msg = `Failed (${res.status})`;
        try {
          const j = await res.json();
          if (j?.message) msg = j.message;
          else if (j?.error) msg = j.error;
        } catch { /* not JSON */ }
        throw new Error(msg);
      }
      setArchivedIds((prev) => {
        const next = new Set(prev);
        next.delete(target.employeeId);
        return next;
      });
      setOfficers((prev) =>
        prev.map((o) =>
          o.employeeId === target.employeeId ? { ...o, status: "active" } : o,
        ),
      );
      toast({
        title: `${target.name} reactivated`,
        description: "Their account has been set back to active.",
      });
    } catch (e) {
      toast({
        variant: "destructive",
        title: "Reactivate failed",
        description: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setReactivatingId(null);
    }
  }

  // An officer is "archived" if we archived them this session OR the server
  // says their account is inactive (covers archives from earlier sessions
  // within the date range).
  const isArchived = (o: OfficerRow) =>
    archivedIds.has(o.employeeId) || o.status === "inactive";

  const archivedCount = officers.filter(isArchived).length;
  const visibleOfficers = showArchived
    ? officers
    : officers.filter((o) => !isArchived(o));
  // Only non-archived rows are selectable / bulk-archivable.
  const allPageIds = visibleOfficers.filter((o) => !isArchived(o)).map((o) => o.employeeId);
  const allSelected =
    allPageIds.length > 0 && allPageIds.every((id) => selectedIds.has(id));
  const someSelected = allPageIds.some((id) => selectedIds.has(id));

  function toggleAll(checked: boolean) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (checked) {
        allPageIds.forEach((id) => next.add(id));
      } else {
        allPageIds.forEach((id) => next.delete(id));
      }
      return next;
    });
  }

  function toggleOne(id: string, checked: boolean) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  const selectedCount = allPageIds.filter((id) => selectedIds.has(id)).length;

  const moneyData = useMemo(
    () => (summary?.weeklyTrend ?? []).map((w) => ({ ...w, week: weekLabel(w.weekStart) })),
    [summary],
  );

  // Officers selected on this page (for bulk dialog)
  const selectedOfficers = visibleOfficers.filter((o) => selectedIds.has(o.employeeId));

  return (
    <div className="space-y-6 p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold text-foreground">
            <BarChart3 className="h-6 w-6 text-primary" aria-hidden="true" />
            Analytics
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Revenue, labor cost, coverage, and officer performance. Money figures follow
            the same rules as invoicing and payroll, including the 1.5&times; federal-holiday premium.
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            onClick={() => download("csv")}
            disabled={downloading !== null || rangeInvalid}
          >
            {downloading === "csv"
              ? <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
              : <Download className="mr-2 h-4 w-4" aria-hidden="true" />}
            Export CSV
          </Button>
          <Button
            variant="outline"
            onClick={() => download("pdf")}
            disabled={downloading !== null || rangeInvalid}
          >
            {downloading === "pdf"
              ? <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
              : <FileText className="mr-2 h-4 w-4" aria-hidden="true" />}
            Export PDF
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap items-end gap-4 rounded-lg border bg-card p-4 shadow-sm">
        <div className="grid gap-1.5">
          <Label htmlFor="analytics-start">From</Label>
          <Input
            id="analytics-start"
            type="date"
            value={start}
            onChange={(e) => setStart(e.target.value)}
            className="w-40"
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="analytics-end">To</Label>
          <Input
            id="analytics-end"
            type="date"
            value={end}
            onChange={(e) => setEnd(e.target.value)}
            className="w-40"
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="analytics-client">Client</Label>
          <Select value={clientId} onValueChange={setClientId}>
            <SelectTrigger id="analytics-client" className="w-56">
              <SelectValue placeholder="All clients" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All clients</SelectItem>
              {clients.map((c) => (
                <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {rangeInvalid && (
          <p className="text-sm text-red-700" role="alert">
            The end date must be on or after the start date.
          </p>
        )}
      </div>

      {error && (
        <div className="flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800" role="alert">
          <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
          {error}
        </div>
      )}

      {loading && !summary ? (
        <div className="flex items-center justify-center gap-2 py-16 text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin" aria-hidden="true" />
          Loading analytics…
        </div>
      ) : summary ? (
        <>
          <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-5">
            <KpiCard label="Revenue" value={fmtMoney(summary.revenue)} />
            <KpiCard label="Labor cost" value={fmtMoney(summary.laborCost)} />
            <KpiCard
              label="Profit / loss"
              value={fmtMoney(summary.pnl)}
              sub={summary.marginPct == null ? undefined : `${summary.marginPct.toFixed(1)}% margin`}
              tone={summary.pnl > 0 ? "good" : summary.pnl < 0 ? "bad" : undefined}
            />
            <KpiCard
              label="Hours worked"
              value={fmtHours(summary.hoursWorked)}
              sub={`${fmtHours(summary.hoursScheduled)} scheduled`}
            />
            <KpiCard label="Coverage" value={fmtPct(summary.coveragePct)} />
            <KpiCard label="No-shows" value={String(summary.noShows)} tone={summary.noShows > 0 ? "bad" : undefined} />
            <KpiCard label="Unfilled shifts" value={String(summary.unfilledShifts)} />
            <KpiCard
              label="Incidents"
              value={String(summary.incidents.total)}
              sub={`${summary.incidents.open} open · ${summary.incidents.critical} critical`}
            />
            <KpiCard
              label="Incident severity"
              value={`${summary.incidents.high + summary.incidents.critical} high+`}
              sub={`${summary.incidents.low} low · ${summary.incidents.medium} medium`}
            />
            <KpiCard
              label="Resolved incidents"
              value={String(summary.incidents.resolved)}
            />
          </div>

          <div className="grid gap-6 lg:grid-cols-2">
            <section className="rounded-lg border bg-card p-4 shadow-sm" aria-label="Weekly revenue and labor cost">
              <h2 className="text-sm font-semibold text-foreground">Revenue vs labor cost, by week</h2>
              {moneyData.length === 0 ? (
                <p className="py-10 text-center text-sm text-muted-foreground">No activity in this range.</p>
              ) : (
                <ChartContainer config={moneyChartConfig} className="mt-3 h-64 w-full">
                  <BarChart data={moneyData}>
                    <CartesianGrid vertical={false} strokeDasharray="3 3" />
                    <XAxis dataKey="week" tickLine={false} axisLine={false} fontSize={12} />
                    <YAxis tickLine={false} axisLine={false} fontSize={12}
                      tickFormatter={(v: number) => usd.format(v)} width={70} />
                    <ChartTooltip content={<ChartTooltipContent />} />
                    <Bar dataKey="revenue" fill="var(--color-revenue)" radius={[3, 3, 0, 0]} />
                    <Bar dataKey="laborCost" fill="var(--color-laborCost)" radius={[3, 3, 0, 0]} />
                  </BarChart>
                </ChartContainer>
              )}
            </section>

            <section className="rounded-lg border bg-card p-4 shadow-sm" aria-label="Weekly hours worked">
              <h2 className="text-sm font-semibold text-foreground">Hours worked, by week</h2>
              {moneyData.length === 0 ? (
                <p className="py-10 text-center text-sm text-muted-foreground">No activity in this range.</p>
              ) : (
                <ChartContainer config={hoursChartConfig} className="mt-3 h-64 w-full">
                  <LineChart data={moneyData}>
                    <CartesianGrid vertical={false} strokeDasharray="3 3" />
                    <XAxis dataKey="week" tickLine={false} axisLine={false} fontSize={12} />
                    <YAxis tickLine={false} axisLine={false} fontSize={12} width={50} />
                    <ChartTooltip content={<ChartTooltipContent />} />
                    <Line
                      type="monotone"
                      dataKey="hoursWorked"
                      stroke="var(--color-hoursWorked)"
                      strokeWidth={2}
                      dot={false}
                    />
                  </LineChart>
                </ChartContainer>
              )}
            </section>
          </div>

          <section className="rounded-lg border bg-card shadow-sm" aria-label="Site performance">
            <h2 className="border-b px-4 py-3 text-sm font-semibold text-foreground">Sites</h2>
            {summary.sites.length === 0 ? (
              <p className="p-6 text-center text-sm text-muted-foreground">No site activity in this range.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                      <th scope="col" className="px-4 py-2 font-medium">Site</th>
                      <th scope="col" className="px-4 py-2 font-medium">Client</th>
                      <th scope="col" className="px-4 py-2 text-right font-medium">Revenue</th>
                      <th scope="col" className="px-4 py-2 text-right font-medium">Labor cost</th>
                      <th scope="col" className="px-4 py-2 text-right font-medium">P&amp;L</th>
                      <th scope="col" className="px-4 py-2 text-right font-medium">Hours</th>
                      <th scope="col" className="px-4 py-2 text-right font-medium">Coverage</th>
                    </tr>
                  </thead>
                  <tbody>
                    {summary.sites.map((s) => (
                      <tr key={s.siteId} className="border-b last:border-0 hover:bg-muted/40">
                        <td className="px-4 py-2 font-medium text-foreground">{s.siteName}</td>
                        <td className="px-4 py-2 text-muted-foreground">{s.clientName ?? "—"}</td>
                        <td className="px-4 py-2 text-right">{fmtMoney(s.revenue)}</td>
                        <td className="px-4 py-2 text-right">{fmtMoney(s.laborCost)}</td>
                        <td className={`px-4 py-2 text-right font-medium ${
                          s.pnl > 0 ? "text-emerald-700" : s.pnl < 0 ? "text-red-700" : ""
                        }`}>{fmtMoney(s.pnl)}</td>
                        <td className="px-4 py-2 text-right">{s.hoursWorked.toFixed(1)}</td>
                        <td className="px-4 py-2 text-right">{fmtPct(s.coveragePct)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className="rounded-lg border bg-card shadow-sm" aria-label="Officer performance">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
              <h2 className="text-sm font-semibold text-foreground">Officer performance</h2>
              <div className="flex items-center gap-4">
                <div className="flex items-center gap-2">
                  <Checkbox
                    id="show-archived"
                    checked={showArchived}
                    onCheckedChange={(v) => setShowArchived(v === true)}
                  />
                  <Label htmlFor="show-archived" className="cursor-pointer text-xs font-normal text-muted-foreground">
                    Show archived{archivedCount > 0 ? ` (${archivedCount})` : ""}
                  </Label>
                </div>
                {selectedCount > 0 && (
                  <Button
                    size="sm"
                    variant="destructive"
                    onClick={() => setArchiveDialog(selectedOfficers)}
                    disabled={archiving}
                  >
                    <Archive className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
                    Archive selected ({selectedCount})
                  </Button>
                )}
              </div>
            </div>
            {visibleOfficers.length === 0 && officers.length === 0 ? (
              <p className="p-6 text-center text-sm text-muted-foreground">No officer activity in this range.</p>
            ) : visibleOfficers.length === 0 ? (
              <p className="p-6 text-center text-sm text-muted-foreground">All officers in this range have been archived.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                      <th scope="col" className="w-10 px-4 py-2">
                        <Checkbox
                          checked={someSelected && !allSelected ? "indeterminate" : allSelected}
                          onCheckedChange={(v) => toggleAll(v === true)}
                          aria-label="Select all officers"
                        />
                      </th>
                      <th scope="col" className="px-4 py-2 font-medium">Officer</th>
                      <th scope="col" className="px-4 py-2 text-right font-medium">Hours worked</th>
                      <th scope="col" className="px-4 py-2 text-right font-medium">Shifts completed</th>
                      <th scope="col" className="px-4 py-2 text-right font-medium">Incidents filed</th>
                      <th scope="col" className="px-4 py-2 text-right font-medium">Punctuality</th>
                      <th scope="col" className="w-16 px-4 py-2" aria-label="Actions" />
                    </tr>
                  </thead>
                  <tbody>
                    {visibleOfficers.map((o) => {
                      const archived = isArchived(o);
                      const isSelected = !archived && selectedIds.has(o.employeeId);
                      return (
                        <tr
                          key={o.employeeId}
                          className={`border-b last:border-0 hover:bg-muted/40 ${isSelected ? "bg-muted/20" : ""}`}
                        >
                          <td className="px-4 py-2">
                            <Checkbox
                              checked={isSelected}
                              onCheckedChange={(v) => toggleOne(o.employeeId, !!v)}
                              disabled={archived}
                              aria-label={`Select ${o.name}`}
                            />
                          </td>
                          <td className={`px-4 py-2 font-medium ${archived ? "text-muted-foreground" : "text-foreground"}`}>
                            {o.name}
                            {archived && (
                              <span className="ml-2 inline-block rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
                                Archived
                              </span>
                            )}
                          </td>
                          <td className={`px-4 py-2 text-right ${archived ? "text-muted-foreground" : ""}`}>{o.hoursWorked.toFixed(1)}</td>
                          <td className={`px-4 py-2 text-right ${archived ? "text-muted-foreground" : ""}`}>{o.shiftsCompleted}</td>
                          <td className={`px-4 py-2 text-right ${archived ? "text-muted-foreground" : ""}`}>{o.incidentsFiled}</td>
                          <td className="px-4 py-2 text-right">{punctualityBadge(o.punctualityPct)}</td>
                          <td className="px-4 py-2 text-right">
                            {archived ? (
                              <Button
                                size="sm"
                                variant="outline"
                                className="h-7"
                                onClick={() => reactivateOfficer(o)}
                                disabled={reactivatingId !== null}
                                aria-label={`Reactivate ${o.name}`}
                              >
                                {reactivatingId === o.employeeId ? (
                                  <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                                ) : (
                                  <ArchiveRestore className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
                                )}
                                Reactivate
                              </Button>
                            ) : (
                              <Button
                                size="sm"
                                variant="ghost"
                                className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
                                onClick={() => setArchiveDialog([o])}
                                disabled={archiving}
                                aria-label={`Archive ${o.name}`}
                              >
                                <Archive className="h-3.5 w-3.5" aria-hidden="true" />
                              </Button>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
            <p className="border-t px-4 py-2 text-xs text-muted-foreground">
              Punctuality counts a clock-in as on time when it is within 5 minutes after the
              scheduled start. Officers with no scheduled shifts in the range show &mdash;.
            </p>
          </section>
        </>
      ) : null}

      {/* Archive confirmation dialog */}
      <AlertDialog open={archiveDialog !== null} onOpenChange={(open) => { if (!open && !archiving) setArchiveDialog(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {archiveDialog?.length === 1
                ? `Archive ${archiveDialog[0]!.name}?`
                : `Archive ${archiveDialog?.length ?? 0} officers?`}
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div>
                {archiveDialog && archiveDialog.length === 1 ? (
                  <p>
                    This will set <strong>{archiveDialog[0]!.name}</strong>'s account to inactive.
                    They will no longer be able to sign in. You can reactivate them from the Personnel grid.
                  </p>
                ) : (
                  <>
                    <p className="mb-2">
                      This will set the following officers' accounts to inactive.
                      They will no longer be able to sign in.
                    </p>
                    <ul className="max-h-40 overflow-y-auto rounded border bg-muted/50 px-3 py-2 text-sm">
                      {archiveDialog?.map((o) => (
                        <li key={o.employeeId} className="py-0.5">{o.name}</li>
                      ))}
                    </ul>
                    <p className="mt-2 text-xs text-muted-foreground">
                      You can reactivate them from the Personnel grid.
                    </p>
                  </>
                )}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={archiving}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                if (archiveDialog) archiveOfficers(archiveDialog);
              }}
              disabled={archiving}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {archiving ? (
                <><Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />Archiving…</>
              ) : (
                "Archive"
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
