import { useCallback, useEffect, useMemo, useState } from "react";
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
import { AlertTriangle, Repeat } from "lucide-react";

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

function levelLabel(level: number, label: string | null): string {
  const base = level <= 1 ? "Support (no licence)" : level === 4 ? "L4 / PPO" : level === 3 ? "L3 Armed" : "L2 Unarmed";
  return label ? `${base} — ${label}` : base;
}

export function RepeatingShiftDialog({
  open, onOpenChange, onCreated, initialSiteId,
}: {
  open: boolean;
  onOpenChange: (b: boolean) => void;
  onCreated: () => void;
  // When launched from a specific site's detail page, prefill the series to
  // that site so the admin doesn't have to re-pick it. Optional — the standalone
  // Shifts page passes nothing and the admin chooses a site as before.
  initialSiteId?: string | null;
}) {
  const sites = useFkOptions("sites");

  const [title, setTitle] = useState("");
  const [siteId, setSiteId] = useState("");
  const [startDate, setStartDate] = useState(todayIso());
  const [untilDate, setUntilDate] = useState(plusDaysIso(28));
  const [days, setDays] = useState<number[]>([1, 2, 3, 4, 5]);
  const [startTime, setStartTime] = useState("09:00");
  const [endTime, setEndTime] = useState("17:00");
  const [payRate, setPayRate] = useState("0");
  const [billRate, setBillRate] = useState("0");
  const [licenseLevel, setLicenseLevel] = useState<"1" | "2" | "3" | "4">("2");
  const [headcount, setHeadcount] = useState("1");
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Rate-card state — when the admin picks a site, fetch its per-license-level
  // rates and auto-apply the one matching the chosen level. Mirrors ShiftDialog
  // so a recurring series uses the contracted rate, not whatever was in the
  // default "0" inputs.
  type SiteRate = { id: string; licenseLevel: number; payRate: string; billRate: string; label: string | null };
  const [siteRates, setSiteRates] = useState<SiteRate[]>([]);
  const [siteRateId, setSiteRateId] = useState<string | null>(null);
  const [ratesLoading, setRatesLoading] = useState(false);

  useEffect(() => {
    if (!open || !siteId) { setSiteRates([]); setRatesLoading(false); return; }
    let cancelled = false;
    setRatesLoading(true);
    api<SiteRate[]>(`/admin/sites/${siteId}/rates`)
      .then((rows) => { if (!cancelled) setSiteRates(rows ?? []); })
      .catch(() => { if (!cancelled) setSiteRates([]); })
      .finally(() => { if (!cancelled) setRatesLoading(false); });
    return () => { cancelled = true; };
  }, [open, siteId]);

  // Prefill the site when opened from a site's detail page (see initialSiteId).
  // Also clear any prior rate-card selection so a stale siteRateId from a
  // previously chosen site can't carry over into this site's series.
  useEffect(() => {
    if (open && initialSiteId) { setSiteId(initialSiteId); setSiteRateId(null); }
  }, [open, initialSiteId]);

  // Auto-apply only when exactly one rate matches the chosen level (unambiguous).
  // With multiple labeled rates per level, show the picker — the old first-match
  // assumption silently picks the wrong rate when labels distinguish intent.
  useEffect(() => {
    if (siteRates.length === 0 || siteRateId) return;
    const matches = siteRates.filter((r) => r.licenseLevel === Number(licenseLevel));
    if (matches.length !== 1) return;
    const [match] = matches;
    setPayRate(String(parseFloat(match.payRate)));
    setBillRate(String(parseFloat(match.billRate)));
    setSiteRateId(match.id);
  }, [siteRates, licenseLevel, siteRateId]);

  const applySiteRate = useCallback((rate: SiteRate) => {
    setPayRate(String(parseFloat(rate.payRate)));
    setBillRate(String(parseFloat(rate.billRate)));
    setSiteRateId(rate.id);
    setLicenseLevel(String(rate.licenseLevel) as "1" | "2" | "3" | "4");
  }, []);

  const matchingRate = useMemo(
    () => siteRates.find((r) => r.id === siteRateId) ?? null,
    [siteRates, siteRateId],
  );

  const customRate = siteRateId == null && siteId !== "" && siteRates.length > 0;

  const toggleDay = (d: number) => {
    setDays((prev) => prev.includes(d) ? prev.filter((x) => x !== d) : [...prev, d].sort());
  };

  const reset = () => {
    setTitle(""); setSiteId(""); setStartDate(todayIso()); setUntilDate(plusDaysIso(28));
    setDays([1, 2, 3, 4, 5]); setStartTime("09:00"); setEndTime("17:00");
    setPayRate("0"); setBillRate("0"); setLicenseLevel("2"); setHeadcount("1");
    setNotes(""); setError(null);
    setSiteRates([]); setSiteRateId(null); setRatesLoading(false);
  };

  const handleSubmit = async () => {
    setError(null);
    if (!title.trim()) { setError("Title is required"); return; }
    if (!siteId) { setError("Site is required"); return; }
    if (days.length === 0) { setError("Pick at least one day of the week"); return; }
    if (untilDate < startDate) { setError("Until date must be on or after the start date"); return; }
    setSubmitting(true);
    try {
      const result = await api<{ created: number; skippedExisting: number; totalOccurrences: number }>("/shifts/repeat", {
        method: "POST",
        body: {
          base: {
            title: title.trim(),
            siteId,
            payRate: Number(payRate) || 0,
            billRate: Number(billRate) || 0,
            requiredLicenseLevel: Number(licenseLevel),
            headcount: Number(headcount) || 1,
            notes: notes.trim() || null,
            siteRateId: siteRateId || null,
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
              <Select value={siteId} onValueChange={(v) => { setSiteId(v); setSiteRateId(null); }}>
                <SelectTrigger><SelectValue placeholder={sites.loading ? "Loading sites…" : "Pick a site"} /></SelectTrigger>
                <SelectContent>
                  {sites.options.map((o) => (
                    <SelectItem key={o.id} value={o.id}>{o.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Rate card picker — only meaningful with a site selected */}
          {siteId && (
            <div className="rounded-lg border border-brand-gold/40 bg-brand-cream/30 p-3">
              <div className="flex items-center justify-between mb-2">
                <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Site rate card</div>
                {matchingRate && (
                  <div className="text-xs text-emerald-700">
                    Using: <strong>{levelLabel(matchingRate.licenseLevel, matchingRate.label)}</strong>
                  </div>
                )}
              </div>
              {ratesLoading ? (
                <div className="text-xs text-muted-foreground">Loading rates…</div>
              ) : siteRates.length === 0 ? (
                <div className="text-xs text-muted-foreground">
                  This site has no rate card configured. Set rates on the site detail page, or enter values manually below.
                </div>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {siteRates.map((r) => {
                    const selected = r.id === siteRateId;
                    return (
                      <button
                        key={r.id}
                        type="button"
                        onClick={() => applySiteRate(r)}
                        className={`text-left px-3 py-2 rounded border text-xs transition ${
                          selected
                            ? "bg-brand-navy text-white border-brand-navy"
                            : "bg-white hover:bg-brand-cream/60 border-brand-gold/40"
                        }`}
                      >
                        <div className="font-semibold">{levelLabel(r.licenseLevel, r.label)}</div>
                        <div className={selected ? "text-white/85" : "text-muted-foreground"}>
                          Pay ${parseFloat(r.payRate).toFixed(2)} · Bill ${parseFloat(r.billRate).toFixed(2)}
                        </div>
                      </button>
                    );
                  })}
                  <button
                    type="button"
                    onClick={() => setSiteRateId(null)}
                    className={`px-3 py-2 rounded border text-xs ${
                      siteRateId == null
                        ? "bg-amber-100 border-amber-400 text-amber-900"
                        : "bg-white hover:bg-amber-50 border-dashed border-amber-300 text-amber-800"
                    }`}
                  >
                    Custom (one-off)
                  </button>
                </div>
              )}
              {customRate && (
                <div className="mt-2 text-xs text-amber-800 inline-flex items-center gap-1">
                  <AlertTriangle className="w-3 h-3" />
                  This series uses a custom rate not linked to the site's rate card.
                </div>
              )}
            </div>
          )}

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

          <div className="grid grid-cols-2 gap-3">
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

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Pay rate ($/hr)</Label>
              <Input
                type="number" step="0.01" value={payRate}
                onChange={(e) => { setPayRate(e.target.value); setSiteRateId(null); }}
              />
            </div>
            <div>
              <Label>Bill rate ($/hr)</Label>
              <Input
                type="number" step="0.01" value={billRate}
                onChange={(e) => { setBillRate(e.target.value); setSiteRateId(null); }}
              />
            </div>
            <div>
              <Label>Min licence</Label>
              <Select value={licenseLevel} onValueChange={(v) => setLicenseLevel(v as "1" | "2" | "3" | "4")}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="1">Support (no licence)</SelectItem>
                  <SelectItem value="2">Level 2 (unarmed)</SelectItem>
                  <SelectItem value="3">Level 3 (armed)</SelectItem>
                  <SelectItem value="4">Level 4 (PPO)</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Headcount</Label>
              <Input type="number" min="1" value={headcount} onChange={(e) => setHeadcount(e.target.value)} />
            </div>
          </div>

          <div>
            <Label>Notes</Label>
            <Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
          </div>

          <div className="rounded-md bg-brand-cream/40 border border-brand-gold/30 px-3 py-2 text-sm">
            <span className="font-medium">Preview:</span> approx <b>{occurrenceEstimate}</b> shift{occurrenceEstimate === 1 ? "" : "s"} will be created
            ({days.length === 0 ? "no days selected" : days.map((d) => DAYS.find((x) => x.v === d)?.short).join(", ")},{" "}
            {startTime}–{endTime}).
            {occurrenceEstimate >= 366 && <span className="text-destructive ml-1">Capped at 366.</span>}
          </div>

          {error && <div className="text-sm text-destructive">{error}</div>}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>Cancel</Button>
          <Button
            onClick={handleSubmit}
            disabled={submitting || occurrenceEstimate === 0}
            className="bg-brand-navy text-white hover:opacity-90"
          >
            {submitting ? "Creating…" : `Create ${occurrenceEstimate} shift${occurrenceEstimate === 1 ? "" : "s"}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
