import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { useDeepLinkFocus } from "@/hooks/useDeepLinkFocus";
import { Button } from "@/components/ui/button";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  ArrowUp, ArrowDown, ArrowUpDown, ChevronDown, ChevronRight, Pencil,
  Repeat, Trash2, Users, Shield, Loader2,
} from "lucide-react";
import { Link } from "wouter";
import {
  Shift, ShiftFilters, applyFilters, filledCount, seriesKeyFor, siteLabelFor,
  fmtDateTime, fmtTimeOfDay, levelBadge, statusBadge, detectSeriesTimezoneIssue,
  describeRepeatPattern, ONE_WEEK_MS, LOAD_MORE_PAGE,
} from "./shared";

type SortKey = "start" | "title" | "site" | "staffing" | "status";
type SortDir = "asc" | "desc";

type SeriesInfo = {
  key: string;
  title: string;
  siteLabel: string;
  total: number;
  allIds: string[];
  windowCount: number;
  later: Shift[];
  next: Shift | null;
  sample: Shift;
  pattern: string | null;
};

type Props = {
  filters: ShiftFilters;
  siteIndex: Map<string, { name: string; clientName: string | null }>;
  focusShiftId: string | null;
  jumpDate: string | null;
  onSelect: (s: Shift) => void;
  onEdit: (s: Shift) => void;
  onEditSeries: (target: { ids: string[]; title: string; siteLabel: string }) => void;
  onDelete: (s: Shift) => void;
};

