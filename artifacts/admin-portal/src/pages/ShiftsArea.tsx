import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation, useSearch } from "wouter";
import { api } from "@/lib/api";
import { useFirstQueryParam } from "@/hooks/useDeepLinkFocus";
import { ShiftDialog } from "@/components/ShiftDialog";
import { RepeatingShiftDialog } from "@/components/RepeatingShiftDialog";
import { BulkEditSeriesDialog, type BulkSeriesTarget } from "@/components/BulkEditSeriesDialog";
import { ShiftDetailPanel } from "@/components/shifts/ShiftDetailPanel";
import { ShiftsCalendarView } from "@/components/shifts/ShiftsCalendarView";
import { ShiftsListView } from "@/components/shifts/ShiftsListView";
import {
  Shift, SiteRow, PendingClaim, ShiftFilters, EMPTY_FILTERS, STATUS_OPTIONS,
  StatusFilter, StaffingFilter, fmtDateTime, fmtTimeOfDay, levelBadge, seriesKeyFor,
} from "@/components/shifts/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  CalendarDays, List, Plus, CalendarRange, RefreshCw, UserCheck, Check, X,
} from "lucide-react";

type ViewMode = "calendar" | "list";

export default function ShiftsAreaPage() {
  const qc = useQueryClient();
  const [, navigate] = useLocation();
  const searchStr = useSearch();

  const focusShiftId = useFirstQueryParam("focus", "shiftId");

  // ?view= drives the mode. Default: calendar — unless a deep link (?focus=)
  // arrived without an explicit view, in which case the list is a better
  // landing because it can scroll to + flash the exact row.
  const params = useMemo(() => new URLSearchParams(searchStr), [searchStr]);
  const explicitView = params.get("view");
  const view: ViewMode =
    explicitView === "list" ? "list"
    : explicitView === "calendar" ? "calendar"
    : focusShiftId ? "list"
    : "calendar";

  const setView = (v: ViewMode) => {
    const next = new URLSearchParams(searchStr);
    next.set("view", v);
    navigate(`/shifts?${next.toString()}`, { replace: true });
  };

  const [filters, setFilters] = useState<ShiftFilters>(EMPTY_FILTERS);
  const [jumpDate, setJumpDate] = useState<string | null>(null);

  const [creating, setCreating] = useState(false);
  const [createInitial, setCreateInitial] = useState<{ startTime: string; endTime: string } | null>(null);
  const [editing, setEditing] = useState<Shift | null>(null);
  const [repeatOpen, setRepeatOpen] = useState(false);
  const [editSeries, setEditSeries] = useState<BulkSeriesTarget | null>(null);
  const [deleting, setDeleting] = useState<Shift | null>(null);
  const [panelShiftId, setPanelShiftId] = useState<string | null>(focusShiftId);
  const [panelOpen, setPanelOpen] = useState(false);
  const [claimBusyId, setClaimBusyId] = useState<string | null>(null);
  const [claimToast, setClaimToast] = useState<{ kind: "ok" | "err"; msg: string } | null>(null);

  const sitesQuery = useQuery<SiteRow[]>({
    queryKey: ["shifts-area", "sites"],
    queryFn: () => api<SiteRow[]>(`/sites`),
  });
  const sites = useMemo(() => sitesQuery.data ?? [], [sitesQuery.data]);

  const siteIndex = useMemo(() => {
    const m = new Map<string, { name: string; clientName: string | null }>();
    for (const s of sites) m.set(s.id, { name: s.name, clientName: s.clientName });
    return m;
  }, [sites]);

  const clientOptions = useMemo(() => {
    const set = new Set<string>();
    for (const s of sites) if (s.clientName) set.add(s.clientName);
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [sites]);

  // Pending officer self-claims — always derived from the upcoming list so the
  // approval panel is visible in both views regardless of active filters.
  const claimsQuery = useQuery<PendingClaim[]>({
    queryKey: ["shifts-area", "claims"],
    queryFn: async () => {
      const rows = await api<Shift[]>(`/shifts?status=upcoming`);
      const out: PendingClaim[] = [];
      for (const s of rows ?? []) {
        for (const a of s.assignments ?? []) {
          if (a.status !== "pending_approval") continue;
          out.push({
            shiftId: s.id, assignmentId: a.id, employeeName: a.employeeName,
            shiftTitle: s.title, clientName: s.clientName, location: s.location,
            startTime: s.startTime, endTime: s.endTime, requiredLicenseLevel: s.requiredLicenseLevel,
          });
        }
      }
      out.sort((a, b) => a.startTime.localeCompare(b.startTime));
      return out;
    },
  });
  const pendingClaims = claimsQuery.data ?? [];

  // Deep link: fetch the focused shift so the calendar can move its anchor to it.
  const focusQuery = useQuery<Shift>({
    queryKey: ["shifts-area", "detail", focusShiftId],
    queryFn: () => api<Shift>(`/shifts/${focusShiftId}`),
    enabled: !!focusShiftId,
  });

  const refresh = () => qc.invalidateQueries({ queryKey: ["shifts-area"] });

  const openPanel = (s: Shift) => { setPanelShiftId(s.id); setPanelOpen(true); };

  const decideClaim = async (shiftId: string, assignmentId: string, decision: "accepted" | "declined") => {
    setClaimBusyId(assignmentId);
    try {
      await api(`/shifts/${shiftId}/assignments/${assignmentId}`, { method: "PUT", body: { status: decision } });
      refresh();
      setClaimToast({
        kind: "ok",
        msg: decision === "accepted"
          ? "Shift claim approved — the officer is now confirmed."
          : "Shift claim declined — the slot is open again.",
      });
    } catch (e) {
      setClaimToast({ kind: "err", msg: e instanceof Error ? e.message : "Failed to update the claim." });
    } finally {
      setClaimBusyId(null);
    }
  };

  const handleDelete = async () => {
    if (!deleting) return;
    try {
      await api(`/shifts/${deleting.id}`, { method: "DELETE" });
      setDeleting(null);
      setPanelOpen(false);
      refresh();
    } catch (e) {
      alert(e instanceof Error ? e.message : "Failed to delete shift");
    }
  };

  const handleCreateAt = (date: Date) => {
    const start = new Date(date);
    start.setHours(9, 0, 0, 0);
    const end = new Date(date);
    end.setHours(17, 0, 0, 0);
    setCreateInitial({ startTime: start.toISOString(), endTime: end.toISOString() });
    setCreating(true);
  };

  const setFilter = <K extends keyof ShiftFilters>(k: K, v: ShiftFilters[K]) =>
    setFilters((f) => ({ ...f, [k]: v }));

  return (
    <div className="flex-1 overflow-auto p-4 sm:p-6 space-y-4">
      {/* ── Header ── */}
      <div className="flex flex-wrap items-center gap-3">
        <div>
          <h1 className="text-2xl font-bold">Shifts</h1>
          <p className="text-sm text-muted-foreground">
            {view === "calendar"
              ? "Click a day to add a shift, click a shift for details and staffing."
              : "Flat list of shifts — click a row for details, sort any column."}
          </p>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <div className="flex items-center rounded-md border overflow-hidden text-sm" role="tablist" aria-label="Shifts view">
            <button
              role="tab"
              aria-selected={view === "calendar"}
              onClick={() => setView("calendar")}
              className={`px-3 py-1.5 font-medium transition-colors flex items-center gap-1.5 border-r ${
                view === "calendar" ? "bg-brand-gold text-sidebar" : "hover:bg-muted"
              }`}
            >
              <CalendarDays className="w-4 h-4" /> Calendar
            </button>
            <button
              role="tab"
              aria-selected={view === "list"}
              onClick={() => setView("list")}
              className={`px-3 py-1.5 font-medium transition-colors flex items-center gap-1.5 ${
                view === "list" ? "bg-brand-gold text-sidebar" : "hover:bg-muted"
              }`}
            >
              <List className="w-4 h-4" /> List
            </button>
          </div>
          <Button variant="outline" size="icon" title="Refresh" aria-label="Refresh" onClick={refresh}>
            <RefreshCw className="w-4 h-4" />
          </Button>
          <Button variant="outline" onClick={() => setRepeatOpen(true)}>
            <CalendarRange className="w-4 h-4 mr-1" /> Repeating Shift
          </Button>
          <Button onClick={() => { setCreateInitial(null); setCreating(true); }}>
            <Plus className="w-4 h-4 mr-1" /> New Shift
          </Button>
        </div>
      </div>

      {/* ── Shared filter bar ── */}
      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={filters.search}
          onChange={(e) => setFilter("search", e.target.value)}
          placeholder="Search title, site, client, officer…"
          className="w-full sm:w-64"
          aria-label="Search shifts"
        />
        <Select value={filters.siteId || "__all__"} onValueChange={(v) => setFilter("siteId", v === "__all__" ? "" : v)}>
          <SelectTrigger className="w-full sm:w-44" aria-label="Filter by site"><SelectValue placeholder="All sites" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="__all__">All sites</SelectItem>
            {sites.map((s) => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}
          </SelectContent>
        </Select>
        {clientOptions.length > 0 && (
          <Select value={filters.client || "__all__"} onValueChange={(v) => setFilter("client", v === "__all__" ? "" : v)}>
            <SelectTrigger className="w-full sm:w-44" aria-label="Filter by client"><SelectValue placeholder="All clients" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="__all__">All clients</SelectItem>
              {clientOptions.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}
            </SelectContent>
          </Select>
        )}
        <Select value={filters.status} onValueChange={(v) => setFilter("status", v as StatusFilter)}>
          <SelectTrigger className="w-full sm:w-36" aria-label="Filter by status"><SelectValue /></SelectTrigger>
          <SelectContent>
            {STATUS_OPTIONS.map((s) => (
              <SelectItem key={s} value={s} className="capitalize">{s === "all" ? "All statuses" : s}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={filters.staffing} onValueChange={(v) => setFilter("staffing", v as StaffingFilter)}>
          <SelectTrigger className="w-full sm:w-36" aria-label="Filter by staffing"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All staffing</SelectItem>
            <SelectItem value="open">Open slots</SelectItem>
            <SelectItem value="filled">Fully staffed</SelectItem>
          </SelectContent>
        </Select>
        <div className="flex items-center gap-1">
          <Input
            type="date"
            value={jumpDate ?? ""}
            onChange={(e) => setJumpDate(e.target.value || null)}
            className="w-40"
            aria-label={view === "calendar" ? "Jump calendar to date" : "Show shifts from date"}
            title={view === "calendar" ? "Jump calendar to date" : "Show shifts from this date onward"}
          />
          {jumpDate && (
            <Button variant="ghost" size="icon" aria-label="Clear date" onClick={() => setJumpDate(null)}>
              <X className="w-4 h-4" />
            </Button>
          )}
        </div>
      </div>

      {claimToast && (
        <div className={`flex items-start gap-3 rounded-lg border px-4 py-3 text-sm ${
          claimToast.kind === "ok" ? "bg-green-50 border-green-300 text-green-900" : "bg-red-50 border-red-300 text-red-900"
        }`}>
          <div className="flex-1">{claimToast.msg}</div>
          <button type="button" onClick={() => setClaimToast(null)} className="text-xs underline shrink-0">Dismiss</button>
        </div>
      )}

      {/* ── Pending claims (both views) ── */}
      {pendingClaims.length > 0 && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 overflow-hidden">
          <div className="px-4 py-3 border-b border-amber-200 flex items-center gap-2">
            <UserCheck className="w-4 h-4 text-amber-700 shrink-0" />
            <span className="font-semibold text-amber-900">
              {pendingClaims.length} shift {pendingClaims.length === 1 ? "claim" : "claims"} awaiting approval
            </span>
          </div>
          <div className="divide-y divide-amber-200">
            {pendingClaims.map((c) => {
              const busy = claimBusyId === c.assignmentId;
              const lvl = levelBadge(c.requiredLicenseLevel);
              return (
                <div key={c.assignmentId} className="flex flex-wrap items-center gap-3 px-4 py-3">
                  <div className="flex-1 min-w-0">
                    <div className="font-medium truncate">{c.employeeName ?? "Officer"}</div>
                    <div className="text-xs text-muted-foreground truncate">
                      {c.shiftTitle}{c.clientName ? ` · ${c.clientName}` : ""}{c.location ? ` · ${c.location}` : ""}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {fmtDateTime(c.startTime)} – {fmtTimeOfDay(c.endTime)}
                    </div>
                  </div>
                  <span className={`text-xs px-2 py-0.5 rounded border ${lvl.cls}`}>{lvl.label}</span>
                  <div className="flex items-center gap-2 shrink-0">
                    <Button size="sm" disabled={busy} onClick={() => decideClaim(c.shiftId, c.assignmentId, "accepted")}>
                      <Check className="w-3.5 h-3.5 mr-1" /> Approve
                    </Button>
                    <Button
                      variant="outline" size="sm" disabled={busy}
                      className="border-red-300 text-red-700 hover:bg-red-50"
                      onClick={() => decideClaim(c.shiftId, c.assignmentId, "declined")}
                    >
                      <X className="w-3.5 h-3.5 mr-1" /> Decline
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ── Active view ── */}
      {view === "calendar" ? (
        <ShiftsCalendarView
          filters={filters}
          siteIndex={siteIndex}
          onSelect={openPanel}
          onCreateAt={handleCreateAt}
          jumpDate={jumpDate}
          focusStartTime={focusQuery.data?.startTime ?? null}
          focusShiftId={focusShiftId}
        />
      ) : (
        <ShiftsListView
          filters={filters}
          siteIndex={siteIndex}
          focusShiftId={focusShiftId}
          jumpDate={jumpDate}
          onSelect={openPanel}
          onEdit={(s) => setEditing(s)}
          onEditSeries={(t) => setEditSeries(t)}
          onDelete={(s) => setDeleting(s)}
        />
      )}

      {/* ── Detail panel ── */}
      <ShiftDetailPanel
        shiftId={panelShiftId}
        open={panelOpen}
        onOpenChange={setPanelOpen}
        siteIndex={siteIndex}
        onEdit={(s) => { setPanelOpen(false); setEditing(s); }}
        onEditSeries={async (s) => {
          setPanelOpen(false);
          const siteLabel = s.siteId
            ? (siteIndex.get(s.siteId)?.name ?? s.location ?? "Unnamed site")
            : (s.location ?? "No site");
          const wanted = seriesKeyFor(s);
          try {
            // Resolve every occurrence in the series (across statuses) so the
            // bulk edit hits the whole series, not just this occurrence.
            const all = await api<Shift[]>(`/shifts`);
            const ids = (all ?? []).filter((x) => x.isRepeat && seriesKeyFor(x) === wanted).map((x) => x.id);
            setEditSeries({ ids: ids.length > 0 ? ids : [s.id], title: s.title, siteLabel });
          } catch {
            setEditSeries({ ids: [s.id], title: s.title, siteLabel });
          }
        }}
        onDelete={(s) => { setDeleting(s); }}
        onChanged={refresh}
      />

      {/* ── Dialogs ── */}
      <RepeatingShiftDialog
        open={repeatOpen}
        onOpenChange={setRepeatOpen}
        onCreated={() => { setRepeatOpen(false); refresh(); }}
      />

      <BulkEditSeriesDialog
        open={!!editSeries}
        onOpenChange={(b) => { if (!b) setEditSeries(null); }}
        target={editSeries}
        onSaved={() => { setEditSeries(null); refresh(); }}
      />

      <ShiftDialog
        open={!!editing || creating}
        onOpenChange={(b) => { if (!b) { setEditing(null); setCreating(false); setCreateInitial(null); } }}
        initial={
          editing
            ? (editing as unknown as React.ComponentProps<typeof ShiftDialog>["initial"])
            : createInitial
        }
        onSaved={() => { setEditing(null); setCreating(false); setCreateInitial(null); refresh(); }}
      />

      <AlertDialog open={!!deleting} onOpenChange={(b) => { if (!b) setDeleting(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete shift?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently removes "{deleting?.title}" and all its assignments. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
