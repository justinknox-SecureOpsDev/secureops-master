import { useState } from "react";
import { api, ApiError } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AlertCircle, CheckCircle2, Loader2, Database, Plus, Pencil, SkipForward } from "lucide-react";

type Kind = "employees" | "clients" | "sites" | "onboarding" | "candidates" | "shifts";

const KINDS: { value: Kind; label: string; defaultBoard: string; target: string; matchKey: string; help: string }[] = [
  { value: "employees", label: "Employees", defaultBoard: "18408899656", target: "users + employees + licenses",
    matchKey: "email", help: "Master Employee Database. Creates user accounts (no invites)." },
  { value: "clients", label: "Clients", defaultBoard: "18408899653", target: "clients",
    matchKey: "name", help: "Run before Sites. Matches by client name." },
  { value: "sites", label: "Sites", defaultBoard: "18408899655", target: "sites",
    matchKey: "name + linked client", help: "Requires Clients to be synced first; resolves client by linked Monday board relation." },
  { value: "onboarding", label: "Onboarding", defaultBoard: "18399600913", target: "users + employees (update only)",
    matchKey: "email", help: "Updates existing employees with bank/SSN/license/EC/uniform from the Onboarding board." },
  { value: "candidates", label: "Candidates → Applications", defaultBoard: "18399600911", target: "applications",
    matchKey: "email", help: "Brings recruiting candidates into the HR Applications inbox." },
  { value: "shifts", label: "Assignments → Sites + Drafts", defaultBoard: "18408889225", target: "sites (default rates) + shifts (drafts)",
    matchKey: "site name", help: "For each Assignments row: updates the matching Site's default pay/bill rates AND creates a draft shift template (status=draft, placeholder times 2099-01-01) hidden from officers. Run Sites first." },
];

type Decision = {
  mondayId: string;
  mondayName: string;
  matchKey: string | null;
  action: "create" | "update" | "skip-no-key" | "skip-conflict" | "skip-unmatched";
  reason?: string;
  changes?: Record<string, { from: unknown; to: unknown }>;
};
type SyncResult = {
  kind: Kind; boardId: string;
  totalFromMonday: number; willCreate: number; willUpdate: number;
  skippedNoKey: number; skippedConflict: number; skippedUnmatched: number;
  decisions: Decision[]; applied: boolean;
  errors: { mondayId: string; mondayName: string; error: string }[];
};

