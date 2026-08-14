import { useEffect, useState } from "react";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { useFkOptions } from "@/lib/fk";
import { api, ApiError } from "@/lib/api";
import { Repeat } from "lucide-react";
import {
  StaffingRowsEditor, newStaffingRow, hasDuplicateStaffingRows, type SiteRate, type StaffingRow,
} from "@/components/StaffingRowsEditor";

const DAYS: { v: number; short: string; long: string }[] = [
  { v: 1, short: "Mon", long: "Monday" },
  { v: 2, short: "Tue", long: "Tuesday" },
  { v: 3, short: "Wed", long: "Wednesday" },
  { v: 4, short: "Thu", long: "Thursday" },
  { v: 5, short: "Fri", long: "Friday" },
  { v: 6, short: "Sat", long: "Saturday" },
  { v: 0, short: "Sun", long: "Sunday" },
];

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}
function plusDaysIso(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

export function RepeatingShiftDialog({
  open, onOpenChange, onCreated, isSiteManager = false,
}: {
  open: boolean;
  onOpenChange: (b: boolean) => void;
  onCreated: () => void;
  /** When true, hide rate fields (mirrors server-side site_manager rate-blind rule). */
  isSiteManager?: boolean;
}) {
  const sites = useFkOptions("sites");

  const [title, setTitle] = useState("");
  const [siteId, setSiteId] = useState("");
  const [startDate, setStartDate] = useState(todayIso());
  const [untilDate, setUntilDate] = useState(plusDaysIso(28));
  const [days, setDays] = useState<number[]>([1, 2, 3, 4, 5]);
  const [startTime, setStartTime] = useState("09:00");
  const [endTime, setEndTime] = useState("17:00");
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Multi-position staffing rows — each row becomes its own repeat series.
  const [staffingRows, setStaffingRows] = useState<StaffingRow[]>([newStaffingRow(2)]);

  // Rate-card state, passed through to the rows editor.
  const [siteRates, setSiteRates] = useState<SiteRate[]>([]);
  const [ratesLoading, setRatesLoading] = useState(false);

  useEffect(() => {
    if (!open || !siteId) { setSiteRates([]); return; }
    let cancelled = false;
    setRatesLoading(true);
    api<SiteRate[]>(`/admin/sites/${siteId}/rates`)
      .then((rows) => { if (!cancelled) setSiteRates(rows ?? []); })
      .catch(() => { if (!cancelled) setSiteRates([]); })
      .finally(() => { if (!cancelled) setRatesLoading(false); });
    return () => { cancelled = true; };
  }, [open, siteId]);

  const toggleDay = (d: number) => {
    setDays((prev) => prev.includes(d) ? prev.filter((x) => x !== d) : [...prev, d].sort());
  };

  const reset = () => {
    setTitle(""); setSiteId(""); setStartDate(todayIso()); setUntilDate(plusDaysIso(28));
    setDays([1, 2, 3, 4, 5]); setStartTime("09:00"); setEndTime("17:00");
    setNotes(""); setError(null);
    setSiteRates([]);
    setStaffingRows([newStaffingRow(2)]);
  };

  // Duplicates = same level AND same rate selection; different rate tiers of
  // one level are distinct positions and allowed.
  const hasDuplicates = hasDuplicateStaffingRows(staffingRows);

  const handleSubmit = async () => {
    setError(null);
    if (!title.trim()) { setError("Title is required"); return; }
    if (!siteId) { setError("Site is required"); return; }
    if (days.length === 0) { setError("Pick at least one day of the week"); return; }
    if (untilDate < startDate) { setError("Until date must be on or after the start date"); return; }
    if (hasDuplicates) { setError("Remove duplicate positions before saving"); return; }
    setSubmitting(true);
    try {
      const positions = staffingRows.map((r) => ({
        requiredLicenseLevel: r.requiredLicenseLevel,
        headcount: Math.max(1, r.headcount),
        payRate: Number(r.payRate) || 0,
        billRate: Number(r.billRate) || 0,
        siteRateId: r.siteRateId || null,
      }));
      const result = await api<{ created: number; skippedExisting: number; totalOccurrences: number }>("/shifts/repeat", {
        method: "POST",
        body: {
          base: {
            title: title.trim(),
            siteId,
            notes: notes.trim() || null,
            positions,
          },
          recurrence: {
            startDate, untilDate, daysOfWeek: days, startTime, endTime,
            tz: Intl.DateTimeFormat().resolvedOptions().timeZone || "America/Chicago",
          },
        },
      });
      const msg = result.skippedExisting > 0
        ? `Created ${result.created} shifts (${result.skippedExisting} already existed and were skipped).`
        : `Created ${result.created} shifts.`;
      alert(msg);
      reset();
      onOpenChange(false);
      onCreated();
    } catch (e) {
      const m = e instanceof ApiError ? (typeof e.data === "object" && e.data && "message" in e.data ? String((e.data as { message: unknown }).message) : e.message) : (e as Error).message;
      setError(m || "Failed to create repeating shifts");
    } finally {
      setSubmitting(false);
    }
  };

  const occurrenceEstimate = (() => {
    if (!startDate || !untilDate || days.length === 0) return 0;
    const s = new Date(`${startDate}T00:00:00Z`);
    const u = new Date(`${untilDate}T00:00:00Z`);
    if (Number.isNaN(s.getTime()) || Number.isNaN(u.getTime()) || u < s) return 0;
    let count = 0;
    for (let d = new Date(s); d <= u; d = new Date(d.getTime() + 86_400_000)) {
      if (days.includes(d.getUTCDay())) count++;
      if (count > 366) return 366;
    }
    return count;
  })();

  const totalShifts = occurrenceEstimate * staffingRows.length;
  const totalStaff = staffingRows.reduce((sum, r) => sum + r.headcount, 0);

  return (
    <Dialog open={open} onOpenChange={(b) => { if (!submitting) onOpenChange(b); }}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Repeat className="w-5 h-5 text-brand-gold" />
            Add Repeating Shift
          </DialogTitle>
          <DialogDescription>
            Generate a series of shifts on selected days of the week between two dates.
            Each position row becomes its own repeating series.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5 py-2">
          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2">
              <Label>Title <span className="text-destructive">*</span></Label>
              <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Front gate patrol" />
            </div>
            <div className="col-span-2">
              <Label>Site <span className="text-destructive">*</span></Label>
              <Select value={siteId} onValueChange={setSiteId}>
                <SelectTrigger><SelectValue placeholder={sites.loading ? "Loading sites…" : "Pick a site"} /></SelectTrigger>
                <SelectContent>
                  {sites.options.map((o) => (
                    <SelectItem key={o.id} value={o.id}>{o.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div>
            <Label>Days of week <span className="text-destructive">*</span></Label>
            <div className="flex flex-wrap gap-2 mt-2">
              {DAYS.map((d) => {
                const checked = days.includes(d.v);
                return (
                  <label
                    key={d.v}
                    className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md border text-sm cursor-pointer select-none ${
                      checked ? "bg-brand-navy text-white border-brand-navy" : "bg-card hover:bg-accent"
                    }`}
                  >
                    <Checkbox
                      checked={checked}
                      onCheckedChange={() => toggleDay(d.v)}
                      className={checked ? "border-white data-[state=checked]:bg-white data-[state=checked]:text-brand-navy" : ""}
                    />
                    {d.short}
                  </label>
                );
              })}
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <Label>From date <span className="text-destructive">*</span></Label>
              <Input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
            </div>
            <div>
              <Label>Until date <span className="text-destructive">*</span></Label>
              <Input type="date" value={untilDate} onChange={(e) => setUntilDate(e.target.value)} />
            </div>
            <div>
              <Label>Start time <span className="text-destructive">*</span></Label>
              <Input type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} />
            </div>
            <div>
              <Label>End time <span className="text-destructive">*</span></Label>
              <Input type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)} />
              {endTime <= startTime && (
                <p className="text-xs text-muted-foreground mt-1">Overnight shift — ends next day.</p>
              )}
            </div>
          </div>

          {/* Multi-position staffing rows */}
          <StaffingRowsEditor
            rows={staffingRows}
            onChange={setStaffingRows}
            siteRates={siteRates}
            ratesLoading={ratesLoading}
            isSiteManager={isSiteManager}
            hasSite={!!siteId}
          />

          <div>
            <Label>Notes</Label>
            <Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
          </div>

          <div className="rounded-md bg-brand-cream/40 border border-brand-gold/30 px-3 py-2 text-sm">
            <span className="font-medium">Preview:</span>{" "}
            <b>{staffingRows.length}</b> position{staffingRows.length === 1 ? "" : "s"} ({totalStaff} officer{totalStaff === 1 ? "" : "s"}/day)
            × <b>{occurrenceEstimate}</b> occurrence{occurrenceEstimate === 1 ? "" : "s"}
            {" "}= approx <b>{totalShifts}</b> shift record{totalShifts === 1 ? "" : "s"}
            {" "}({days.length === 0 ? "no days selected" : days.map((d) => DAYS.find((x) => x.v === d)?.short).join(", ")},{" "}
            {startTime}–{endTime}).
            {occurrenceEstimate >= 366 && <span className="text-destructive ml-1">Capped at 366 per position.</span>}
          </div>

          {error && <div className="text-sm text-destructive">{error}</div>}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>Cancel</Button>
          <Button
            onClick={handleSubmit}
            disabled={submitting || occurrenceEstimate === 0 || hasDuplicates}
            className="bg-brand-navy text-white hover:opacity-90"
          >
            {submitting ? "Creating…" : `Create ${totalShifts} shift${totalShifts === 1 ? "" : "s"}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
