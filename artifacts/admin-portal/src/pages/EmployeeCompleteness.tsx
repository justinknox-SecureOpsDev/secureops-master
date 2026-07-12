import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "wouter";
import { api } from "@/lib/api";
import { formatDate, formatDateTime } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useIsMobile } from "@/hooks/use-mobile";
import {
  RefreshCw, Download, ExternalLink, CheckCircle2, XCircle, AlertCircle,
  Users, CreditCard, FileCheck, LogIn, Camera, Phone, ShieldCheck, DollarSign, UserCheck,
} from "lucide-react";

type CompletenessRow = {
  userId: string;
  employeeId: string;
  firstName: string | null;
  lastName: string | null;
  email: string;
  status: string;
  position: string | null;
  hasDirectDeposit: boolean;
  hasPolicyAcknowledgements: boolean;
  hasEverLoggedIn: boolean;
  hasPhoto: boolean;
  hasEmergencyContact: boolean;
  hasRightToWork: boolean;
  hasPhone: boolean;
  hasHourlyRate: boolean;
  lastLoginAt: string | null;
  invitedAt: string | null;
  createdAt: string | null;
};

type CheckKey =
  | "hasDirectDeposit"
  | "hasPolicyAcknowledgements"
  | "hasEverLoggedIn"
  | "hasPhoto"
  | "hasEmergencyContact"
  | "hasRightToWork"
  | "hasPhone"
  | "hasHourlyRate";

const CHECKS: { key: CheckKey; label: string; shortLabel: string; Icon: React.ElementType }[] = [
  { key: "hasDirectDeposit",        label: "Direct deposit",        shortLabel: "DD",        Icon: CreditCard },
  { key: "hasPolicyAcknowledgements", label: "Policy ack.",         shortLabel: "Policies",  Icon: FileCheck },
  { key: "hasEverLoggedIn",         label: "Ever logged in",        shortLabel: "Login",     Icon: LogIn },
  { key: "hasPhoto",                label: "Profile photo",         shortLabel: "Photo",     Icon: Camera },
  { key: "hasEmergencyContact",     label: "Emergency contact",     shortLabel: "Emerg.",    Icon: AlertCircle },
  { key: "hasRightToWork",          label: "Right to work",         shortLabel: "RTW",       Icon: ShieldCheck },
  { key: "hasPhone",                label: "Phone number",          shortLabel: "Phone",     Icon: Phone },
  { key: "hasHourlyRate",           label: "Hourly rate",           shortLabel: "Rate",      Icon: DollarSign },
];

function Tick({ ok }: { ok: boolean }) {
  return ok
    ? <CheckCircle2 className="w-4 h-4 text-emerald-600" aria-label="Complete" />
    : <XCircle className="w-4 h-4 text-red-500" aria-label="Missing" />;
}

function StatusBadge({ status }: { status: string }) {
  const cls =
    status === "active"   ? "bg-emerald-100 text-emerald-800 border-emerald-300" :
    status === "pending"  ? "bg-amber-100 text-amber-800 border-amber-300" :
    status === "inactive" ? "bg-gray-100 text-gray-600 border-gray-300" :
                            "bg-blue-100 text-blue-800 border-blue-300";
  return (
    <span className={`inline-block px-1.5 py-0.5 rounded border text-[11px] font-medium ${cls}`}>
      {status}
    </span>
  );
}

function missingCount(row: CompletenessRow): number {
  return CHECKS.filter((c) => !row[c.key]).length;
}

