import { useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import { getTable } from "@/lib/tables";
import { RowFormDialog } from "@/components/RowFormDialog";
import { RepeatingShiftDialog } from "@/components/RepeatingShiftDialog";
import { BulkEditSeriesDialog, type BulkSeriesTarget } from "@/components/BulkEditSeriesDialog";
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
  ChevronDown, ChevronRight, MapPin, Repeat, Pencil, Trash2,
  Users, Plus, RefreshCw, CalendarRange,
} from "lucide-react";

type Shift = {
  id: string;
  title: string;
  siteId: string | null;
  clientName: string | null;
  location: string | null;
  startTime: string;
  endTime: string;
  payRate: string;
  billRate: string;
  status: "upcoming" | "active" | "completed" | "cancelled";
  requiredLicenseLevel: number;
  headcount: number;
  isRepeat: boolean;
  repeatPattern: string | null;
  seriesId: string | null;
  notes: string | null;
  assignments: { id: string; status: string; employeeName: string | null }[];
};

const STATUS_OPTIONS = ["all", "upcoming", "active", "completed", "cancelled"] as const;
type StatusFilter = (typeof STATUS_OPTIONS)[number];

const NO_SITE_KEY = "__no_site__";
const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;

function fmtDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    weekday: "short", month: "short", day: "numeric",
    hour: "numeric", minute: "2-digit",
  });
}

function fmtTimeOfDay(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

// "HH:MM" in the supplied IANA zone (24h) for an ISO instant. Used to
// compare what a recurring shift actually starts at against the user's
// originally-intended HH:MM stored in repeatPattern.
function localHHMM(iso: string, tz: string): string | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  try {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false,
    }).formatToParts(d);
    const h = parts.find((p) => p.type === "hour")?.value ?? "";
    const m = parts.find((p) => p.type === "minute")?.value ?? "";
    if (!h || !m) return null;
    return `${h === "24" ? "00" : h}:${m}`;
  } catch { return null; }
}

// WCSG operates in Texas. Detection and repair are both pinned to
// America/Chicago so the action is idempotent regardless of where the
// admin's browser is — running it from a laptop in another zone won't
// shift times to that zone.
const REPAIR_TZ = "America/Chicago";

// A series is "affected" by the old UTC-instead-of-local bug when its first
// occurrence's Central HH:MM doesn't match the intended HH:MM stored in
// the repeatPattern. Returns the (intended, actual) pair so the UI can
// explain the fix to the admin before they click.
function detectSeriesTimezoneIssue(s: Shift | undefined): { intended: string; actual: string } | null {
  if (!s || !s.repeatPattern) return null;
  let pattern: { startTime?: unknown } | null = null;
  try { pattern = JSON.parse(s.repeatPattern); } catch { return null; }
  const intended = pattern?.startTime;
  if (typeof intended !== "string" || !/^\d{2}:\d{2}$/.test(intended)) return null;
  const actual = localHHMM(s.startTime, REPAIR_TZ);
  if (!actual) return null;
  if (actual === intended) return null;
  return { intended, actual };
}

function levelBadge(level: number): { label: string; cls: string } {
  if (level >= 4) return { label: "L4 / PPO", cls: "bg-purple-100 text-purple-800 border-purple-300" };
  if (level === 3) return { label: "L3 Armed", cls: "bg-amber-100 text-amber-800 border-amber-300" };
  return { label: "L2", cls: "bg-slate-100 text-slate-700 border-slate-300" };
}

function statusBadge(status: string): string {
  switch (status) {
    case "active": return "bg-green-100 text-green-800 border-green-300";
    case "completed": return "bg-slate-100 text-slate-600 border-slate-300";
    case "cancelled": return "bg-red-100 text-red-700 border-red-300";
    default: return "bg-blue-100 text-blue-800 border-blue-300";
  }
}

