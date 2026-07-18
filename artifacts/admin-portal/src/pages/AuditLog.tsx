import { useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, RefreshCw, Filter, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { fetchWithAuth } from "@/lib/api";
import { useIsMobile } from "@/hooks/use-mobile";

type AuditLog = {
  id: string;
  actorUserId: string | null;
  actorEmail: string | null;
  actorRole: string | null;
  action: string;
  targetTable: string | null;
  targetId: string | null;
  method: string;
  path: string;
  statusCode: number | null;
  ip: string | null;
  userAgent: string | null;
  before: unknown;
  after: unknown;
  metadata: unknown;
  createdAt: string;
};

type Resp = { rows: AuditLog[]; total: number; limit: number; offset: number };

const PAGE_SIZE = 50;

const ACTION_PRESETS = [
  "",
  "table.write",
  "table.import",
  "payroll.export_csv",
  "payroll.mark_paid",
  "payroll.update",
  "application.review",
  "users.bulk_temp_passwords",
  "users.bulk_invite",
  "users.admin_change",
  "shifts.write",
  "shifts.repeat_create",
  "clients.write",
  "sites.write",
  "invoices.write",
  "incidents.write",
  "scheduler.eligibility_skip",
];

function methodColor(m: string): string {
  switch (m) {
    case "POST":   return "bg-emerald-100 text-emerald-800 border-emerald-300";
    case "PUT":
    case "PATCH":  return "bg-amber-100 text-amber-800 border-amber-300";
    case "DELETE": return "bg-rose-100 text-rose-800 border-rose-300";
    default:       return "bg-slate-100 text-slate-800 border-slate-300";
  }
}

export default function AuditLogPage() {
  const [data, setData] = useState<Resp | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const [actionFilter, setActionFilter] = useState("");
  const [actorEmailFilter, setActorEmailFilter] = useState("");
  const [tableFilter, setTableFilter] = useState("");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const isMobile = useIsMobile();

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      params.set("limit", String(PAGE_SIZE));
      params.set("offset", String(page * PAGE_SIZE));
      if (actionFilter) params.set("action", actionFilter);
      if (tableFilter) params.set("targetTable", tableFilter);
      const r = await fetchWithAuth(`/api/admin/audit-logs?${params}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = (await r.json()) as Resp;
      setData(j);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  // Re-fetch when page or server-side filters change. Actor email is
  // applied client-side so typing doesn't re-fetch on every keystroke.
  useEffect(() => { void load(); /* eslint-disable-next-line */ }, [page, actionFilter, tableFilter]);

  const filteredRows = useMemo(() => {
    if (!data) return [];
    if (!actorEmailFilter.trim()) return data.rows;
    const q = actorEmailFilter.trim().toLowerCase();
    return data.rows.filter((r) => (r.actorEmail ?? "").toLowerCase().includes(q));
  }, [data, actorEmailFilter]);

  const totalPages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1;

  return (
    <div className="flex-1 overflow-hidden flex flex-col">
      <div className="border-b border-border bg-card px-6 py-4 flex items-center gap-3">
        <div>
          <h1 className="text-xl font-semibold">Audit Log</h1>
          <p className="text-xs text-muted-foreground mt-0.5">
            Every admin / payroll write since launch. Sensitive fields are redacted.
          </p>
        </div>
        <div className="flex-1" />
        <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
          <RefreshCw className={`w-4 h-4 mr-1.5 ${loading ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </div>

      <div className="border-b border-border bg-muted/30 px-6 py-3 flex flex-wrap items-center gap-3">
        <Filter className="w-4 h-4 text-muted-foreground" />
        <select
          aria-label="Filter by action"
          value={actionFilter}
          onChange={(e) => { setActionFilter(e.target.value); setPage(0); }}
          className="text-sm border rounded px-2 py-1 bg-background"
        >
          {ACTION_PRESETS.map((a) => (
            <option key={a || "all"} value={a}>{a || "All actions"}</option>
          ))}
        </select>
        <Input
          placeholder="Filter by table…"
          value={tableFilter}
          onChange={(e) => { setTableFilter(e.target.value); setPage(0); }}
          className="h-8 w-44 text-sm"
        />
        <Input
          placeholder="Filter by actor email…"
          value={actorEmailFilter}
          onChange={(e) => setActorEmailFilter(e.target.value)}
          className="h-8 w-56 text-sm"
        />
        {(actionFilter || tableFilter || actorEmailFilter) && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => { setActionFilter(""); setTableFilter(""); setActorEmailFilter(""); setPage(0); }}
            className="h-8"
          >
            <X className="w-3.5 h-3.5 mr-1" /> Clear
          </Button>
        )}
        <div className="flex-1" />
        {data && (
          <div className="text-xs text-muted-foreground">
            {data.total.toLocaleString()} entries · page {page + 1} of {totalPages}
          </div>
        )}
      </div>

      <div className="flex-1 overflow-auto p-6">
        {error && (
          <div className="bg-destructive/10 border border-destructive/30 text-destructive text-sm px-4 py-2 rounded mb-4">
            Could not load audit log: {error}
          </div>
        )}

        {isMobile ? (
          <div className="space-y-3">
            {loading && (
              <div className="border border-border rounded-md bg-card px-3 py-8 text-center text-muted-foreground text-xs">Loading…</div>
            )}
            {!loading && filteredRows.length === 0 && (
              <div className="border border-border rounded-md bg-card px-3 py-8 text-center text-muted-foreground text-xs">No entries match the current filters.</div>
            )}
            {!loading && filteredRows.map((r) => {
              const isOpen = expandedId === r.id;
              return (
                <div key={r.id} className="border border-border rounded-lg bg-card overflow-hidden">
                  <button
                    type="button"
                    onClick={() => setExpandedId(isOpen ? null : r.id)}
                    className="w-full text-left p-3 space-y-2 hover:bg-muted/30"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <span className="text-xs font-mono bg-muted px-1.5 py-0.5 rounded">{r.action}</span>
                      <span className="text-xs text-right">{r.statusCode ?? "—"}</span>
                    </div>
                    <div className="grid grid-cols-3 gap-x-3 gap-y-1 text-sm">
                      <span className="text-muted-foreground text-xs">When</span>
                      <span className="col-span-2 text-right text-xs text-muted-foreground">{new Date(r.createdAt).toLocaleString()}</span>
                      <span className="text-muted-foreground text-xs">Actor</span>
                      <span className="col-span-2 text-right">
                        <span className="font-medium">{r.actorEmail ?? "(anonymous)"}</span>
                        {r.actorRole && <span className="text-[10px] uppercase opacity-60 ml-1">{r.actorRole}</span>}
                      </span>
                      <span className="text-muted-foreground text-xs">Target</span>
                      <span className="col-span-2 text-right text-xs">
                        {r.targetTable ? (
                          <>
                            <span>{r.targetTable}</span>
                            {r.targetId && <span className="font-mono opacity-60 ml-1 break-all">{r.targetId}</span>}
                          </>
                        ) : <span className="opacity-40">—</span>}
                      </span>
                      <span className="text-muted-foreground text-xs">Method</span>
                      <span className="col-span-2 text-right">
                        <span className={`text-[10px] font-semibold border rounded px-1.5 py-0.5 ${methodColor(r.method)}`}>{r.method}</span>
                      </span>
                      <span className="text-muted-foreground text-xs">Path</span>
                      <span className="col-span-2 text-right text-xs font-mono opacity-70 break-all">{r.path}</span>
                    </div>
                  </button>
                  {isOpen && (
                    <div className="border-t border-border bg-muted/20 px-3 py-3 space-y-3 text-xs">
                      <div>
                        <div className="font-semibold mb-1">Request body (after)</div>
                        <pre className="bg-background border border-border rounded p-2 overflow-auto max-h-64 text-[11px]">
                          {r.after ? JSON.stringify(r.after, null, 2) : "(none)"}
                        </pre>
                      </div>
                      <div>
                        <div className="font-semibold mb-1">Context</div>
                        <div className="space-y-0.5 text-[11px]">
                          <div><span className="opacity-60">IP:</span> {r.ip ?? "—"}</div>
                          <div><span className="opacity-60">User-Agent:</span> <span className="opacity-80 break-all">{r.userAgent ?? "—"}</span></div>
                          <div><span className="opacity-60">Actor user ID:</span> <span className="font-mono break-all">{r.actorUserId ?? "—"}</span></div>
                          <div><span className="opacity-60">Audit ID:</span> <span className="font-mono break-all">{r.id}</span></div>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ) : (
        <div className="border border-border rounded-md overflow-hidden bg-card">
          <div className="overflow-x-auto" tabIndex={0} role="region" aria-label="Audit log table">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-medium">When</th>
                <th className="px-3 py-2 font-medium">Actor</th>
                <th className="px-3 py-2 font-medium">Action</th>
                <th className="px-3 py-2 font-medium">Target</th>
                <th className="px-3 py-2 font-medium">Method</th>
                <th className="px-3 py-2 font-medium">Path</th>
                <th className="px-3 py-2 font-medium text-right">Status</th>
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr><td colSpan={7} className="px-3 py-8 text-center text-muted-foreground text-xs">Loading…</td></tr>
              )}
              {!loading && filteredRows.length === 0 && (
                <tr><td colSpan={7} className="px-3 py-8 text-center text-muted-foreground text-xs">No entries match the current filters.</td></tr>
              )}
              {!loading && filteredRows.map((r) => {
                const isOpen = expandedId === r.id;
                return (
                  <>
                    <tr
                      key={r.id}
                      onClick={() => setExpandedId(isOpen ? null : r.id)}
                      className="border-t border-border hover:bg-muted/30 cursor-pointer"
                    >
                      <td className="px-3 py-2 whitespace-nowrap text-xs text-muted-foreground">
                        {new Date(r.createdAt).toLocaleString()}
                      </td>
                      <td className="px-3 py-2">
                        <div className="font-medium">{r.actorEmail ?? "(anonymous)"}</div>
                        {r.actorRole && <div className="text-[10px] uppercase opacity-60">{r.actorRole}</div>}
                      </td>
                      <td className="px-3 py-2">
                        <span className="text-xs font-mono bg-muted px-1.5 py-0.5 rounded">{r.action}</span>
                      </td>
                      <td className="px-3 py-2 text-xs">
                        {r.targetTable ? (
                          <>
                            <div>{r.targetTable}</div>
                            {r.targetId && <div className="font-mono opacity-60 truncate max-w-[180px]">{r.targetId}</div>}
                          </>
                        ) : <span className="opacity-40">—</span>}
                      </td>
                      <td className="px-3 py-2">
                        <span className={`text-[10px] font-semibold border rounded px-1.5 py-0.5 ${methodColor(r.method)}`}>
                          {r.method}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-xs font-mono opacity-70 truncate max-w-[260px]">{r.path}</td>
                      <td className="px-3 py-2 text-right text-xs">{r.statusCode ?? "—"}</td>
                    </tr>
                    {isOpen && (
                      <tr key={r.id + "-detail"} className="border-t border-border bg-muted/20">
                        <td colSpan={7} className="px-4 py-3">
                          <div className="grid grid-cols-2 gap-4 text-xs">
                            <div>
                              <div className="font-semibold mb-1">Request body (after)</div>
                              <pre className="bg-background border border-border rounded p-2 overflow-auto max-h-64 text-[11px]">
                                {r.after ? JSON.stringify(r.after, null, 2) : "(none)"}
                              </pre>
                            </div>
                            <div>
                              <div className="font-semibold mb-1">Context</div>
                              <div className="space-y-0.5 text-[11px]">
                                <div><span className="opacity-60">IP:</span> {r.ip ?? "—"}</div>
                                <div><span className="opacity-60">User-Agent:</span> <span className="opacity-80 break-all">{r.userAgent ?? "—"}</span></div>
                                <div><span className="opacity-60">Actor user ID:</span> <span className="font-mono">{r.actorUserId ?? "—"}</span></div>
                                <div><span className="opacity-60">Audit ID:</span> <span className="font-mono">{r.id}</span></div>
                              </div>
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                  </>
                );
              })}
            </tbody>
          </table>
          </div>
        </div>
        )}

        <div className="flex items-center justify-end gap-2 mt-4">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setPage((p) => Math.max(0, p - 1))}
            disabled={page === 0 || loading}
          >
            <ChevronLeft className="w-4 h-4" /> Prev
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setPage((p) => p + 1)}
            disabled={loading || (data ? (page + 1) >= totalPages : true)}
          >
            Next <ChevronRight className="w-4 h-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}
