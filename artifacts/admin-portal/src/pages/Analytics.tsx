import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  BarChart, Bar, AreaChart, Area, LineChart, Line,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from "recharts";
import {
  DollarSign, TrendingUp, TrendingDown, Users, Clock,
  AlertTriangle, Calendar, ChevronDown, ChevronUp, Loader2,
  UserCheck, Download, FileText,
} from "lucide-react";
import { Link } from "wouter";
import { getGetAnalyticsSummaryQueryOptions, useGetClients } from "@workspace/api-client-react";
import { fetchWithAuth } from "@/lib/api";
import { Button } from "@/components/ui/button";
import {
  Select, SelectTrigger, SelectValue, SelectContent, SelectItem,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";

// ── Utilities ────────────────────────────────────────────────────────────────

function fmtUSD(n: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(n);
}

function fmtPct(n: number): string {
  return `${n.toFixed(1)}%`;
}

function fmtHours(n: number): string {
  return `${n.toFixed(1)} h`;
}

function toIsoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function startOfWeek(d: Date): Date {
  const dow = (d.getDay() + 6) % 7; // Mon=0
  const mon = new Date(d);
  mon.setDate(d.getDate() - dow);
  mon.setHours(0, 0, 0, 0);
  return mon;
}

function endOfWeek(d: Date): Date {
  const sun = new Date(startOfWeek(d));
  sun.setDate(sun.getDate() + 6);
  sun.setHours(23, 59, 59, 999);
  return sun;
}

function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

/** Filesystem-safe slug for a client name — mirrors the server's filename logic. */
function clientFileSlug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "client"
  );
}

// ── Date Presets ──────────────────────────────────────────────────────────────

type Preset = "this-week" | "last-week" | "mtd" | "last-30" | "custom";

function presetRange(p: Preset): { start: string; end: string } {
  const today = new Date();
  switch (p) {
    case "this-week":
      return { start: toIsoDate(startOfWeek(today)), end: toIsoDate(today) };
    case "last-week": {
      const thisMonday = startOfWeek(today);
      const lastMonday = new Date(thisMonday);
      lastMonday.setDate(thisMonday.getDate() - 7);
      const lastSunday = endOfWeek(lastMonday);
      return { start: toIsoDate(lastMonday), end: toIsoDate(lastSunday) };
    }
    case "mtd":
      return { start: toIsoDate(startOfMonth(today)), end: toIsoDate(today) };
    case "last-30": {
      const ago = new Date(today);
      ago.setDate(today.getDate() - 29);
      return { start: toIsoDate(ago), end: toIsoDate(today) };
    }
    default:
      return { start: toIsoDate(today), end: toIsoDate(today) };
  }
}

// ── Metric card ───────────────────────────────────────────────────────────────

function MetricCard({
  label, value, sub, icon: Icon, colorClass = "text-foreground",
}: {
  label: string;
  value: string;
  sub?: string;
  icon: React.ComponentType<{ className?: string }>;
  colorClass?: string;
}) {
  return (
    <div className="border rounded-lg bg-card p-4 flex flex-col gap-1">
      <div className="flex items-center justify-between">
        <span className="text-xs text-muted-foreground font-medium uppercase tracking-wide">{label}</span>
        <Icon className="w-4 h-4 text-muted-foreground" />
      </div>
      <div className={`text-2xl font-bold ${colorClass}`}>{value}</div>
      {sub && <div className="text-xs text-muted-foreground">{sub}</div>}
    </div>
  );
}

// ── Section header ────────────────────────────────────────────────────────────

function SectionHeader({ title, sub }: { title: string; sub?: string }) {
  return (
    <div className="mb-3">
      <h2 className="text-base font-semibold">{title}</h2>
      {sub && <p className="text-xs text-muted-foreground">{sub}</p>}
    </div>
  );
}

// ── Severity badge ────────────────────────────────────────────────────────────

const SEVERITY_COLORS: Record<string, string> = {
  low: "bg-blue-100 text-blue-800",
  medium: "bg-amber-100 text-amber-800",
  high: "bg-orange-100 text-orange-800",
  critical: "bg-red-100 text-red-800",
};

// ── Main component ────────────────────────────────────────────────────────────

