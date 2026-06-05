import { useEffect, useMemo, useState } from "react";
import { Download, FileSpreadsheet, FileText, Loader2, RefreshCw, AlertTriangle } from "lucide-react";
import { api, ApiError, fetchWithAuth } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type DatasetId = "shifts" | "time_entries" | "payroll_entries" | "incidents" | "officers" | "applications";

type DatasetDef = {
  id: DatasetId;
  label: string;
  description: string;
  // Which filters this dataset actually honours — controls which inputs
  // we surface so admins don't waste time setting filters the server
  // will silently drop.
  filters: {
    date: boolean;
    siteId: boolean;
    clientId: boolean;
    employeeId: boolean;
    status: { kind: "none" } | { kind: "options"; options: { value: string; label: string }[] };
  };
  // Hint text under the date inputs naming which column they bound.
  dateColumn: string;
};

const DATASETS: DatasetDef[] = [
  {
    id: "shifts",
    label: "Shifts",
    description: "Posted shifts with site, client, headcount, pay/bill rates and status.",
    dateColumn: "shift start time",
    filters: {
      date: true, siteId: true, clientId: true, employeeId: false,
      status: { kind: "options", options: [
        { value: "upcoming", label: "Upcoming" },
        { value: "in_progress", label: "In progress" },
        { value: "completed", label: "Completed" },
        { value: "cancelled", label: "Cancelled" },
      ]},
    },
  },
  {
    id: "time_entries",
    label: "Time Entries",
    description: "Clock-in / clock-out records with approval status and hours worked.",
    dateColumn: "clock-in time",
    filters: {
      date: true, siteId: true, clientId: true, employeeId: true,
      status: { kind: "options", options: [
        { value: "pending", label: "Pending approval" },
        { value: "approved", label: "Approved" },
        { value: "rejected", label: "Rejected" },
      ]},
    },
  },
  {
    id: "payroll_entries",
    label: "Payroll Entries",
    description: "Weekly payroll buckets per officer/site with gross/tax/net and payment state.",
    dateColumn: "period start date",
    filters: {
      date: true, siteId: true, clientId: true, employeeId: true,
      status: { kind: "options", options: [
        { value: "pending", label: "Pending" },
        { value: "processed", label: "Processed" },
        { value: "paid", label: "Paid" },
        { value: "failed", label: "Failed" },
      ]},
    },
  },
  {
    id: "incidents",
    label: "Incidents",
    description: "Officer-filed incident reports with severity, status, site and time.",
    dateColumn: "occurrence time",
    filters: {
      date: true, siteId: true, clientId: true, employeeId: true,
      status: { kind: "options", options: [
        { value: "open", label: "Open" },
        { value: "in_progress", label: "In progress" },
        { value: "resolved", label: "Resolved" },
        { value: "closed", label: "Closed" },
      ]},
    },
  },
  {
    id: "officers",
    label: "Officers",
    description: "All accounts with role = employee, including hourly rate and license level.",
    dateColumn: "account-created date",
    filters: {
      date: true, siteId: false, clientId: false, employeeId: true,
      status: { kind: "options", options: [
        { value: "active", label: "Active" },
        { value: "pending", label: "Pending" },
        { value: "inactive", label: "Inactive" },
      ]},
    },
  },
  {
    id: "applications",
    label: "Applications",
    description: "Inbound job applications with personal info, license, and review state.",
    dateColumn: "submitted date",
    filters: {
      date: true, siteId: false, clientId: false, employeeId: false,
      status: { kind: "options", options: [
        { value: "submitted", label: "Submitted" },
        { value: "under_review", label: "Under review" },
        { value: "info_requested", label: "Info requested" },
        { value: "approved", label: "Approved" },
        { value: "rejected", label: "Rejected" },
      ]},
    },
  },
];

type Site = { id: string; name: string; clientId: string | null };
type Client = { id: string; name: string };
type Officer = { id: string; firstName: string; lastName: string; email: string };

type PreviewResp = {
  dataset: DatasetId;
  label: string;
  count: number;
  columns: string[];
  sample: (string | number | null)[][];
  pdfRowLimit: number;
  csvRowLimit?: number;
};