function escapeCsv(v: string): string {
  if (/[,"\n\r]/.test(v)) return `"${v.replace(/"/g, '""')}"`;
  return v;
}

export default function EmployeeCompletenessPage() {
  const isMobile = useIsMobile();
  const [rows, setRows] = useState<CompletenessRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "active" | "pending" | "inactive">("all");
  const [incompleteOnly, setIncompleteOnly] = useState(false);
  const [activeCheckFilter, setActiveCheckFilter] = useState<CheckKey | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api<CompletenessRow[]>("/admin/reports/employee-completeness");
      setRows(data);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const filtered = useMemo(() => {
    let out = rows;
    if (statusFilter !== "all") out = out.filter((r) => r.status === statusFilter);
    if (search.trim()) {
      const q = search.toLowerCase();
      out = out.filter(
        (r) =>
          (r.firstName ?? "").toLowerCase().includes(q) ||
          (r.lastName ?? "").toLowerCase().includes(q) ||
          r.email.toLowerCase().includes(q),
      );
    }
    if (incompleteOnly) out = out.filter((r) => missingCount(r) > 0);
    if (activeCheckFilter) out = out.filter((r) => !r[activeCheckFilter]);
    return out;
  }, [rows, statusFilter, search, incompleteOnly, activeCheckFilter]);

  // Summary counts: how many employees are missing each check
  const summary = useMemo(
    () =>
      CHECKS.map((c) => ({
        ...c,
        missing: rows.filter((r) => !r[c.key]).length,
        total: rows.length,
      })),
    [rows],
  );

  function downloadCsv() {
    const headers = [
      "First Name", "Last Name", "Email", "Status", "Position",
      ...CHECKS.map((c) => c.label),
      "Last Login", "Invited At",
    ];
    const csvRows = [
      headers.map(escapeCsv).join(","),
      ...filtered.map((r) =>
        [
          r.firstName ?? "",
          r.lastName ?? "",
          r.email,
          r.status,
          r.position ?? "",
          ...CHECKS.map((c) => (r[c.key] ? "Yes" : "No")),
          r.lastLoginAt ? formatDateTime(r.lastLoginAt) : "Never",
          r.invitedAt ? formatDateTime(r.invitedAt) : "",
        ]
          .map(String)
          .map(escapeCsv)
          .join(","),
      ),
    ];
    const blob = new Blob([csvRows.join("\r\n")], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `wcsg-employee-completeness-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  return (
    <div className="flex flex-col h-full">
      {/* Page header */}
      <div className="px-4 sm:px-6 py-4 border-b bg-card shrink-0">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div>
            <h1 className="text-xl sm:text-2xl brand-navy" style={{ fontFamily: "Georgia, serif", fontWeight: 700 }}>
              Employee Profile Completeness
            </h1>
            <p className="text-xs text-muted-foreground mt-0.5">
              {loading ? "Loading…" : `${rows.length} employees · ${filtered.length} shown`}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" size="sm" onClick={load} disabled={loading} aria-label="Refresh">
              <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
            </Button>
            <Button variant="outline" size="sm" onClick={downloadCsv} disabled={loading || filtered.length === 0}>
              <Download className="w-4 h-4 mr-1.5" />
              Export CSV
            </Button>
          </div>
        </div>
      </div>

      {/* Summary cards */}
      <div className="px-4 sm:px-6 py-4 border-b bg-muted/30 shrink-0">
        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-2">
          {summary.map((s) => {
            const isActive = activeCheckFilter === s.key;
            const allGood = s.missing === 0;
            return (
              <button
                key={s.key}
                type="button"
                onClick={() => setActiveCheckFilter(isActive ? null : s.key)}
                className={`text-left rounded-lg border p-2.5 transition-all text-xs ${
                  isActive
                    ? "bg-brand-navy text-white border-brand-navy"
                    : allGood
                      ? "bg-emerald-50 border-emerald-200 hover:border-emerald-400"
                      : "bg-red-50 border-red-200 hover:border-red-400"
                }`}
                title={`${s.missing} of ${s.total} missing ${s.label} — click to filter`}
              >
                <s.Icon className={`w-3.5 h-3.5 mb-1 ${isActive ? "text-white" : allGood ? "text-emerald-600" : "text-red-500"}`} />
                <div className={`font-semibold text-[11px] leading-tight ${isActive ? "text-white" : "text-foreground"}`}>
                  {s.label}
                </div>
                <div className={`mt-0.5 font-bold text-base leading-none ${
                  isActive ? "text-white/90" : allGood ? "text-emerald-700" : "text-red-600"
                }`}>
                  {s.missing === 0 ? (
                    <span className="text-sm">✓ All set</span>
                  ) : (
                    <>{s.missing} <span className="text-[10px] font-normal opacity-80">missing</span></>
                  )}
                </div>
              </button>
            );
          })}
        </div>
        {activeCheckFilter && (
          <div className="mt-2 flex items-center gap-2 text-xs text-brand-navy">
            <span className="font-medium">Filtering: missing "{CHECKS.find((c) => c.key === activeCheckFilter)?.label}"</span>
            <button
              type="button"
              className="underline hover:no-underline text-muted-foreground"
              onClick={() => setActiveCheckFilter(null)}
            >
              Clear
            </button>
          </div>
        )}
      </div>

      {/* Filters row */}
      <div className="px-4 sm:px-6 py-3 border-b bg-card shrink-0">
        <div className="flex flex-wrap items-center gap-2">
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search name or email…"
            className="w-full sm:w-56 h-8 text-sm"
            aria-label="Search employees"
          />
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as typeof statusFilter)}
            className="h-8 rounded-md border border-input bg-transparent px-2 text-sm"
            aria-label="Filter by status"
          >
            <option value="all">All statuses</option>
            <option value="active">Active</option>
            <option value="pending">Pending</option>
            <option value="inactive">Inactive</option>
          </select>
          <label className="flex items-center gap-1.5 text-sm cursor-pointer select-none">
            <input
              type="checkbox"
              checked={incompleteOnly}
              onChange={(e) => setIncompleteOnly(e.target.checked)}
              className="h-3.5 w-3.5"
            />
            Show incomplete only
          </label>
          {(search || statusFilter !== "all" || incompleteOnly || activeCheckFilter) && (
            <button
              type="button"
              className="text-xs text-muted-foreground underline hover:no-underline"
              onClick={() => {
                setSearch("");
                setStatusFilter("all");
                setIncompleteOnly(false);
                setActiveCheckFilter(null);
              }}
            >
              Clear all filters
            </button>
          )}
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto bg-background">
        {loading && (
          <div className="flex items-center justify-center h-40 text-muted-foreground text-sm">
            <RefreshCw className="w-4 h-4 animate-spin mr-2" /> Loading…
          </div>
        )}
        {error && !loading && (
          <div className="m-6 text-sm text-destructive border border-destructive/40 rounded p-3">
            {error}
          </div>
        )}
        {!loading && !error && filtered.length === 0 && (
          <div className="flex flex-col items-center justify-center h-40 text-muted-foreground text-sm gap-2">
            <Users className="w-8 h-8 opacity-30" />
            {rows.length === 0 ? "No employees found." : "No employees match the current filters."}
          </div>
        )}

        {/* Desktop table */}
        {!loading && !error && filtered.length > 0 && !isMobile && (
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-card z-10 border-b">
              <tr>
                <th className="text-left px-4 py-2.5 font-semibold text-xs uppercase tracking-wide brand-navy whitespace-nowrap">
                  Employee
                </th>
                <th className="text-left px-2 py-2.5 font-semibold text-xs uppercase tracking-wide brand-navy whitespace-nowrap">
                  Status
                </th>
                {CHECKS.map((c) => (
                  <th
                    key={c.key}
                    className="text-center px-2 py-2.5 font-semibold text-xs uppercase tracking-wide brand-navy whitespace-nowrap"
                    title={c.label}
                  >
                    {c.shortLabel}
                  </th>
                ))}
                <th className="text-left px-2 py-2.5 font-semibold text-xs uppercase tracking-wide brand-navy whitespace-nowrap">
                  Last Login
                </th>
                <th className="text-center px-4 py-2.5 font-semibold text-xs uppercase tracking-wide brand-navy">
                  Missing
                </th>
                <th className="text-right px-4 py-2.5 font-semibold text-xs uppercase tracking-wide brand-navy">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => {
                const mc = missingCount(r);
                return (
                  <tr key={r.userId} className="border-b hover:bg-accent/30">
                    <td className="px-4 py-2.5">
                      <div className="font-medium text-foreground">
                        {r.firstName} {r.lastName}
                      </div>
                      <div className="text-xs text-muted-foreground truncate max-w-[200px]">{r.email}</div>
                    </td>
                    <td className="px-2 py-2.5 whitespace-nowrap">
                      <StatusBadge status={r.status} />
                    </td>
                    {CHECKS.map((c) => (
                      <td key={c.key} className="px-2 py-2.5 text-center">
                        <Tick ok={r[c.key]} />
                      </td>
                    ))}
                    <td className="px-2 py-2.5 whitespace-nowrap text-xs text-muted-foreground">
                      {r.lastLoginAt ? formatDate(r.lastLoginAt) : (
                        <span className="text-red-600 font-medium">Never</span>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-center">
                      {mc === 0 ? (
                        <span className="text-xs text-emerald-700 font-medium">Complete</span>
                      ) : (
                        <span className={`text-xs font-semibold ${mc >= 5 ? "text-red-600" : mc >= 3 ? "text-amber-700" : "text-amber-600"}`}>
                          {mc}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      <Link href={`/personnel/${r.userId}`}>
                        <Button variant="ghost" size="sm" title="Open officer profile">
                          <ExternalLink className="w-3.5 h-3.5 mr-1" />
                          Profile
                        </Button>
                      </Link>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}

        {/* Mobile cards */}
        {!loading && !error && filtered.length > 0 && isMobile && (
          <div className="flex flex-col gap-3 p-3">
            {filtered.map((r) => {
              const mc = missingCount(r);
              return (
                <div key={r.userId} className="rounded-lg border bg-card shadow-sm p-3">
                  <div className="flex items-start justify-between gap-2 mb-2">
                    <div className="min-w-0">
                      <div className="font-semibold text-foreground truncate">
                        {r.firstName} {r.lastName}
                      </div>
                      <div className="text-xs text-muted-foreground truncate">{r.email}</div>
                    </div>
                    <div className="flex flex-col items-end gap-1 shrink-0">
                      <StatusBadge status={r.status} />
                      {mc === 0 ? (
                        <span className="text-[10px] text-emerald-700 font-medium">Complete</span>
                      ) : (
                        <span className={`text-[10px] font-semibold ${mc >= 5 ? "text-red-600" : "text-amber-700"}`}>
                          {mc} missing
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="grid grid-cols-4 gap-1.5 mb-2">
                    {CHECKS.map((c) => (
                      <div key={c.key} className="flex flex-col items-center gap-0.5">
                        <Tick ok={r[c.key]} />
                        <span className="text-[9px] text-muted-foreground text-center leading-tight">{c.shortLabel}</span>
                      </div>
                    ))}
                  </div>
                  <div className="text-xs text-muted-foreground mb-2">
                    Last login: {r.lastLoginAt ? formatDate(r.lastLoginAt) : <span className="text-red-600 font-medium">Never</span>}
                  </div>
                  <div className="flex justify-end pt-1 border-t">
                    <Link href={`/personnel/${r.userId}`}>
                      <Button variant="ghost" size="sm">
                        <ExternalLink className="w-3.5 h-3.5 mr-1" />
                        Profile
                      </Button>
                    </Link>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Footer count */}
      {!loading && !error && (
        <div className="px-4 sm:px-6 py-3 border-t bg-card text-xs text-muted-foreground shrink-0">
          {filtered.length} of {rows.length} employees shown
          {filtered.length > 0 && (
            <> · {filtered.filter((r) => missingCount(r) === 0).length} fully complete</>
          )}
        </div>
      )}
    </div>
  );
}