type SortCol = "siteName" | "revenue" | "laborCost" | "profit" | "hoursWorked" | "hoursScheduled" | "noShows" | "unfilledShifts" | "incidents";
type OfficerSortCol = "name" | "shiftsAssigned" | "shiftsCompleted" | "noShows" | "attendanceRate" | "onTimeRate" | "avgMinutesLate" | "hoursWorked" | "hoursScheduled" | "rejectedEntries" | "rejectionRate" | "incidentTotal" | "reliabilityScore";

export default function AnalyticsPage() {
  const [preset, setPreset] = useState<Preset>("last-30");
  const [customStart, setCustomStart] = useState("");
  const [customEnd, setCustomEnd] = useState("");
  const [clientId, setClientId] = useState<string>("all");
  const [showMissed, setShowMissed] = useState(false);
  const [sortCol, setSortCol] = useState<SortCol>("revenue");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [officerSortCol, setOfficerSortCol] = useState<OfficerSortCol>("reliabilityScore");
  const [officerSortDir, setOfficerSortDir] = useState<"asc" | "desc">("desc");

  const { start, end } = useMemo(() => {
    if (preset === "custom" && customStart && customEnd) {
      return { start: customStart, end: customEnd };
    }
    if (preset === "custom") return { start: "", end: "" };
    return presetRange(preset);
  }, [preset, customStart, customEnd]);

  const enabled = Boolean(start && end && start <= end);

  const { data: clients } = useGetClients();
  const selectedClient = useMemo(
    () => (clientId === "all" ? null : clients?.find((c) => c.id === clientId) ?? null),
    [clientId, clients],
  );

  const { data, isLoading, isError } = useQuery({
    ...getGetAnalyticsSummaryQueryOptions({
      start,
      end,
      ...(clientId !== "all" ? { clientId } : {}),
    }),
    enabled,
    staleTime: 60_000,
  });

  // ── Export (CSV / PDF) ──────────────────────────────────────────────
  const [exporting, setExporting] = useState<"csv" | "pdf" | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);

  const handleExport = async (kind: "csv" | "pdf") => {
    if (!enabled || exporting) return;
    setExporting(kind);
    setExportError(null);
    try {
      const params = new URLSearchParams({ start, end });
      if (clientId !== "all") params.set("clientId", clientId);
      const res = await fetchWithAuth(`/api/analytics/export.${kind}?${params}`);
      if (!res.ok) {
        throw new Error(`Export failed (${res.status})`);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      const clientPart = selectedClient ? `-${clientFileSlug(selectedClient.name)}` : "";
      a.download = `wcsg-analytics${clientPart}-${start}_${end}.${kind}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      setExportError((e as Error).message || "Export failed. Please try again.");
    } finally {
      setExporting(null);
    }
  };

  // Per-site table sorting
  const sortedSites = useMemo(() => {
    if (!data?.perSite) return [];
    const arr = [...data.perSite];
    arr.sort((a, b) => {
      const av = a[sortCol] ?? 0;
      const bv = b[sortCol] ?? 0;
      const cmp = typeof av === "string" ? av.localeCompare(bv as string) : (Number(av) - Number(bv));
      return sortDir === "asc" ? cmp : -cmp;
    });
    return arr;
  }, [data?.perSite, sortCol, sortDir]);

  // Per-officer table sorting
  const sortedOfficers = useMemo(() => {
    if (!data?.perOfficer) return [];
    const arr = [...data.perOfficer];
    arr.sort((a, b) => {
      let av: string | number;
      let bv: string | number;
      if (officerSortCol === "name") {
        av = `${a.lastName} ${a.firstName}`;
        bv = `${b.lastName} ${b.firstName}`;
      } else {
        av = a[officerSortCol] ?? 0;
        bv = b[officerSortCol] ?? 0;
      }
      const cmp = typeof av === "string" ? av.localeCompare(bv as string) : (Number(av) - Number(bv));
      return officerSortDir === "asc" ? cmp : -cmp;
    });
    return arr;
  }, [data?.perOfficer, officerSortCol, officerSortDir]);

  const handleSort = (col: SortCol) => {
    if (col === sortCol) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortCol(col);
      setSortDir("desc");
    }
  };

  const handleOfficerSort = (col: OfficerSortCol) => {
    if (col === officerSortCol) {
      setOfficerSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setOfficerSortCol(col);
      setOfficerSortDir("desc");
    }
  };

  const SortIcon = ({ col }: { col: SortCol }) => {
    if (col !== sortCol) return null;
    return sortDir === "asc" ? <ChevronUp className="w-3 h-3 inline ml-0.5" /> : <ChevronDown className="w-3 h-3 inline ml-0.5" />;
  };

  const OfficerSortIcon = ({ col }: { col: OfficerSortCol }) => {
    if (col !== officerSortCol) return null;
    return officerSortDir === "asc" ? <ChevronUp className="w-3 h-3 inline ml-0.5" /> : <ChevronDown className="w-3 h-3 inline ml-0.5" />;
  };

  const thCls = (col: SortCol) =>
    `cursor-pointer select-none hover:text-foreground transition-colors whitespace-nowrap ${col === sortCol ? "text-foreground font-semibold" : ""}`;

  const officerThCls = (col: OfficerSortCol) =>
    `cursor-pointer select-none hover:text-foreground transition-colors whitespace-nowrap ${col === officerSortCol ? "text-foreground font-semibold" : ""}`;

  return (
    <div className="flex flex-col gap-6 p-4 sm:p-6 max-w-[1400px] mx-auto w-full">
      {/* Page header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold">Analytics</h1>
          <p className="text-sm text-muted-foreground">P&amp;L, hours, missed shifts &amp; incidents — admin only</p>
        </div>

        {/* Date range controls */}
        <div className="flex flex-wrap items-end gap-2">
          <div>
            <Label className="text-xs mb-1 block">Client</Label>
            <Select value={clientId} onValueChange={setClientId}>
              <SelectTrigger className="h-8 text-xs w-40" aria-label="Filter analytics by client">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All clients</SelectItem>
                {(clients ?? []).map((c) => (
                  <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label className="text-xs mb-1 block">Period</Label>
            <Select value={preset} onValueChange={(v) => setPreset(v as Preset)}>
              <SelectTrigger className="h-8 text-xs w-36">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="this-week">This week</SelectItem>
                <SelectItem value="last-week">Last week</SelectItem>
                <SelectItem value="mtd">Month to date</SelectItem>
                <SelectItem value="last-30">Last 30 days</SelectItem>
                <SelectItem value="custom">Custom range</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {preset === "custom" && (
            <>
              <div>
                <Label className="text-xs mb-1 block">From</Label>
                <Input
                  type="date"
                  className="h-8 text-xs w-36"
                  value={customStart}
                  onChange={(e) => setCustomStart(e.target.value)}
                />
              </div>
              <div>
                <Label className="text-xs mb-1 block">To</Label>
                <Input
                  type="date"
                  className="h-8 text-xs w-36"
                  value={customEnd}
                  onChange={(e) => setCustomEnd(e.target.value)}
                />
              </div>
            </>
          )}
          {enabled && (
            <div className="text-xs text-muted-foreground self-end pb-1.5">
              {start} → {end}
            </div>
          )}
          <div className="flex items-end gap-2">
            <Button
              variant="outline"
              size="sm"
              className="h-8 text-xs"
              disabled={!enabled || exporting !== null}
              onClick={() => void handleExport("csv")}
              aria-label="Export analytics report as CSV"
            >
              {exporting === "csv" ? (
                <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
              ) : (
                <Download className="w-3.5 h-3.5 mr-1.5" />
              )}
              Export CSV
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-8 text-xs"
              disabled={!enabled || exporting !== null}
              onClick={() => void handleExport("pdf")}
              aria-label="Export analytics report as PDF"
            >
              {exporting === "pdf" ? (
                <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
              ) : (
                <FileText className="w-3.5 h-3.5 mr-1.5" />
              )}
              Export PDF
            </Button>
          </div>
        </div>
      </div>

      {exportError && (
        <div className="text-sm text-destructive" role="alert">
          {exportError}
        </div>
      )}

      {/* Loading / error states */}
      {!enabled && (
        <div className="flex items-center justify-center h-40 text-muted-foreground text-sm">
          Select a valid date range to load analytics.
        </div>
      )}

      {enabled && isLoading && (
        <div className="flex items-center justify-center h-40 gap-2 text-muted-foreground text-sm">
          <Loader2 className="w-4 h-4 animate-spin" />
          Loading analytics…
        </div>
      )}

      {enabled && isError && (
        <div className="flex items-center justify-center h-40 text-destructive text-sm">
          Failed to load analytics. Please try again.
        </div>
      )}

      {enabled && data && (
        <>
          {/* ── P&L cards ─────────────────────────────────────────── */}
          <section aria-label="Profit and loss summary">
            <SectionHeader title="Profit &amp; Loss" sub="Revenue from invoiced work vs. 1099 labor cost (no tax withheld)" />
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <MetricCard label="Revenue" value={fmtUSD(data.revenue)} icon={DollarSign} />
              <MetricCard label="Labor Cost" value={fmtUSD(data.laborCost)} icon={DollarSign} />
              <MetricCard
                label="Profit"
                value={fmtUSD(data.profit)}
                icon={data.profit >= 0 ? TrendingUp : TrendingDown}
                colorClass={data.profit >= 0 ? "text-green-600" : "text-red-600"}
              />
              <MetricCard
                label="Margin"
                value={fmtPct(data.marginPct)}
                sub={data.revenue > 0 ? undefined : "No revenue in period"}
                icon={TrendingUp}
                colorClass={data.marginPct >= 0 ? "text-green-600" : "text-red-600"}
              />
            </div>

            {data.pnlTrend.length > 0 && (
              <div className="border rounded-lg bg-card p-4 mt-3" style={{ height: 220 }}>
                <p className="text-xs text-muted-foreground mb-2">Weekly P&amp;L trend</p>
                <ResponsiveContainer width="100%" height="85%">
                  <BarChart data={data.pnlTrend} margin={{ top: 4, right: 8, left: 8, bottom: 4 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                    <XAxis dataKey="bucket" tick={{ fontSize: 10 }} />
                    <YAxis tick={{ fontSize: 10 }} tickFormatter={(v) => `$${Math.round(v / 1000)}k`} />
                    <Tooltip
                      formatter={(v: number) => fmtUSD(v)}
                      labelStyle={{ fontWeight: 600 }}
                    />
                    <Legend wrapperStyle={{ fontSize: 11 }} />
                    <Bar dataKey="revenue" name="Revenue" fill="#c9a84c" radius={[2, 2, 0, 0]} />
                    <Bar dataKey="laborCost" name="Labor Cost" fill="#6b7280" radius={[2, 2, 0, 0]} />
                    <Bar dataKey="profit" name="Profit" fill="#16a34a" radius={[2, 2, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}
          </section>

          {/* ── Hours ──────────────────────────────────────────────── */}
          <section aria-label="Hours summary">
            <SectionHeader title="Hours Worked vs. Scheduled" />
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
              <MetricCard label="Hours Worked" value={fmtHours(data.hoursWorked)} icon={Clock} sub="Approved time entries" />
              <MetricCard label="Hours Scheduled" value={fmtHours(data.hoursScheduled)} icon={Calendar} sub="Past shifts × headcount" />
              <MetricCard
                label="Coverage"
                value={fmtPct(data.coveragePct)}
                icon={Users}
                colorClass={data.coveragePct >= 90 ? "text-green-600" : data.coveragePct >= 70 ? "text-amber-600" : "text-red-600"}
                sub={data.hoursScheduled > 0 ? "Worked ÷ Scheduled" : "No shifts in period"}
              />
            </div>

            {data.hoursTrend.length > 0 && (
              <div className="border rounded-lg bg-card p-4 mt-3" style={{ height: 220 }}>
                <p className="text-xs text-muted-foreground mb-2">Weekly hours trend</p>
                <ResponsiveContainer width="100%" height="85%">
                  <AreaChart data={data.hoursTrend} margin={{ top: 4, right: 8, left: 8, bottom: 4 }}>
                    <defs>
                      <linearGradient id="colorWorked" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#c9a84c" stopOpacity={0.3} />
                        <stop offset="95%" stopColor="#c9a84c" stopOpacity={0} />
                      </linearGradient>
                      <linearGradient id="colorSched" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#6b7280" stopOpacity={0.2} />
                        <stop offset="95%" stopColor="#6b7280" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                    <XAxis dataKey="bucket" tick={{ fontSize: 10 }} />
                    <YAxis tick={{ fontSize: 10 }} tickFormatter={(v) => `${v}h`} />
                    <Tooltip
                      formatter={(v: number) => fmtHours(v)}
                      labelStyle={{ fontWeight: 600 }}
                    />
                    <Legend wrapperStyle={{ fontSize: 11 }} />
                    <Area dataKey="scheduled" name="Scheduled" stroke="#6b7280" fill="url(#colorSched)" strokeWidth={1.5} dot={false} />
                    <Area dataKey="worked" name="Worked" stroke="#c9a84c" fill="url(#colorWorked)" strokeWidth={2} dot={false} />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            )}
          </section>

          {/* ── Missed shifts ──────────────────────────────────────── */}
          <section aria-label="Missed shifts">
            <SectionHeader title="Missed Shifts" sub="No-shows: assigned officer never clocked in. Unfilled: fewer assignees than headcount." />
            <div className="grid grid-cols-2 gap-3">
              <MetricCard
                label="No-Shows"
                value={String(data.noShowCount)}
                icon={AlertTriangle}
                colorClass={data.noShowCount > 0 ? "text-amber-600" : "text-green-600"}
                sub="Accepted but never clocked in"
              />
              <MetricCard
                label="Unfilled Shifts"
                value={String(data.unfilledCount)}
                icon={Users}
                colorClass={data.unfilledCount > 0 ? "text-amber-600" : "text-green-600"}
                sub="Ended with fewer than headcount"
              />
            </div>

            {data.missedShifts.length > 0 && (
              <div className="border rounded-lg bg-card mt-3">
                <button
                  type="button"
                  onClick={() => setShowMissed((v) => !v)}
                  className="w-full flex items-center justify-between px-4 py-3 text-sm font-medium hover:bg-muted/40 transition-colors rounded-lg"
                  aria-expanded={showMissed}
                >
                  <span>View affected shifts ({data.missedShifts.length})</span>
                  {showMissed ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                </button>
                {showMissed && (
                  <div className="px-4 pb-4 overflow-x-auto">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Shift</TableHead>
                          <TableHead>Site</TableHead>
                          <TableHead>Date</TableHead>
                          <TableHead className="text-right">Headcount</TableHead>
                          <TableHead className="text-right">Filled</TableHead>
                          <TableHead className="text-right">No-Shows</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {data.missedShifts.map((s) => (
                          <TableRow key={s.shiftId}>
                            <TableCell className="font-medium">{s.title}</TableCell>
                            <TableCell className="text-muted-foreground">{s.siteName ?? "—"}</TableCell>
                            <TableCell className="text-muted-foreground text-xs">
                              {new Date(s.startTime).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}
                              {" "}
                              {new Date(s.startTime).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}
                            </TableCell>
                            <TableCell className="text-right">{s.headcount}</TableCell>
                            <TableCell className="text-right">
                              <span className={s.filled < s.headcount ? "text-amber-600 font-semibold" : "text-green-600"}>
                                {s.filled}
                              </span>
                            </TableCell>
                            <TableCell className="text-right">
                              {s.noShows > 0 ? (
                                <Badge className="bg-amber-100 text-amber-800 hover:bg-amber-100">{s.noShows}</Badge>
                              ) : (
                                <span className="text-muted-foreground">0</span>
                              )}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                )}
              </div>
            )}
          </section>

          {/* ── Incidents ──────────────────────────────────────────── */}
          <section aria-label="Incident metrics">
            <SectionHeader title="Incidents" sub={`${data.incidentTotal} incident${data.incidentTotal === 1 ? "" : "s"} in period`} />
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              {(["low", "medium", "high", "critical"] as const).map((sev) => (
                <div key={sev} className="border rounded-lg bg-card p-3 flex flex-col gap-1">
                  <span className="text-xs text-muted-foreground uppercase tracking-wide">{sev}</span>
                  <div className="flex items-center gap-2">
                    <span className="text-2xl font-bold">{data.incidentsBySeverity[sev]}</span>
                    {data.incidentsBySeverity[sev] > 0 && (
                      <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-semibold ${SEVERITY_COLORS[sev]}`}>
                        {sev}
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </div>
            <div className="grid grid-cols-3 gap-3 mt-3">
              {(["open", "investigating", "closed"] as const).map((st) => (
                <div key={st} className="border rounded-lg bg-card p-3">
                  <div className="text-xs text-muted-foreground uppercase tracking-wide mb-1">{st}</div>
                  <div className="text-xl font-bold">{data.incidentsByStatus[st]}</div>
                </div>
              ))}
            </div>

            {data.incidentTrend.length > 0 && (
              <div className="border rounded-lg bg-card p-4 mt-3" style={{ height: 200 }}>
                <p className="text-xs text-muted-foreground mb-2">Weekly incident trend</p>
                <ResponsiveContainer width="100%" height="85%">
                  <LineChart data={data.incidentTrend} margin={{ top: 4, right: 8, left: 8, bottom: 4 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                    <XAxis dataKey="bucket" tick={{ fontSize: 10 }} />
                    <YAxis allowDecimals={false} tick={{ fontSize: 10 }} />
                    <Tooltip labelStyle={{ fontWeight: 600 }} />
                    <Line dataKey="count" name="Incidents" stroke="#dc2626" strokeWidth={2} dot={{ r: 3 }} activeDot={{ r: 5 }} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            )}
          </section>

          {/* ── Per-site breakdown ─────────────────────────────────── */}
          {sortedSites.length > 0 && (
            <section aria-label="Per-site breakdown">
              <SectionHeader title="Per-Site Breakdown" sub="Click column headers to sort" />
              <div className="border rounded-lg bg-card overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className={thCls("siteName")} onClick={() => handleSort("siteName")}>
                        Site <SortIcon col="siteName" />
                      </TableHead>
                      <TableHead className={`text-right ${thCls("revenue")}`} onClick={() => handleSort("revenue")}>
                        Revenue <SortIcon col="revenue" />
                      </TableHead>
                      <TableHead className={`text-right ${thCls("laborCost")}`} onClick={() => handleSort("laborCost")}>
                        Labor Cost <SortIcon col="laborCost" />
                      </TableHead>
                      <TableHead className={`text-right ${thCls("profit")}`} onClick={() => handleSort("profit")}>
                        Profit <SortIcon col="profit" />
                      </TableHead>

                      <TableHead className={`text-right ${thCls("hoursWorked")}`} onClick={() => handleSort("hoursWorked")}>
                        Hrs Worked <SortIcon col="hoursWorked" />
                      </TableHead>
                      <TableHead className={`text-right ${thCls("hoursScheduled")}`} onClick={() => handleSort("hoursScheduled")}>
                        Hrs Sched. <SortIcon col="hoursScheduled" />
                      </TableHead>
                      <TableHead className={`text-right ${thCls("noShows")}`} onClick={() => handleSort("noShows")}>
                        No-Shows <SortIcon col="noShows" />
                      </TableHead>
                      <TableHead className={`text-right ${thCls("unfilledShifts")}`} onClick={() => handleSort("unfilledShifts")}>
                        Unfilled <SortIcon col="unfilledShifts" />
                      </TableHead>
                      <TableHead className={`text-right ${thCls("incidents")}`} onClick={() => handleSort("incidents")}>
                        Incidents <SortIcon col="incidents" />
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {sortedSites.map((s) => (
                      <TableRow key={s.siteId}>
                        <TableCell className="font-medium">{s.siteName}</TableCell>
                        <TableCell className="text-right">{fmtUSD(s.revenue)}</TableCell>
                        <TableCell className="text-right">{fmtUSD(s.laborCost)}</TableCell>
                        <TableCell className={`text-right font-semibold ${s.profit >= 0 ? "text-green-600" : "text-red-600"}`}>
                          {fmtUSD(s.profit)}
                        </TableCell>
                        <TableCell className="text-right">{fmtHours(s.hoursWorked)}</TableCell>
                        <TableCell className="text-right">{fmtHours(s.hoursScheduled)}</TableCell>
                        <TableCell className={`text-right ${s.noShows > 0 ? "text-amber-600 font-semibold" : "text-muted-foreground"}`}>
                          {s.noShows}
                        </TableCell>
                        <TableCell className={`text-right ${s.unfilledShifts > 0 ? "text-amber-600 font-semibold" : "text-muted-foreground"}`}>
                          {s.unfilledShifts}
                        </TableCell>
                        <TableCell className={`text-right ${s.incidents > 0 ? "font-semibold" : "text-muted-foreground"}`}>
                          {s.incidents}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </section>
          )}

          {/* ── Officer Performance ─────────────────────────────────── */}
          <section aria-label="Officer performance">
            <SectionHeader
              title="Officer Performance"
              sub={
                sortedOfficers.length === 0
                  ? "No officer activity in this period"
                  : `${sortedOfficers.length} officer${sortedOfficers.length === 1 ? "" : "s"} active · click column headers to sort · reliability = 60% attendance + 40% punctuality`
              }
            />

            {/* Summary strip */}
            {data.officerSummary && sortedOfficers.length > 0 && (
              <div className="grid grid-cols-3 gap-3 mb-3">
                <MetricCard
                  label="Total No-Shows"
                  value={String(data.officerSummary.totalNoShows)}
                  icon={AlertTriangle}
                  colorClass={data.officerSummary.totalNoShows > 0 ? "text-amber-600" : "text-green-600"}
                  sub="Accepted but never clocked in"
                />
                <MetricCard
                  label="Avg Attendance Rate"
                  value={fmtPct(data.officerSummary.avgAttendanceRate)}
                  icon={UserCheck}
                  colorClass={
                    data.officerSummary.avgAttendanceRate >= 95
                      ? "text-green-600"
                      : data.officerSummary.avgAttendanceRate >= 80
                        ? "text-amber-600"
                        : "text-red-600"
                  }
                  sub="Across all active officers"
                />
                <MetricCard
                  label="Avg On-Time Rate"
                  value={fmtPct(data.officerSummary.avgOnTimeRate)}
                  icon={Clock}
                  colorClass={
                    data.officerSummary.avgOnTimeRate >= 90
                      ? "text-green-600"
                      : data.officerSummary.avgOnTimeRate >= 70
                        ? "text-amber-600"
                        : "text-red-600"
                  }
                  sub="5-minute grace window"
                />
              </div>
            )}

            {sortedOfficers.length > 0 && (
              <div className="border rounded-lg bg-card overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className={officerThCls("name")} onClick={() => handleOfficerSort("name")}>
                        Officer <OfficerSortIcon col="name" />
                      </TableHead>
                      <TableHead className={`text-right ${officerThCls("reliabilityScore")}`} onClick={() => handleOfficerSort("reliabilityScore")}>
                        Reliability <OfficerSortIcon col="reliabilityScore" />
                      </TableHead>
                      <TableHead className={`text-right ${officerThCls("shiftsAssigned")}`} onClick={() => handleOfficerSort("shiftsAssigned")}>
                        Assigned <OfficerSortIcon col="shiftsAssigned" />
                      </TableHead>
                      <TableHead className={`text-right ${officerThCls("shiftsCompleted")}`} onClick={() => handleOfficerSort("shiftsCompleted")}>
                        Completed <OfficerSortIcon col="shiftsCompleted" />
                      </TableHead>
                      <TableHead className={`text-right ${officerThCls("noShows")}`} onClick={() => handleOfficerSort("noShows")}>
                        No-Shows <OfficerSortIcon col="noShows" />
                      </TableHead>
                      <TableHead className={`text-right ${officerThCls("attendanceRate")}`} onClick={() => handleOfficerSort("attendanceRate")}>
                        Attendance <OfficerSortIcon col="attendanceRate" />
                      </TableHead>
                      <TableHead className={`text-right ${officerThCls("onTimeRate")}`} onClick={() => handleOfficerSort("onTimeRate")}>
                        On-Time <OfficerSortIcon col="onTimeRate" />
                      </TableHead>
                      <TableHead className={`text-right ${officerThCls("avgMinutesLate")}`} onClick={() => handleOfficerSort("avgMinutesLate")}>
                        Avg Late <OfficerSortIcon col="avgMinutesLate" />
                      </TableHead>
                      <TableHead className={`text-right ${officerThCls("hoursWorked")}`} onClick={() => handleOfficerSort("hoursWorked")}>
                        Hrs Worked <OfficerSortIcon col="hoursWorked" />
                      </TableHead>
                      <TableHead className={`text-right ${officerThCls("hoursScheduled")}`} onClick={() => handleOfficerSort("hoursScheduled")}>
                        Hrs Sched. <OfficerSortIcon col="hoursScheduled" />
                      </TableHead>
                      <TableHead className={`text-right ${officerThCls("rejectedEntries")}`} onClick={() => handleOfficerSort("rejectedEntries")}>
                        Rejected <OfficerSortIcon col="rejectedEntries" />
                      </TableHead>
                      <TableHead className={`text-right ${officerThCls("incidentTotal")}`} onClick={() => handleOfficerSort("incidentTotal")}>
                        Incidents <OfficerSortIcon col="incidentTotal" />
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {sortedOfficers.map((o) => (
                      <TableRow key={o.userId}>
                        <TableCell className="font-medium">
                          <Link
                            href={`/personnel/${encodeURIComponent(o.userId)}`}
                            className="text-foreground hover:underline"
                          >
                            {o.firstName} {o.lastName}
                          </Link>
                        </TableCell>
                        <TableCell className="text-right">
                          <span
                            className={`font-semibold ${
                              o.reliabilityScore >= 90
                                ? "text-green-600"
                                : o.reliabilityScore >= 70
                                  ? "text-amber-600"
                                  : "text-red-600"
                            }`}
                          >
                            {o.reliabilityScore.toFixed(1)}
                          </span>
                        </TableCell>
                        <TableCell className="text-right text-muted-foreground">{o.shiftsAssigned}</TableCell>
                        <TableCell className="text-right">{o.shiftsCompleted}</TableCell>
                        <TableCell className="text-right">
                          {o.noShows > 0 ? (
                            <Badge className="bg-amber-100 text-amber-800 hover:bg-amber-100">{o.noShows}</Badge>
                          ) : (
                            <span className="text-muted-foreground">0</span>
                          )}
                        </TableCell>
                        <TableCell className={`text-right ${o.attendanceRate >= 95 ? "text-green-600" : o.attendanceRate >= 80 ? "text-amber-600" : "text-red-600"}`}>
                          {fmtPct(o.attendanceRate)}
                        </TableCell>
                        <TableCell className={`text-right ${o.punctualityEligible === 0 ? "text-muted-foreground" : o.onTimeRate >= 90 ? "text-green-600" : o.onTimeRate >= 70 ? "text-amber-600" : "text-red-600"}`}>
                          {o.punctualityEligible === 0 ? "—" : fmtPct(o.onTimeRate)}
                        </TableCell>
                        <TableCell className="text-right text-muted-foreground">
                          {o.punctualityEligible === 0 ? "—" : `${o.avgMinutesLate.toFixed(1)} min`}
                        </TableCell>
                        <TableCell className="text-right">{fmtHours(o.hoursWorked)}</TableCell>
                        <TableCell className="text-right text-muted-foreground">{fmtHours(o.hoursScheduled)}</TableCell>
                        <TableCell className="text-right">
                          {o.rejectedEntries > 0 ? (
                            <span className="text-amber-600 font-semibold">
                              {o.rejectedEntries}
                              <span className="text-xs font-normal ml-1 text-muted-foreground">
                                ({fmtPct(o.rejectionRate)})
                              </span>
                            </span>
                          ) : (
                            <span className="text-muted-foreground">0</span>
                          )}
                        </TableCell>
                        <TableCell className="text-right">
                          {o.incidentTotal > 0 ? (
                            <span className="font-semibold">
                              {o.incidentTotal}
                              {(o.incidentHigh > 0 || o.incidentCritical > 0) && (
                                <span className="ml-1 inline-flex gap-0.5">
                                  {o.incidentCritical > 0 && (
                                    <Badge className="bg-red-100 text-red-800 hover:bg-red-100 text-[10px] px-1 py-0">
                                      {o.incidentCritical}C
                                    </Badge>
                                  )}
                                  {o.incidentHigh > 0 && (
                                    <Badge className="bg-orange-100 text-orange-800 hover:bg-orange-100 text-[10px] px-1 py-0">
                                      {o.incidentHigh}H
                                    </Badge>
                                  )}
                                </span>
                              )}
                            </span>
                          ) : (
                            <span className="text-muted-foreground">0</span>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}