export function ShiftsListView({
  filters, siteIndex, focusShiftId, jumpDate, onSelect, onEdit, onEditSeries, onDelete,
}: Props) {
  const qc = useQueryClient();
  const [sortKey, setSortKey] = useState<SortKey>("start");
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  const [seriesOpen, setSeriesOpen] = useState(false);
  const [seriesReveal, setSeriesReveal] = useState<Record<string, number>>({});
  const [fixingSeries, setFixingSeries] = useState<{ ids: string[]; title: string; intended: string; actual: string } | null>(null);
  const [fixBusy, setFixBusy] = useState(false);
  const [fixAllConfirm, setFixAllConfirm] = useState(false);
  const [fixAllBusy, setFixAllBusy] = useState(false);
  const [deletingSeries, setDeletingSeries] = useState<{ ids: string[]; title: string; total: number } | null>(null);
  const [toast, setToast] = useState<{ kind: "ok" | "err"; msg: string } | null>(null);

  const statusParam = filters.status === "all" ? "" : `?status=${filters.status}`;
  const listQuery = useQuery<Shift[]>({
    queryKey: ["shifts-area", "list", filters.status],
    queryFn: () => api<Shift[]>(`/shifts${statusParam}`),
  });
  const loading = listQuery.isLoading;
  const allRows = useMemo(() => listQuery.data ?? [], [listQuery.data]);

  const filtered = useMemo(() => {
    let rows = applyFilters(allRows, filters, siteIndex);
    if (jumpDate) {
      const from = new Date(`${jumpDate}T00:00:00`).getTime();
      if (!Number.isNaN(from)) {
        rows = rows.filter((s) => new Date(s.endTime).getTime() >= from || s.id === focusShiftId);
      }
    }
    return rows;
  }, [allRows, filters, siteIndex, jumpDate, focusShiftId]);

  // Series index across everything in the filtered set.
  const seriesList = useMemo(() => {
    const cutoff = Date.now() + ONE_WEEK_MS;
    const map = new Map<string, SeriesInfo>();
    for (const s of filtered) {
      if (!s.isRepeat) continue;
      const key = seriesKeyFor(s);
      let info = map.get(key);
      if (!info) {
        info = {
          key, title: s.title, siteLabel: siteLabelFor(s, siteIndex).site,
          total: 0, allIds: [], windowCount: 0, later: [], next: null, sample: s,
          pattern: describeRepeatPattern(s.repeatPattern),
        };
        map.set(key, info);
      }
      info.total++;
      info.allIds.push(s.id);
      const t = new Date(s.startTime).getTime();
      if (t <= cutoff) {
        info.windowCount++;
        if (t >= Date.now() && (!info.next || t < new Date(info.next.startTime).getTime())) info.next = s;
      } else if (s.id !== focusShiftId) {
        info.later.push(s);
      }
    }
    for (const info of map.values()) {
      info.later.sort((a, b) => a.startTime.localeCompare(b.startTime));
    }
    return Array.from(map.values()).sort((a, b) => a.title.localeCompare(b.title));
  }, [filtered, siteIndex, focusShiftId]);

  // Visible rows: singles + series occurrences within 7 days + revealed later
  // occurrences + the deep-linked shift (always).
  const visibleRows = useMemo(() => {
    const cutoff = Date.now() + ONE_WEEK_MS;
    const revealedIds = new Set<string>();
    for (const info of seriesList) {
      const n = Math.min(seriesReveal[info.key] ?? 0, info.later.length);
      for (const s of info.later.slice(0, n)) revealedIds.add(s.id);
    }
    return filtered.filter((s) => {
      if (!s.isRepeat) return true;
      if (s.id === focusShiftId) return true;
      if (new Date(s.startTime).getTime() <= cutoff) return true;
      return revealedIds.has(s.id);
    });
  }, [filtered, seriesList, seriesReveal, focusShiftId]);

  const hiddenTotal = filtered.length - visibleRows.length;

  const sorted = useMemo(() => {
    const rows = [...visibleRows];
    const dir = sortDir === "asc" ? 1 : -1;
    rows.sort((a, b) => {
      switch (sortKey) {
        case "title": return dir * a.title.localeCompare(b.title);
        case "site": return dir * siteLabelFor(a, siteIndex).site.localeCompare(siteLabelFor(b, siteIndex).site);
        case "staffing": {
          const ra = a.headcount > 0 ? filledCount(a) / a.headcount : 1;
          const rb = b.headcount > 0 ? filledCount(b) / b.headcount : 1;
          return dir * (ra - rb);
        }
        case "status": return dir * a.status.localeCompare(b.status);
        default: return dir * a.startTime.localeCompare(b.startTime);
      }
    });
    return rows;
  }, [visibleRows, sortKey, sortDir, siteIndex]);

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSortKey(key); setSortDir("asc"); }
  };

  const SortHeader = ({ k, children, className }: { k: SortKey; children: React.ReactNode; className?: string }) => (
    <th className={`px-3 py-2 text-left font-semibold ${className ?? ""}`}>
      <button
        type="button"
        onClick={() => toggleSort(k)}
        className="inline-flex items-center gap-1 hover:text-foreground"
        aria-label={`Sort by ${k}`}
      >
        {children}
        {sortKey === k
          ? (sortDir === "asc" ? <ArrowUp className="w-3 h-3" /> : <ArrowDown className="w-3 h-3" />)
          : <ArrowUpDown className="w-3 h-3 opacity-30" />}
      </button>
    </th>
  );

  // Deep-link scroll + flash.
  const { ref: focusShiftRef, flashing: focusShiftFlashing } = useDeepLinkFocus(
    focusShiftId,
    !loading && sorted.length > 0,
  );

  // Auto-open the series manager when a tz issue exists so the repair tools are discoverable.
  const affectedSeries = useMemo(() => {
    const out: { ids: string[]; title: string; intended: string; actual: string }[] = [];
    for (const info of seriesList) {
      const tz = detectSeriesTimezoneIssue(info.sample);
      if (tz) out.push({ ids: info.allIds, title: info.title, intended: tz.intended, actual: tz.actual });
    }
    return out;
  }, [seriesList]);

  useEffect(() => {
    if (affectedSeries.length > 0) setSeriesOpen(true);
  }, [affectedSeries.length]);

  const refresh = () => qc.invalidateQueries({ queryKey: ["shifts-area"] });

  const handleFixSeriesTz = async () => {
    if (!fixingSeries) return;
    setFixBusy(true);
    try {
      const result = await api<{ fixed: number; alreadyCorrect: number; skipped: number; total: number }>(
        "/shifts/series/fix-timezone",
        { method: "POST", body: { ids: fixingSeries.ids } },
      );
      setToast({
        kind: "ok",
        msg: `Fixed ${result.fixed} of ${result.total} shifts in "${fixingSeries.title}".`
          + (result.alreadyCorrect ? ` ${result.alreadyCorrect} already correct.` : "")
          + (result.skipped ? ` ${result.skipped} skipped.` : ""),
      });
      setFixingSeries(null);
      refresh();
    } catch (e) {
      setToast({ kind: "err", msg: e instanceof Error ? e.message : "Failed to fix series times." });
    } finally {
      setFixBusy(false);
    }
  };

  const runFixAllSeriesTz = async () => {
    if (affectedSeries.length === 0) return;
    setFixAllConfirm(false);
    setFixAllBusy(true);
    setToast(null);
    let totalFixed = 0, totalAlreadyCorrect = 0, totalSkipped = 0, totalShifts = 0, failures = 0;
    for (const s of affectedSeries) {
      try {
        const result = await api<{ fixed: number; alreadyCorrect: number; skipped: number; total: number }>(
          "/shifts/series/fix-timezone",
          { method: "POST", body: { ids: s.ids } },
        );
        totalFixed += result.fixed;
        totalAlreadyCorrect += result.alreadyCorrect;
        totalSkipped += result.skipped;
        totalShifts += result.total;
      } catch { failures++; }
    }
    setFixAllBusy(false);
    refresh();
    const parts = [`Fixed ${totalFixed}`, `${totalAlreadyCorrect} already correct`, `${totalSkipped} skipped`];
    if (failures > 0) parts.push(`${failures} series failed`);
    setToast({
      kind: failures > 0 ? "err" : "ok",
      msg: `Re-anchored ${affectedSeries.length} series (${totalShifts} shifts): ${parts.join(" · ")}.`,
    });
  };

  const handleDeleteSeries = async () => {
    if (!deletingSeries) return;
    try {
      const result = await api<{ deleted: number }>("/shifts/bulk", {
        method: "DELETE", body: { ids: deletingSeries.ids },
      });
      setToast({ kind: "ok", msg: `Deleted ${result.deleted} shift${result.deleted === 1 ? "" : "s"} from the series.` });
      setDeletingSeries(null);
      refresh();
    } catch (e) {
      setToast({ kind: "err", msg: e instanceof Error ? e.message : "Failed to delete series." });
    }
  };

  return (
    <div className="space-y-3">
      <div className="text-xs text-muted-foreground">
        {loading
          ? "Loading…"
          : `${filtered.length} shift${filtered.length === 1 ? "" : "s"} match${filtered.length === 1 ? "es" : ""} the current filters`}
        {!loading && hiddenTotal > 0 && (
          <> · {hiddenTotal} later series occurrence{hiddenTotal === 1 ? "" : "s"} hidden — reveal them from the series manager below</>
        )}
      </div>

      {toast && (
        <div className={`flex items-start gap-3 rounded-lg border px-4 py-3 text-sm ${
          toast.kind === "ok" ? "bg-green-50 border-green-300 text-green-900" : "bg-red-50 border-red-300 text-red-900"
        }`}>
          <div className="flex-1">{toast.msg}</div>
          <button type="button" onClick={() => setToast(null)} className="text-xs underline shrink-0">Dismiss</button>
        </div>
      )}

      {affectedSeries.length > 0 && (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-red-300 bg-red-50 px-4 py-3">
          <div className="flex-1 text-sm text-red-800 min-w-[16rem]">
            <span className="font-semibold">
              {affectedSeries.length} recurring series {affectedSeries.length === 1 ? "has" : "have"} wrong times
            </span>
            <span className="ml-1">— created before the timezone fix. Re-anchor every occurrence to America/Chicago.</span>
          </div>
          <Button
            variant="outline" size="sm"
            className="shrink-0 border-red-400 text-red-700 hover:bg-red-100"
            onClick={() => setFixAllConfirm(true)}
            disabled={fixAllBusy}
          >
            {fixAllBusy ? "Fixing all…" : `Fix all ${affectedSeries.length}`}
          </Button>
        </div>
      )}

      {/* ── Series manager ── */}
      {seriesList.length > 0 && (
        <div className="border rounded-lg bg-card overflow-hidden">
          <button
            type="button"
            onClick={() => setSeriesOpen((v) => !v)}
            className="w-full flex items-center gap-3 px-4 py-3 hover:bg-accent/30 text-left"
          >
            {seriesOpen ? <ChevronDown className="w-4 h-4 shrink-0" /> : <ChevronRight className="w-4 h-4 shrink-0" />}
            <Repeat className="w-4 h-4 text-amber-700 shrink-0" />
            <span className="font-semibold flex-1">
              Recurring series ({seriesList.length})
            </span>
            <span className="text-xs text-muted-foreground">
              pattern, bulk edit, time repair, later dates
            </span>
          </button>
          {seriesOpen && (
            <div className="border-t divide-y">
              {seriesList.map((info) => {
                const tzIssue = detectSeriesTimezoneIssue(info.sample);
                const revealed = Math.min(seriesReveal[info.key] ?? 0, info.later.length);
                const remaining = info.later.length - revealed;
                return (
                  <div key={info.key} className="px-4 py-3 flex flex-wrap items-center gap-3">
                    <div className="flex-1 min-w-[14rem]">
                      <div className="font-medium truncate">{info.title}</div>
                      <div className="text-xs text-muted-foreground">
                        {info.siteLabel}
                        {info.pattern && <> · {info.pattern}</>}
                        <> · {info.total} total · {info.windowCount} this week</>
                        {info.next && <> · next: {fmtDateTime(info.next.startTime)}</>}
                        {remaining > 0 && <> · {remaining} later {remaining === 1 ? "date" : "dates"} hidden</>}
                      </div>
                      {tzIssue && (
                        <div className="text-xs text-red-700 mt-0.5">
                          ⚠ Saved at {tzIssue.actual} local — looks like it should be {tzIssue.intended}. Click "Fix time" to repair.
                        </div>
                      )}
                      {info.later.length > 0 && (
                        <div className="flex flex-wrap items-center gap-3 text-xs mt-1">
                          {remaining > 0 && (
                            <>
                              <button
                                type="button"
                                className="font-medium text-brand-gold hover:underline"
                                onClick={() => setSeriesReveal((m) => ({
                                  ...m, [info.key]: Math.min(revealed + LOAD_MORE_PAGE, info.later.length),
                                }))}
                              >
                                Load {Math.min(LOAD_MORE_PAGE, remaining)} more into the list
                              </button>
                              <button
                                type="button"
                                className="font-medium text-brand-gold hover:underline"
                                onClick={() => setSeriesReveal((m) => ({ ...m, [info.key]: info.later.length }))}
                              >
                                Show all {info.total}
                              </button>
                            </>
                          )}
                          {revealed > 0 && (
                            <button
                              type="button"
                              className="font-medium text-muted-foreground hover:underline"
                              onClick={() => setSeriesReveal((m) => ({ ...m, [info.key]: 0 }))}
                            >
                              Show less
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      {tzIssue && (
                        <Button
                          variant="outline" size="sm"
                          className="border-red-300 text-red-700 hover:bg-red-50"
                          disabled={fixAllBusy}
                          onClick={() => setFixingSeries({
                            ids: info.allIds, title: info.title,
                            intended: tzIssue.intended, actual: tzIssue.actual,
                          })}
                        >
                          Fix time
                        </Button>
                      )}
                      <Button
                        variant="outline" size="sm"
                        onClick={() => onEditSeries({ ids: info.allIds, title: info.title, siteLabel: info.siteLabel })}
                        title={`Edit all ${info.total} shifts in this series`}
                      >
                        <Pencil className="w-3.5 h-3.5 mr-1" /> Edit all {info.total}
                      </Button>
                      <Button
                        variant="ghost" size="sm"
                        className="text-destructive hover:text-destructive"
                        onClick={() => setDeletingSeries({ ids: info.allIds, title: info.title, total: info.total })}
                        title={`Delete entire series (${info.total} shifts)`}
                      >
                        <Trash2 className="w-3.5 h-3.5 mr-1" /> Delete series
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* ── Flat sortable table ── */}
      {loading ? (
        <div className="flex items-center gap-2 text-sm opacity-60 py-8 justify-center">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading shifts…
        </div>
      ) : sorted.length === 0 ? (
        <div className="border border-dashed rounded-lg p-10 text-center text-sm text-muted-foreground">
          No shifts match the current filters.
        </div>
      ) : (
        <div className="border rounded-lg bg-card overflow-x-auto">
          <table className="w-full text-sm min-w-[52rem]">
            <thead className="bg-muted/60 text-xs text-muted-foreground">
              <tr>
                <SortHeader k="start">Date &amp; time</SortHeader>
                <SortHeader k="title">Shift</SortHeader>
                <SortHeader k="site">Site / Client</SortHeader>
                <SortHeader k="staffing">Staffing</SortHeader>
                <th className="px-3 py-2 text-left font-semibold">Rates</th>
                <SortHeader k="status">Status</SortHeader>
                <th className="px-3 py-2 text-right font-semibold">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {sorted.map((s) => {
                const lvl = levelBadge(s.requiredLicenseLevel);
                const filled = filledCount(s);
                const open = filled < s.headcount;
                const { site, client } = siteLabelFor(s, siteIndex);
                const sameDay = new Date(s.startTime).toDateString() === new Date(s.endTime).toDateString();
                const isFocus = s.id === focusShiftId;
                return (
                  <tr
                    key={s.id}
                    ref={isFocus ? (focusShiftRef as React.Ref<HTMLTableRowElement>) : undefined}
                    className={`hover:bg-accent/30 cursor-pointer ${isFocus && focusShiftFlashing ? "wcsg-deep-link-flash" : ""}`}
                    onClick={() => onSelect(s)}
                  >
                    <td className="px-3 py-2.5 whitespace-nowrap">
                      <div className="font-medium">{fmtDateTime(s.startTime)}</div>
                      <div className="text-xs text-muted-foreground">
                        → {sameDay ? fmtTimeOfDay(s.endTime) : fmtDateTime(s.endTime)}
                      </div>
                    </td>
                    <td className="px-3 py-2.5">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        {s.isRepeat && <Repeat className="w-3 h-3 text-amber-700 shrink-0" aria-label="Repeating series" />}
                        <span className="font-medium">{s.title}</span>
                        <span className={`text-[10px] px-1.5 py-0.5 rounded border font-semibold ${lvl.cls}`}>{lvl.label}</span>
                      </div>
                    </td>
                    <td className="px-3 py-2.5">
                      <div className="truncate max-w-[14rem]">{site}</div>
                      {client && <div className="text-xs text-muted-foreground truncate max-w-[14rem]">{client}</div>}
                    </td>
                    <td className="px-3 py-2.5 whitespace-nowrap">
                      <span className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded border font-medium ${
                        open ? "bg-amber-100 text-amber-800 border-amber-300" : "bg-emerald-100 text-emerald-800 border-emerald-300"
                      }`}>
                        <Users className="w-3 h-3" /> {filled}/{s.headcount}
                      </span>
                    </td>
                    <td className="px-3 py-2.5 whitespace-nowrap text-xs text-muted-foreground">
                      ${parseFloat(s.payRate || "0").toFixed(2)} pay
                      {Number(s.billRate) > 0 && <> · ${parseFloat(s.billRate).toFixed(2)} bill</>}
                    </td>
                    <td className="px-3 py-2.5">
                      <span className={`text-[10px] px-1.5 py-0.5 rounded border font-semibold uppercase ${statusBadge(s.status)}`}>
                        {s.status}
                      </span>
                    </td>
                    <td className="px-3 py-2.5 text-right whitespace-nowrap" onClick={(e) => e.stopPropagation()}>
                      {s.shiftType === "ppo_detail" && (
                        <Link href={`/shifts/${s.id}/protection`}>
                          <Button variant="ghost" size="icon" title="Protection detail" aria-label="Open protection detail" className="text-brand-gold hover:text-brand-gold">
                            <Shield className="w-4 h-4" />
                          </Button>
                        </Link>
                      )}
                      <Button variant="ghost" size="icon" onClick={() => onEdit(s)} title="Edit" aria-label={`Edit ${s.title}`}>
                        <Pencil className="w-4 h-4" />
                      </Button>
                      <Button variant="ghost" size="icon" onClick={() => onDelete(s)} title="Delete" aria-label={`Delete ${s.title}`}>
                        <Trash2 className="w-4 h-4 text-destructive" />
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* ── Dialogs ── */}
      <AlertDialog open={fixAllConfirm} onOpenChange={(b) => { if (!b && !fixAllBusy) setFixAllConfirm(false); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Fix all {affectedSeries.length} affected series?</AlertDialogTitle>
            <AlertDialogDescription>
              This re-anchors every occurrence of {affectedSeries.length} recurring series to their originally intended start times in America/Chicago (Texas). Safe to run more than once.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={fixAllBusy}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={(e) => { e.preventDefault(); runFixAllSeriesTz(); }} disabled={fixAllBusy}>
              {fixAllBusy ? "Fixing all…" : `Fix all ${affectedSeries.length}`}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={!!fixingSeries} onOpenChange={(b) => { if (!b && !fixBusy) setFixingSeries(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Fix recurring shift times?</AlertDialogTitle>
            <AlertDialogDescription>
              "{fixingSeries?.title}" was created before the timezone fix. Its shifts are saved
              at <b>{fixingSeries?.actual}</b> Central time but the recurrence pattern says the
              intended start was <b>{fixingSeries?.intended}</b>. This will re-anchor all{" "}
              {fixingSeries?.ids.length} occurrences to <b>{fixingSeries?.intended}</b> in
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
    </div>
  );
}