type Filters = {
  from: string;
  to: string;
  siteId: string;
  clientId: string;
  employeeId: string;
  status: string;
};

const EMPTY_FILTERS: Filters = {
  from: "",
  to: "",
  siteId: "",
  clientId: "",
  employeeId: "",
  status: "",
};

function stripEmpty(f: Filters): Partial<Filters> {
  const out: Partial<Filters> = {};
  (Object.keys(f) as (keyof Filters)[]).forEach((k) => {
    const v = f[k];
    if (v && String(v).trim() !== "") out[k] = v;
  });
  return out;
}

export default function ExportsPage() {
  const [datasetId, setDatasetId] = useState<DatasetId>("shifts");
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [sites, setSites] = useState<Site[]>([]);
  const [clients, setClients] = useState<Client[]>([]);
  const [officers, setOfficers] = useState<Officer[]>([]);
  const [preview, setPreview] = useState<PreviewResp | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState<"csv" | "pdf" | null>(null);

  const dataset = useMemo(() => DATASETS.find((d) => d.id === datasetId)!, [datasetId]);

  // Reset filters when the dataset changes — most filters are dataset-
  // scoped (status enums differ, etc.) so carrying them over leads to
  // surprising "zero rows" results.
  useEffect(() => {
    setFilters(EMPTY_FILTERS);
    setPreview(null);
    setError(null);
  }, [datasetId]);

  // Load support tables once — these power the site/client/officer
  // dropdowns. We tolerate failures (e.g. permissions for a freshly
  // seeded admin) and just fall back to empty selects + free-text uuid.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [s, c, u] = await Promise.all([
          api<{ rows: Site[] }>("/admin/tables/sites?limit=500").catch(() => ({ rows: [] })),
          api<{ rows: Client[] }>("/admin/tables/clients?limit=500").catch(() => ({ rows: [] })),
          api<{ rows: Officer[] }>("/admin/tables/users?limit=1000").catch(() => ({ rows: [] })),
        ]);
        if (cancelled) return;
        setSites(s.rows ?? []);
        setClients(c.rows ?? []);
        // Generic /admin/tables/users returns every role — narrow to
        // employees for the officer filter to avoid burying officers
        // under admin accounts.
        const allUsers = (u.rows ?? []) as (Officer & { role?: string })[];
        setOfficers(
          allUsers
            .filter((r) => (r.role ?? "employee") !== "admin")
            .sort((a, b) => (a.lastName ?? "").localeCompare(b.lastName ?? "")),
        );
      } catch {
        /* ignore — selects fall back to empty */
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const setFilter = (k: keyof Filters, v: string) =>
    setFilters((f) => ({ ...f, [k]: v }));

  const runPreview = async () => {
    setPreviewing(true);
    setError(null);
    try {
      const resp = await api<PreviewResp>("/admin/exports/preview", {
        method: "POST",
        body: { dataset: datasetId, filters: stripEmpty(filters) },
      });
      setPreview(resp);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Preview failed.");
      setPreview(null);
    } finally {
      setPreviewing(false);
    }
  };

  const download = async (format: "csv" | "pdf") => {
    setError(null);
    setDownloading(format);
    try {
      const res = await fetchWithAuth(`/api/admin/exports/${format}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dataset: datasetId, filters: stripEmpty(filters) }),
      });
      if (!res.ok) {
        // Try to surface server's JSON error message; the 413 PDF cap
        // path is the most likely one to trip in real use.
        let msg = `Download failed (${res.status})`;
        try {
          const j = await res.json();
          if (j?.message) msg = j.message;
          else if (j?.error) msg = j.error;
        } catch { /* not JSON */ }
        throw new ApiError(res.status, msg);
      }
      const blob = await res.blob();
      // Server sets the canonical filename via Content-Disposition; reuse it.
      const disp = res.headers.get("Content-Disposition") ?? "";
      const m = /filename="?([^";]+)"?/.exec(disp);
      const filename = m?.[1] ?? `wcsg-${datasetId}-${new Date().toISOString().slice(0, 10)}.${format}`;
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
  };

  const filteredSites = useMemo(() => {
    if (!filters.clientId) return sites;
    return sites.filter((s) => s.clientId === filters.clientId);
  }, [sites, filters.clientId]);

  const pdfOverLimit = preview && preview.count > preview.pdfRowLimit;
  const csvRowLimit = preview?.csvRowLimit ?? null;
  const csvOverLimit = preview && csvRowLimit !== null && preview.count > csvRowLimit;
  const hasNoRows = preview !== null && preview.count === 0;
  const needsPreview = preview === null;

  return (
    <div className="flex-1 overflow-hidden flex flex-col">
      <div className="border-b border-border bg-card px-6 py-4 flex items-center gap-3">
        <Download className="w-5 h-5 brand-gold" />
        <div>
          <h1 className="text-xl font-semibold">Exports center</h1>
          <p className="text-xs text-muted-foreground mt-0.5">
            Pick a dataset, narrow with filters, preview, then download as CSV or branded PDF.
            Every export is recorded in the audit log.
          </p>
        </div>
      </div>

      <div className="flex-1 overflow-auto p-6 space-y-6">
        {/* Dataset picker */}
        <div>
          <div className="text-xs uppercase tracking-wider opacity-60 mb-2">Dataset</div>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
            {DATASETS.map((d) => {
              const active = d.id === datasetId;
              return (
                <button
                  key={d.id}
                  type="button"
                  onClick={() => setDatasetId(d.id)}
                  className={`text-left border rounded-md p-3 transition-colors ${
                    active
                      ? "border-brand-gold/70 bg-brand-gold/10"
                      : "border-border hover:border-brand-gold/40 hover:bg-muted/40"
                  }`}
                >
                  <div className="font-medium text-sm">{d.label}</div>
                  <div className="text-[11px] opacity-70 mt-0.5 leading-snug">{d.description}</div>
                </button>
              );
            })}
          </div>
        </div>

        {/* Filters */}
        <div className="border border-border rounded-md bg-card p-4">
          <div className="flex items-center justify-between mb-3">
            <div className="text-sm font-medium">Filters</div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setFilters(EMPTY_FILTERS)}
              disabled={Object.values(filters).every((v) => !v)}
            >
              <RefreshCw className="w-3.5 h-3.5 mr-1" /> Clear
            </Button>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {dataset.filters.date && (
              <>
                <div>
                  <label className="text-xs opacity-60 block mb-1">From ({dataset.dateColumn})</label>
                  <Input
                    type="date"
                    value={filters.from}
                    onChange={(e) => setFilter("from", e.target.value)}
                    className="h-9"
                  />
                </div>
                <div>
                  <label className="text-xs opacity-60 block mb-1">To ({dataset.dateColumn})</label>
                  <Input
                    type="date"
                    value={filters.to}
                    onChange={(e) => setFilter("to", e.target.value)}
                    className="h-9"
                  />
                </div>
              </>
            )}
            {dataset.filters.clientId && (
              <div>
                <label className="text-xs opacity-60 block mb-1">Client</label>
                <select
                  value={filters.clientId}
                  onChange={(e) => {
                    setFilter("clientId", e.target.value);
                    // Reset site when client changes since the filtered
                    // site list will change too.
                    setFilter("siteId", "");
                  }}
                  className="w-full h-9 border rounded px-2 text-sm bg-background"
                >
                  <option value="">All clients</option>
                  {clients.map((c) => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </select>
              </div>
            )}
            {dataset.filters.siteId && (
              <div>
                <label className="text-xs opacity-60 block mb-1">Site</label>
                <select
                  value={filters.siteId}
                  onChange={(e) => setFilter("siteId", e.target.value)}
                  className="w-full h-9 border rounded px-2 text-sm bg-background"
                >
                  <option value="">All sites</option>
                  {filteredSites.map((s) => (
                    <option key={s.id} value={s.id}>{s.name}</option>
                  ))}
                </select>
              </div>
            )}
            {dataset.filters.employeeId && (
              <div>
                <label className="text-xs opacity-60 block mb-1">Officer</label>
                <select
                  value={filters.employeeId}
                  onChange={(e) => setFilter("employeeId", e.target.value)}
                  className="w-full h-9 border rounded px-2 text-sm bg-background"
                >
                  <option value="">All officers</option>
                  {officers.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.lastName}, {o.firstName} · {o.email}
                    </option>
                  ))}
                </select>
              </div>
            )}
            {dataset.filters.status.kind === "options" && (
              <div>
                <label className="text-xs opacity-60 block mb-1">Status</label>
                <select
                  value={filters.status}
                  onChange={(e) => setFilter("status", e.target.value)}
                  className="w-full h-9 border rounded px-2 text-sm bg-background"
                >
                  <option value="">Any status</option>
                  {dataset.filters.status.options.map((o) => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
              </div>
            )}
          </div>
        </div>

        {/* Actions */}
        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={runPreview} disabled={previewing}>
            {previewing
              ? <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              : <RefreshCw className="w-4 h-4 mr-2" />}
            Preview
          </Button>
          <Button
            variant="outline"
            onClick={() => void download("csv")}
            disabled={downloading !== null || needsPreview || hasNoRows || Boolean(csvOverLimit)}
            title={
              needsPreview ? "Run a preview first." :
              hasNoRows ? "No matching rows to export." :
              csvOverLimit ? "Row count exceeds the CSV limit — narrow the date range." : undefined
            }
          >
            {downloading === "csv"
              ? <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              : <FileSpreadsheet className="w-4 h-4 mr-2" />}
            Download CSV
          </Button>
          <Button
            variant="outline"
            onClick={() => void download("pdf")}
            disabled={downloading !== null || needsPreview || hasNoRows || Boolean(pdfOverLimit)}
            title={
              needsPreview ? "Run a preview first." :
              hasNoRows ? "No matching rows to export." :
              pdfOverLimit ? "Row count exceeds the PDF limit — use CSV or narrow the date range." : undefined
            }
          >
            {downloading === "pdf"
              ? <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              : <FileText className="w-4 h-4 mr-2" />}
            Download PDF
          </Button>
          {preview && (
            <div className="text-sm ml-2 opacity-70">
              {preview.count.toLocaleString()} matching rows
              {hasNoRows && (
                <span className="ml-2 inline-flex items-center text-amber-700">
                  <AlertTriangle className="w-3.5 h-3.5 mr-1" />
                  No rows to export.
                </span>
              )}
              {csvOverLimit && csvRowLimit !== null && (
                <span className="ml-2 inline-flex items-center text-amber-700">
                  <AlertTriangle className="w-3.5 h-3.5 mr-1" />
                  CSV limit is {csvRowLimit.toLocaleString()} — narrow filters.
                </span>
              )}
              {pdfOverLimit && (
                <span className="ml-2 inline-flex items-center text-amber-700">
                  <AlertTriangle className="w-3.5 h-3.5 mr-1" />
                  PDF limit is {preview.pdfRowLimit.toLocaleString()} — use CSV.
                </span>
              )}
            </div>
          )}
        </div>

        {error && (
          <div className="bg-destructive/10 border border-destructive/30 text-destructive text-sm px-4 py-2 rounded">
            {error}
          </div>
        )}

        {/* Preview table */}
        {preview && (
          <div>
            <div className="text-xs uppercase tracking-wider opacity-60 mb-2">
              Preview — first {preview.sample.length} of {preview.count.toLocaleString()} rows
            </div>
            <div className="border border-border rounded-md overflow-auto bg-card max-h-[480px]">
              <table className="w-full text-xs">
                <thead className="bg-muted/40 sticky top-0">
                  <tr>
                    {preview.columns.map((c) => (
                      <th key={c} className="px-3 py-2 text-left font-medium whitespace-nowrap">
                        {c}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {preview.sample.length === 0 && (
                    <tr>
                      <td colSpan={preview.columns.length} className="px-3 py-8 text-center opacity-60">
                        No rows match these filters.
                      </td>
                    </tr>
                  )}
                  {preview.sample.map((row, i) => (
                    <tr key={i} className="border-t border-border hover:bg-muted/20">
                      {row.map((cell, j) => (
                        <td key={j} className="px-3 py-1.5 whitespace-nowrap font-mono">
                          {cell === null || cell === undefined || cell === ""
                            ? <span className="opacity-30">—</span>
                            : String(cell)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