export default function ShiftsPage() {
  const descriptor = getTable("shifts")!;
  const [shifts, setShifts] = useState<Shift[]>([]);
  const [sites, setSites] = useState<{ id: string; name: string; address: string | null; clientName: string | null }[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("upcoming");
  const [search, setSearch] = useState("");
  const [openSites, setOpenSites] = useState<Record<string, boolean>>({});
  const [openSeries, setOpenSeries] = useState<Record<string, boolean>>({});
  const [editing, setEditing] = useState<Shift | null>(null);
  const [creating, setCreating] = useState(false);
  const [repeatOpen, setRepeatOpen] = useState(false);
  const [editSeries, setEditSeries] = useState<BulkSeriesTarget | null>(null);
  const [fixingSeries, setFixingSeries] = useState<
    { ids: string[]; title: string; intended: string; actual: string } | null
  >(null);
  const [fixBusy, setFixBusy] = useState(false);
  const [deleting, setDeleting] = useState<Shift | null>(null);
  const [deletingSeries, setDeletingSeries] = useState<{ ids: string[]; title: string; total: number } | null>(null);
  const [version, setVersion] = useState(0);

  const handleFixSeriesTz = async () => {
    if (!fixingSeries) return;
    setFixBusy(true);
    try {
      const result = await api<{ fixed: number; alreadyCorrect: number; skipped: number; total: number }>(
        "/shifts/series/fix-timezone",
        { method: "POST", body: { ids: fixingSeries.ids } },
      );
      alert(
        `Fixed ${result.fixed} of ${result.total} shifts in "${fixingSeries.title}".`
        + (result.alreadyCorrect ? `\n${result.alreadyCorrect} were already correct.` : "")
        + (result.skipped ? `\n${result.skipped} skipped (no recurrence pattern on file).` : ""),
      );
      setFixingSeries(null);
      setVersion((v) => v + 1);
    } catch (e: any) {
      alert(e?.message || "Failed to fix series times");
    } finally {
      setFixBusy(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const params = new URLSearchParams();
    if (statusFilter !== "all") params.set("status", statusFilter);
    Promise.all([
      api<Shift[]>(`/shifts${params.toString() ? `?${params}` : ""}`),
      api<{ id: string; name: string; address: string | null; clientName: string | null }[]>(`/sites`),
    ])
      .then(([shiftRows, siteRows]) => {
        if (cancelled) return;
        setShifts(shiftRows ?? []);
        setSites(siteRows ?? []);
      })
      .catch((e) => { console.error(e); if (!cancelled) { setShifts([]); setSites([]); } })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [statusFilter, version]);

  const siteIndex = useMemo(() => {
    const m = new Map<string, { name: string; clientName: string | null }>();
    for (const s of sites) m.set(s.id, { name: s.name, clientName: s.clientName });
    return m;
  }, [sites]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return shifts;
    return shifts.filter((s) =>
      s.title.toLowerCase().includes(q) ||
      (s.location ?? "").toLowerCase().includes(q) ||
      (s.clientName ?? "").toLowerCase().includes(q),
    );
  }, [shifts, search]);

  // Group by site, then within each site split into single shifts and
  // repeat-series (grouped by title). For repeat-series, only keep
  // occurrences in the next 7 days.
  const groups = useMemo(() => {
    const cutoff = Date.now() + ONE_WEEK_MS;

    type Group = {
      key: string;
      siteId: string | null;
      siteLabel: string;
      clientLabel: string | null;
      singles: Shift[];
      series: { key: string; title: string; total: number; occurrences: Shift[]; hidden: number; allIds: string[]; siteLabel: string }[];
    };

    const map = new Map<string, Group>();
    for (const s of filtered) {
      const key = s.siteId ?? NO_SITE_KEY;
      const liveSite = s.siteId ? siteIndex.get(s.siteId) : undefined;
      // Prefer the live site/client names (sites & clients tables) over the
      // denormalized snapshot stored on the shift row, so renames flow through.
      const siteLabel = liveSite?.name ?? s.location ?? (s.siteId ? "Unnamed site" : "No site");
      const clientLabel = liveSite?.clientName ?? s.clientName ?? null;

      let g = map.get(key);
      if (!g) {
        g = { key, siteId: s.siteId, siteLabel, clientLabel, singles: [], series: [] };
        map.set(key, g);
      } else {
        // Upgrade labels if a later shift gave us better info.
        if (liveSite?.name) g.siteLabel = liveSite.name;
        if (liveSite?.clientName && !g.clientLabel) g.clientLabel = liveSite.clientName;
      }

      if (s.isRepeat) {
        // Prefer the explicit seriesId (set by /shifts/repeat on every new
        // occurrence). Fall back to site+title+repeatPattern for legacy rows
        // created before the seriesId column existed, so bulk edit still
        // works for old data without merging unrelated series.
        const seriesKey = s.seriesId
          ? `sid::${s.seriesId}`
          : `legacy::${key}::${s.title}::${s.repeatPattern ?? ""}`;
        let series = g.series.find((x) => x.key === seriesKey);
        if (!series) {
          series = { key: seriesKey, title: s.title, total: 0, occurrences: [], hidden: 0, allIds: [], siteLabel: g.siteLabel };
          g.series.push(series);
        }
        series.total++;
        series.allIds.push(s.id);
        if (new Date(s.startTime).getTime() <= cutoff) {
          series.occurrences.push(s);
        } else {
          series.hidden++;
        }
      } else {
        g.singles.push(s);
      }
    }

    // Sort within each group/series
    for (const g of map.values()) {
      g.singles.sort((a, b) => a.startTime.localeCompare(b.startTime));
      for (const s of g.series) s.occurrences.sort((a, b) => a.startTime.localeCompare(b.startTime));
      g.series.sort((a, b) => a.title.localeCompare(b.title));
    }

    // Sort groups by site label, "no site" last
    return Array.from(map.values()).sort((a, b) => {
      if (a.key === NO_SITE_KEY) return 1;
      if (b.key === NO_SITE_KEY) return -1;
      return a.siteLabel.localeCompare(b.siteLabel);
    });
  }, [filtered]);

  const isSiteOpen = (key: string) => openSites[key] !== false; // default open
  const isSeriesOpen = (key: string) => openSeries[key] === true; // default closed
  const toggleSite = (key: string) => setOpenSites((s) => ({ ...s, [key]: !isSiteOpen(key) }));
  const toggleSeries = (key: string) => setOpenSeries((s) => ({ ...s, [key]: !isSeriesOpen(key) }));

  const handleDelete = async () => {
    if (!deleting) return;
    try {
      await api(`/shifts/${deleting.id}`, { method: "DELETE" });
      setDeleting(null);
      setVersion((v) => v + 1);
    } catch (e: any) {
      alert(e?.message || "Failed to delete shift");
    }
  };

  const handleDeleteSeries = async () => {
    if (!deletingSeries) return;
    try {
      const result = await api<{ deleted: number }>("/shifts/bulk", {
        method: "DELETE",
        body: { ids: deletingSeries.ids },
      });
      setDeletingSeries(null);
      setVersion((v) => v + 1);
      alert(`Deleted ${result.deleted} shift${result.deleted === 1 ? "" : "s"} from the series.`);
    } catch (e: any) {
      alert(e?.message || "Failed to delete series");
    }
  };

  const totalCount = filtered.length;
  const repeatCount = filtered.filter((s) => s.isRepeat).length;

  return (
    <div className="flex-1 overflow-auto p-6 space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <div>
          <h1 className="text-2xl font-bold">Shifts</h1>
          <p className="text-sm text-muted-foreground">
            Grouped by location. Recurring shifts collapsed — only the next 7 days shown.
          </p>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search title, location, client…"
            className="w-64"
          />
          <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v as StatusFilter)}>
            <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
            <SelectContent>
              {STATUS_OPTIONS.map((s) => (
                <SelectItem key={s} value={s} className="capitalize">{s}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button variant="outline" size="icon" title="Refresh" onClick={() => setVersion((v) => v + 1)}>
            <RefreshCw className="w-4 h-4" />
          </Button>
          <Button variant="outline" onClick={() => setRepeatOpen(true)}>
            <CalendarRange className="w-4 h-4 mr-1" /> Repeating Shift
          </Button>
          <Button onClick={() => setCreating(true)}>
            <Plus className="w-4 h-4 mr-1" /> New Shift
          </Button>
        </div>
      </div>

      <div className="text-xs text-muted-foreground">
        {loading ? "Loading…" : `${totalCount} shifts in view${repeatCount > 0 ? ` (${repeatCount} from recurring series)` : ""}`}
      </div>

      <div className="space-y-3">
        {!loading && groups.length === 0 && (
          <div className="border border-dashed rounded-lg p-10 text-center text-sm text-muted-foreground">
            No shifts match the current filter.
          </div>
        )}

        {groups.map((g) => {
          const open = isSiteOpen(g.key);
          const totalInGroup = g.singles.length + g.series.reduce((acc, s) => acc + s.occurrences.length, 0);
          return (
            <div key={g.key} className="border rounded-lg bg-card overflow-hidden">
              <button
                type="button"
                onClick={() => toggleSite(g.key)}
                className="w-full flex items-center gap-3 px-4 py-3 hover:bg-accent/30 text-left"
              >
                {open ? <ChevronDown className="w-4 h-4 shrink-0" /> : <ChevronRight className="w-4 h-4 shrink-0" />}
                <MapPin className="w-4 h-4 text-brand-gold shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="font-semibold truncate">{g.siteLabel}</div>
                  {g.clientLabel && (
                    <div className="text-xs text-muted-foreground truncate">{g.clientLabel}</div>
                  )}
                </div>
                <div className="text-xs text-muted-foreground shrink-0">
                  {totalInGroup} shift{totalInGroup === 1 ? "" : "s"}
                  {g.series.length > 0 && (
                    <> · {g.series.length} series</>
                  )}
                </div>
              </button>

              {open && (
                <div className="border-t divide-y">
                  {g.series.map((series) => {
                    const sopen = isSeriesOpen(series.key);
                    const next = series.occurrences[0];
                    const sampleShift = next ?? shifts.find((s) => series.allIds.includes(s.id));
                    const tzIssue = detectSeriesTimezoneIssue(sampleShift);
                    return (
                      <div key={series.key} className="bg-amber-50/30">
                        <div className="w-full flex items-center gap-3 px-4 py-2.5 hover:bg-amber-50">
                          <button
                            type="button"
                            onClick={() => toggleSeries(series.key)}
                            className="flex items-center gap-3 flex-1 min-w-0 text-left"
                          >
                            {sopen ? <ChevronDown className="w-4 h-4 shrink-0" /> : <ChevronRight className="w-4 h-4 shrink-0" />}
                            <Repeat className="w-4 h-4 text-amber-700 shrink-0" />
                            <div className="flex-1 min-w-0">
                              <div className="font-medium truncate">{series.title}</div>
                              <div className="text-xs text-muted-foreground">
                                {series.total} total · {series.occurrences.length} this week
                                {series.hidden > 0 && <> · {series.hidden} after this week (hidden)</>}
                                {next && <> · next: {fmtDateTime(next.startTime)}</>}
                                {!next && series.hidden > 0 && <> · all upcoming occurrences are beyond 7 days</>}
                              </div>
                              {tzIssue && (
                                <div className="text-xs text-red-700 mt-0.5">
                                  ⚠ Saved at {tzIssue.actual} local — looks like it should be {tzIssue.intended}. Click "Fix time" to repair.
                                </div>
                              )}
                            </div>
                          </button>
                          {tzIssue && (
                            <Button
                              variant="outline"
                              size="sm"
                              className="shrink-0 border-red-300 text-red-700 hover:bg-red-50"
                              onClick={(e) => {
                                e.stopPropagation();
                                setFixingSeries({
                                  ids: series.allIds,
                                  title: series.title,
                                  intended: tzIssue.intended,
                                  actual: tzIssue.actual,
                                });
                              }}
                              title={`Re-anchor all ${series.total} shifts to ${tzIssue.intended} local time`}
                            >
                              Fix time
                            </Button>
                          )}
                          <Button
                            variant="outline"
                            size="sm"
                            className="shrink-0"
                            onClick={(e) => {
                              e.stopPropagation();
                              setEditSeries({ ids: series.allIds, title: series.title, siteLabel: series.siteLabel });
                            }}
                            title={`Edit all ${series.total} shifts in this series`}
                          >
                            <Pencil className="w-3.5 h-3.5 mr-1" /> Edit all {series.total}
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="shrink-0 text-destructive hover:text-destructive"
                            onClick={(e) => {
                              e.stopPropagation();
                              setDeletingSeries({ ids: series.allIds, title: series.title, total: series.total });
                            }}
                            title={`Delete entire series (${series.total} shifts)`}
                          >
                            <Trash2 className="w-3.5 h-3.5 mr-1" /> Delete series
                          </Button>
                        </div>
                        {sopen && (
                          <div className="px-4 pb-3">
                            {series.occurrences.length === 0 ? (
                              <div className="text-xs text-muted-foreground italic px-7 py-3">
                                No occurrences in the next 7 days.
                              </div>
                            ) : (
                              <div className="divide-y border rounded bg-background">
                                {series.occurrences.map((s) => (
                                  <ShiftRow
                                    key={s.id}
                                    shift={s}
                                    onEdit={() => setEditing(s)}
                                    onDelete={() => setDeleting(s)}
                                    indent
                                  />
                                ))}
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}

                  {g.singles.map((s) => (
                    <ShiftRow
                      key={s.id}
                      shift={s}
                      onEdit={() => setEditing(s)}
                      onDelete={() => setDeleting(s)}
                    />
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <RepeatingShiftDialog
        open={repeatOpen}
        onOpenChange={setRepeatOpen}
        onCreated={() => { setRepeatOpen(false); setVersion((v) => v + 1); }}
      />

      <BulkEditSeriesDialog
        open={!!editSeries}
        onOpenChange={(b) => { if (!b) setEditSeries(null); }}
        target={editSeries}
        onSaved={() => { setEditSeries(null); setVersion((v) => v + 1); }}
      />

      <RowFormDialog
        open={!!editing || creating}
        onOpenChange={(b) => { if (!b) { setEditing(null); setCreating(false); } }}
        descriptor={descriptor}
        initial={editing as any}
        onSaved={() => { setEditing(null); setCreating(false); setVersion((v) => v + 1); }}
      />

      <AlertDialog open={!!fixingSeries} onOpenChange={(b) => { if (!b && !fixBusy) setFixingSeries(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Fix recurring shift times?</AlertDialogTitle>
            <AlertDialogDescription>
              "{fixingSeries?.title}" was created before the timezone fix. Its shifts are saved
              at <b>{fixingSeries?.actual}</b> Central time but the recurrence pattern says the
              intended start was <b>{fixingSeries?.intended}</b>. This will re-anchor all{" "}
              {fixingSeries?.ids.length} occurrences to <b>{fixingSeries?.intended}</b> in{" "}
              America/Chicago (Texas). Safe to run more than once.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={fixBusy}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={(e) => { e.preventDefault(); handleFixSeriesTz(); }} disabled={fixBusy}>
              {fixBusy ? "Fixing…" : "Fix times"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={!!deletingSeries} onOpenChange={(b) => { if (!b) setDeletingSeries(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete entire series?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently removes all {deletingSeries?.total} occurrences of "{deletingSeries?.title}" and every assignment attached to them. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleDeleteSeries} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
              Delete {deletingSeries?.total} shifts
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

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

function ShiftRow({
  shift, onEdit, onDelete, indent,
}: {
  shift: Shift;
  onEdit: () => void;
  onDelete: () => void;
  indent?: boolean;
}) {
  const lvl = levelBadge(shift.requiredLicenseLevel);
  const filled = (shift.assignments ?? []).filter((a) => a.status === "accepted").length;
  const sameDay = new Date(shift.startTime).toDateString() === new Date(shift.endTime).toDateString();
  return (
    <div className={`flex items-center gap-3 px-4 py-2.5 ${indent ? "" : ""}`}>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-medium truncate">{shift.title}</span>
          <span className={`text-[10px] px-1.5 py-0.5 rounded border font-semibold ${lvl.cls}`}>{lvl.label}</span>
          <span className={`text-[10px] px-1.5 py-0.5 rounded border font-semibold uppercase ${statusBadge(shift.status)}`}>{shift.status}</span>
        </div>
        <div className="text-xs text-muted-foreground mt-0.5">
          {fmtDateTime(shift.startTime)} → {sameDay ? fmtTimeOfDay(shift.endTime) : fmtDateTime(shift.endTime)}
          {" · "}${parseFloat(shift.payRate || "0").toFixed(2)}/hr pay · ${parseFloat(shift.billRate || "0").toFixed(2)}/hr bill
        </div>
      </div>
      <div className="flex items-center gap-1 shrink-0 text-xs text-muted-foreground">
        <Users className="w-3.5 h-3.5" />
        <span>{filled}/{shift.headcount}</span>
      </div>
      <Button variant="ghost" size="icon" onClick={onEdit} title="Edit"><Pencil className="w-4 h-4" /></Button>
      <Button variant="ghost" size="icon" onClick={onDelete} title="Delete"><Trash2 className="w-4 h-4 text-destructive" /></Button>
    </div>
  );
}