export function MondaySyncPage() {
  const [kind, setKind] = useState<Kind>("employees");
  const cfg = KINDS.find((k) => k.value === kind)!;
  const [boardId, setBoardId] = useState(cfg.defaultBoard);
  const [busy, setBusy] = useState<"dry" | "apply" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SyncResult | null>(null);
  const [filter, setFilter] = useState<"all" | "create" | "update" | "skip">("all");

  function selectKind(k: Kind) {
    setKind(k);
    setBoardId(KINDS.find((x) => x.value === k)!.defaultBoard);
    setResult(null); setError(null);
  }

  async function run(dryRun: boolean) {
    setBusy(dryRun ? "dry" : "apply");
    setError(null);
    if (!dryRun) setResult(null);
    try {
      const res = await api<SyncResult>("/admin/integrations/monday/sync", {
        method: "POST",
        body: { kind, boardId, dryRun },
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
          <h1 className="text-xl font-bold brand-navy">Monday.com Sync</h1>
          <p className="text-sm text-muted-foreground">One-way pull from Monday boards into our database.</p>
        </div>
      </div>

      <div className="bg-card border rounded-lg p-4 space-y-4">
        <div>
          <Label className="text-xs uppercase font-semibold brand-navy mb-2 block">Board to sync</Label>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
            {KINDS.map((k) => (
              <button
                key={k.value}
                onClick={() => selectKind(k.value)}
                disabled={Boolean(busy)}
                className={`text-left px-3 py-2 rounded border text-sm transition ${
                  kind === k.value
                    ? "bg-brand-navy text-white border-brand-navy"
                    : "bg-white text-brand-navy border-gray-300 hover:border-brand-gold"
                }`}
              >
                <div className="font-semibold">{k.label}</div>
                <div className={`text-[10px] mt-0.5 ${kind === k.value ? "opacity-70" : "text-muted-foreground"}`}>
                  → {k.target}
                </div>
              </button>
            ))}
          </div>
          <p className="text-xs text-muted-foreground mt-2">
            <strong>{cfg.label}:</strong> {cfg.help} <em>Match key: {cfg.matchKey}.</em>
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-[1fr_auto_auto] gap-3 items-end">
          <div>
            <Label htmlFor="boardId" className="text-xs uppercase font-semibold brand-navy">Monday Board ID</Label>
            <Input
              id="boardId" value={boardId} onChange={(e) => setBoardId(e.target.value)}
              placeholder={cfg.defaultBoard} disabled={Boolean(busy)}
            />
          </div>
          <Button onClick={() => run(true)} disabled={Boolean(busy) || !boardId} variant="outline">
            {busy === "dry" ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Previewing…</> : "Preview (dry-run)"}
          </Button>
          <Button
            onClick={() => {
              if (!result) return;
              const total = result.willCreate + result.willUpdate;
              if (!confirm(`Apply ${result.willCreate} new + ${result.willUpdate} updates to ${cfg.target}? (${total} writes total)`)) return;
              run(false);
            }}
            disabled={Boolean(busy) || !result || (result.willCreate + result.willUpdate === 0)}
            className="bg-brand-navy hover:opacity-90 text-white"
          >
            {busy === "apply" ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Applying…</> : "Apply Changes"}
          </Button>
        </div>
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

          <div className="grid grid-cols-2 md:grid-cols-6 gap-3">
            <Stat label="From Monday" value={result.totalFromMonday} />
            <Stat label="To Create" value={result.willCreate} accent="emerald" />
            <Stat label="To Update" value={result.willUpdate} accent="blue" />
            <Stat label="Skip (no key)" value={result.skippedNoKey} accent="amber" />
            <Stat label="Skip (unmatched)" value={result.skippedUnmatched} accent="amber" />
            <Stat label="Skip (conflict)" value={result.skippedConflict} accent="amber" />
          </div>

          {result.errors.length > 0 && (
            <div className="bg-destructive/5 border border-destructive/20 rounded p-3 text-sm">
              <div className="font-semibold text-destructive mb-1">{result.errors.length} row error(s):</div>
              <ul className="list-disc pl-5 text-xs">
                {result.errors.map((e) => <li key={e.mondayId}>{e.mondayName}: {e.error}</li>)}
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
                  <th className="text-left p-2 w-20">Action</th>
                  <th className="text-left p-2">Row</th>
                  <th className="text-left p-2">Match Key</th>
                  <th className="text-left p-2">Details</th>
                </tr>
              </thead>
              <tbody>
                {filtered.slice(0, 250).map((d) => (
                  <tr key={d.mondayId} className="border-t align-top">
                    <td className="p-2"><ActionBadge action={d.action} /></td>
                    <td className="p-2 font-medium">{d.mondayName}</td>
                    <td className="p-2 text-muted-foreground text-xs">{d.matchKey ?? "—"}</td>
                    <td className="p-2 text-xs">
                      {d.reason && <div className="text-amber-700">{d.reason}</div>}
                      {d.changes && Object.keys(d.changes).length > 0 && (
                        <ul className="text-gray-600 space-y-0.5">
                          {Object.entries(d.changes).slice(0, 6).map(([k, v]) => (
                            <li key={k}>
                              <span className="font-mono text-[10px] bg-gray-100 px-1 rounded">{k}</span>{" "}
                              {d.action === "create" ? (
                                <span className="text-emerald-700">{String(v.to).slice(0, 70)}</span>
                              ) : (
                                <>
                                  <span className="line-through text-gray-400">{String(v.from ?? "∅").slice(0, 30)}</span>{" "}
                                  → <span className="text-blue-700">{String(v.to).slice(0, 35)}</span>
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
            {filtered.length > 250 && (
              <div className="p-2 text-xs text-center text-muted-foreground bg-gray-50">
                Showing first 250 of {filtered.length} rows.
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
