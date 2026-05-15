import { useState } from "react";
import { api, ApiError } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AlertCircle, CheckCircle2, Loader2, Database, Plus, Pencil, SkipForward } from "lucide-react";

type Decision = {
  mondayId: string;
  mondayName: string;
  email: string | null;
  action: "create" | "update" | "skip-no-email" | "skip-conflict";
  reason?: string;
  changes?: Record<string, { from: unknown; to: unknown }>;
};
type SyncResult = {
  boardId: string;
  totalFromMonday: number;
  willCreate: number;
  willUpdate: number;
  skippedNoEmail: number;
  skippedConflict: number;
  decisions: Decision[];
  applied: boolean;
  errors: { mondayId: string; mondayName: string; error: string }[];
};

const DEFAULT_BOARD = "18408899656";

export function MondaySyncPage() {
  const [boardId, setBoardId] = useState(DEFAULT_BOARD);
  const [busy, setBusy] = useState<"dry" | "apply" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SyncResult | null>(null);
  const [filter, setFilter] = useState<"all" | "create" | "update" | "skip">("all");

  async function run(dryRun: boolean) {
    setBusy(dryRun ? "dry" : "apply");
    setError(null);
    if (!dryRun) setResult(null);
    try {
      const res = await api<SyncResult>("/admin/integrations/monday/sync", {
        method: "POST",
        body: { boardId, dryRun },
      });
      setResult(res);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : (e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const filtered = result?.decisions.filter((d) => {
    if (filter === "all") return true;
    if (filter === "skip") return d.action.startsWith("skip");
    return d.action === filter;
  }) ?? [];

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-5">
      <div className="flex items-center gap-3">
        <Database className="w-7 h-7 brand-gold" />
        <div>
          <h1 className="text-xl font-bold brand-navy">Sync from Monday.com</h1>
          <p className="text-sm text-muted-foreground">
            One-way pull from your Employee Database Master board into our users + employees tables.
          </p>
        </div>
      </div>

      <div className="bg-card border rounded-lg p-4 space-y-3">
        <div className="grid grid-cols-1 md:grid-cols-[1fr_auto_auto] gap-3 items-end">
          <div>
            <Label htmlFor="boardId" className="text-xs uppercase font-semibold brand-navy">Monday Board ID</Label>
            <Input
              id="boardId" value={boardId} onChange={(e) => setBoardId(e.target.value)}
              placeholder="18408899656" disabled={Boolean(busy)}
            />
          </div>
          <Button onClick={() => run(true)} disabled={Boolean(busy) || !boardId} variant="outline">
            {busy === "dry" ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Previewing…</> : "Preview (dry-run)"}
          </Button>
          <Button
            onClick={() => {
              if (!result) return;
              if (!confirm(`Apply ${result.willCreate} new + ${result.willUpdate} updates to the database? This cannot be undone automatically.`)) return;
              run(false);
            }}
            disabled={Boolean(busy) || !result || (result.willCreate + result.willUpdate === 0)}
            className="bg-brand-navy hover:opacity-90 text-white"
          >
            {busy === "apply" ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Applying…</> : "Apply Changes"}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          New users are created with role <strong>employee</strong>, status mirrored from Monday's Employment Status, and a random
          password (set <em>must change password</em>). Login invites are <strong>not</strong> emailed — you'll share credentials manually.
          Existing rows are matched by email; only employee-role users are touched.
        </p>
      </div>

      {error && (
        <div className="flex items-start gap-2 text-sm text-destructive bg-destructive/5 p-3 rounded border border-destructive/20">
          <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" /><span>{error}</span>
        </div>
      )}

      {result && (
        <div className="space-y-4">
          {result.applied && (
            <div className="flex items-center gap-2 text-sm text-emerald-700 bg-emerald-50 p-3 rounded border border-emerald-200">
              <CheckCircle2 className="w-4 h-4" />
              Changes applied. {result.willCreate} created, {result.willUpdate} updated.
            </div>
          )}

          <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
            <Stat label="Total on Monday" value={result.totalFromMonday} />
            <Stat label="To Create" value={result.willCreate} accent="emerald" />
            <Stat label="To Update" value={result.willUpdate} accent="blue" />
            <Stat label="Skipped (no email)" value={result.skippedNoEmail} accent="amber" />
            <Stat label="Skipped (conflict)" value={result.skippedConflict} accent="amber" />
          </div>

          {result.errors.length > 0 && (
            <div className="bg-destructive/5 border border-destructive/20 rounded p-3 text-sm">
              <div className="font-semibold text-destructive mb-1">{result.errors.length} row error(s):</div>
              <ul className="list-disc pl-5 text-xs">
                {result.errors.map((e) => (
                  <li key={e.mondayId}>{e.mondayName}: {e.error}</li>
                ))}
              </ul>
            </div>
          )}

          <div className="flex gap-2 text-xs">
            {(["all", "create", "update", "skip"] as const).map((k) => (
              <button
                key={k}
                onClick={() => setFilter(k)}
                className={`px-3 py-1 rounded border ${filter === k ? "bg-brand-navy text-white border-brand-navy" : "bg-white text-brand-navy border-gray-300 hover:bg-gray-50"}`}
              >
                {k === "all" ? `All (${result.decisions.length})` : k}
              </button>
            ))}
          </div>

          <div className="border rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-xs uppercase text-gray-600">
                <tr>
                  <th className="text-left p-2 w-12">Action</th>
                  <th className="text-left p-2">Name</th>
                  <th className="text-left p-2">Email</th>
                  <th className="text-left p-2">Details</th>
                </tr>
              </thead>
              <tbody>
                {filtered.slice(0, 200).map((d) => (
                  <tr key={d.mondayId} className="border-t align-top">
                    <td className="p-2"><ActionBadge action={d.action} /></td>
                    <td className="p-2 font-medium">{d.mondayName}</td>
                    <td className="p-2 text-muted-foreground">{d.email ?? "—"}</td>
                    <td className="p-2 text-xs">
                      {d.reason && <div className="text-amber-700">{d.reason}</div>}
                      {d.changes && Object.keys(d.changes).length > 0 && (
                        <ul className="text-gray-600 space-y-0.5">
                          {Object.entries(d.changes).slice(0, 6).map(([k, v]) => (
                            <li key={k}>
                              <span className="font-mono text-[10px] bg-gray-100 px-1 rounded">{k}</span>{" "}
                              {d.action === "create" ? (
                                <span className="text-emerald-700">{String(v.to).slice(0, 60)}</span>
                              ) : (
                                <>
                                  <span className="line-through text-gray-400">{String(v.from ?? "∅").slice(0, 30)}</span>{" "}
                                  → <span className="text-blue-700">{String(v.to).slice(0, 30)}</span>
                                </>
                              )}
                            </li>
                          ))}
                          {Object.keys(d.changes).length > 6 && (
                            <li className="text-gray-400">+{Object.keys(d.changes).length - 6} more…</li>
                          )}
                        </ul>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {filtered.length > 200 && (
              <div className="p-2 text-xs text-center text-muted-foreground bg-gray-50">
                Showing first 200 of {filtered.length} rows.
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, accent }: { label: string; value: number; accent?: "emerald" | "blue" | "amber" }) {
  const color =
    accent === "emerald" ? "text-emerald-700"
    : accent === "blue" ? "text-blue-700"
    : accent === "amber" ? "text-amber-700"
    : "brand-navy";
  return (
    <div className="bg-card border rounded-lg p-3">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className={`text-2xl font-bold ${color}`}>{value}</div>
    </div>
  );
}

function ActionBadge({ action }: { action: Decision["action"] }) {
  if (action === "create") return <span className="inline-flex items-center gap-1 text-emerald-700 text-xs font-medium"><Plus className="w-3 h-3" />New</span>;
  if (action === "update") return <span className="inline-flex items-center gap-1 text-blue-700 text-xs font-medium"><Pencil className="w-3 h-3" />Update</span>;
  return <span className="inline-flex items-center gap-1 text-amber-700 text-xs font-medium"><SkipForward className="w-3 h-3" />Skip</span>;
}
