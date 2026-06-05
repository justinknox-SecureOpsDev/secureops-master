import { useEffect, useMemo, useState } from "react";
import { Loader2, LifeBuoy, AlertTriangle, CheckCircle2, RefreshCw, Link2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { api, ApiError } from "@/lib/api";

type OrphanGroup = {
  title: string;
  clientName: string | null;
  shiftCount: number;
  upcomingCount: number;
  activeCount: number;
  completedCount: number;
  assignmentCount: number;
  earliest: string | null;
  latest: string | null;
};

type OrphansResp = {
  groups: OrphanGroup[];
  totalShifts: number;
  totalAssignments: number;
};

type SiteOption = {
  id: string;
  name: string;
  clientName: string | null;
};

type ReattachResp = {
  reattached: number;
  assignmentsAffected: number;
  siteId: string;
  siteName: string;
};

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

// A group's stable identity is the (title, clientName) pair the server groups
// by — title alone collides when two deleted sites shared a shift title. NULL
// and empty-string clientName are distinct SQL groups, so they must encode to
// distinct ids (a sentinel for NULL, never an empty string).
function groupId(g: Pick<OrphanGroup, "title" | "clientName">): string {
  return `${g.title}\u0000${g.clientName === null ? "\u0000NULL" : g.clientName}`;
}

export default function ShiftRecoveryPage() {
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<OrphansResp | null>(null);
  const [sites, setSites] = useState<SiteOption[]>([]);
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [targetSiteId, setTargetSiteId] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [toast, setToast] = useState<{ kind: "ok" | "err"; msg: string } | null>(null);

  function notify(kind: "ok" | "err", msg: string) {
    setToast({ kind, msg });
    window.setTimeout(() => setToast(null), 6000);
  }

  async function load() {
    setLoading(true);
    try {
      const [orphans, siteRows] = await Promise.all([
        api<OrphansResp>("/admin/orphaned-shifts"),
        api<SiteOption[]>("/sites"),
      ]);
      setData(orphans);
      setSites(siteRows);
    } catch (e) {
      notify("err", e instanceof ApiError ? e.message : "Failed to load orphaned shifts");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  const groups = data?.groups ?? [];

  const selectedGroups = useMemo(
    () => groups.filter((g) => selected[groupId(g)]),
    [groups, selected],
  );
  const selectedShiftCount = useMemo(
    () => selectedGroups.reduce((n, g) => n + g.shiftCount, 0),
    [selectedGroups],
  );
  const selectedAssignmentCount = useMemo(
    () => selectedGroups.reduce((n, g) => n + g.assignmentCount, 0),
    [selectedGroups],
  );

  const targetSite = sites.find((s) => s.id === targetSiteId) ?? null;
  const canReattach = selectedGroups.length > 0 && !!targetSiteId && !busy;

  function toggle(gid: string) {
    setSelected((prev) => ({ ...prev, [gid]: !prev[gid] }));
  }

  async function reattach() {
    if (!canReattach) return;
    setBusy(true);
    try {
      const resp = await api<ReattachResp>("/admin/orphaned-shifts/reattach", {
        method: "POST",
        body: {
          siteId: targetSiteId,
          groups: selectedGroups.map((g) => ({ title: g.title, clientName: g.clientName })),
        },
      });
      notify(
        "ok",
        `Reattached ${resp.reattached} shift${resp.reattached === 1 ? "" : "s"} ` +
          `(${resp.assignmentsAffected} assignment${resp.assignmentsAffected === 1 ? "" : "s"}) to ${resp.siteName}.`,
      );
      setSelected({});
      await load();
    } catch (e) {
      notify("err", e instanceof ApiError ? e.message : "Failed to reattach shifts");
    } finally {
      setBusy(false);
      setConfirmOpen(false);
    }
  }

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <div className="flex items-start justify-between gap-4 mb-6">
        <div>
          <h1 className="text-2xl font-semibold text-brand-navy flex items-center gap-2">
            <LifeBuoy className="h-6 w-6 text-brand-gold" />
            Shift Recovery
          </h1>
          <p className="text-sm text-muted-foreground mt-1 max-w-2xl">
            When a site is deleted, its shifts survive but lose their site link. Recreate the
            site here in the app, then pick the orphaned shift group(s) below and reattach them to
            it. Each shift keeps its times, rates and assigned officers — only the site link is
            restored.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading || busy}>
          <RefreshCw className={`h-4 w-4 mr-2 ${loading ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-muted-foreground py-12 justify-center">
          <Loader2 className="h-5 w-5 animate-spin" /> Loading orphaned shifts…
        </div>
      ) : groups.length === 0 ? (
        <div className="rounded-lg border border-dashed bg-card p-10 text-center">
          <CheckCircle2 className="h-8 w-8 text-emerald-600 mx-auto mb-3" />
          <div className="font-medium text-brand-navy">No orphaned shifts</div>
          <p className="text-sm text-muted-foreground mt-1">
            Every shift is attached to a site. Nothing to recover.
          </p>
        </div>
      ) : (
        <>
          <div className="rounded-lg border bg-card overflow-hidden">
            <div className="px-4 py-3 border-b bg-muted/40 text-sm text-brand-navy flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-amber-600" />
              <span>
                {data?.totalShifts ?? 0} orphaned shift{(data?.totalShifts ?? 0) === 1 ? "" : "s"} across{" "}
                {groups.length} group{groups.length === 1 ? "" : "s"} ({data?.totalAssignments ?? 0} assignment
                {(data?.totalAssignments ?? 0) === 1 ? "" : "s"})
              </span>
            </div>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-muted-foreground border-b">
                  <th className="px-4 py-2 w-10"></th>
                  <th className="px-4 py-2">Shift title</th>
                  <th className="px-4 py-2">Client (was)</th>
                  <th className="px-4 py-2 text-right">Shifts</th>
                  <th className="px-4 py-2 text-right">Assignments</th>
                  <th className="px-4 py-2">Date range</th>
                </tr>
              </thead>
              <tbody>
                {groups.map((g) => {
                  const gid = groupId(g);
                  return (
                  <tr
                    key={gid}
                    className="border-b last:border-0 hover:bg-muted/30 cursor-pointer"
                    onClick={() => toggle(gid)}
                  >
                    <td className="px-4 py-2">
                      <input
                        type="checkbox"
                        checked={!!selected[gid]}
                        onChange={() => toggle(gid)}
                        onClick={(e) => e.stopPropagation()}
                        aria-label={`Select ${g.title}${g.clientName ? ` (${g.clientName})` : ""}`}
                        className="h-4 w-4 accent-brand-gold"
                      />
                    </td>
                    <td className="px-4 py-2 font-medium text-brand-navy">{g.title}</td>
                    <td className="px-4 py-2 text-muted-foreground">{g.clientName ?? "—"}</td>
                    <td className="px-4 py-2 text-right tabular-nums">
                      {g.shiftCount}
                      <span className="text-xs text-muted-foreground ml-1">
                        ({g.upcomingCount}↑ {g.activeCount}● {g.completedCount}✓)
                      </span>
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums">{g.assignmentCount}</td>
                    <td className="px-4 py-2 text-muted-foreground whitespace-nowrap">
                      {fmtDate(g.earliest)} – {fmtDate(g.latest)}
                    </td>
                  </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="mt-6 rounded-lg border bg-card p-4">
            <div className="flex flex-col sm:flex-row sm:items-end gap-4">
              <div className="flex-1">
                <label className="text-sm font-medium text-brand-navy block mb-1">
                  Reattach selected to site
                </label>
                <Select value={targetSiteId} onValueChange={setTargetSiteId}>
                  <SelectTrigger className="w-full sm:max-w-md">
                    <SelectValue placeholder="Choose the site to attach these shifts to…" />
                  </SelectTrigger>
                  <SelectContent>
                    {sites.map((s) => (
                      <SelectItem key={s.id} value={s.id}>
                        {s.name}
                        {s.clientName ? ` · ${s.clientName}` : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <Button
                onClick={() => setConfirmOpen(true)}
                disabled={!canReattach}
                className="bg-brand-gold text-brand-navy hover:bg-brand-gold/90"
              >
                {busy ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Link2 className="h-4 w-4 mr-2" />}
                Reattach {selectedShiftCount > 0 ? `${selectedShiftCount} shift${selectedShiftCount === 1 ? "" : "s"}` : "shifts"}
              </Button>
            </div>
            {selectedGroups.length > 0 && (
              <p className="text-xs text-muted-foreground mt-2">
                {selectedGroups.length} group{selectedGroups.length === 1 ? "" : "s"} selected ·{" "}
                {selectedShiftCount} shift{selectedShiftCount === 1 ? "" : "s"} · {selectedAssignmentCount} assignment
                {selectedAssignmentCount === 1 ? "" : "s"}
              </p>
            )}
          </div>
        </>
      )}

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Reattach shifts to {targetSite?.name ?? "this site"}?</AlertDialogTitle>
            <AlertDialogDescription>
              This will link {selectedShiftCount} orphaned shift{selectedShiftCount === 1 ? "" : "s"} (and{" "}
              {selectedAssignmentCount} assignment{selectedAssignmentCount === 1 ? "" : "s"}) to{" "}
              <span className="font-medium">{targetSite?.name ?? ""}</span>. Only shifts that are
              currently unattached are affected, so this is safe to run.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                void reattach();
              }}
              disabled={busy}
            >
              {busy ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}
              Reattach
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {toast && (
        <div
          className={`fixed bottom-6 right-6 z-50 max-w-sm rounded-lg px-4 py-3 text-sm shadow-lg flex items-start gap-2 ${
            toast.kind === "ok"
              ? "bg-emerald-50 text-emerald-900 border border-emerald-200"
              : "bg-red-50 text-red-900 border border-red-200"
          }`}
        >
          {toast.kind === "ok" ? (
            <CheckCircle2 className="h-4 w-4 mt-0.5 shrink-0" />
          ) : (
            <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
          )}
          <div className="flex-1">{toast.msg}</div>
        </div>
      )}
    </div>
  );
}
