import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { api } from "@/lib/api";
import { useFkOptions } from "@/lib/fk";
import { AlertTriangle } from "lucide-react";

type SiteRate = {
  id: string;
  siteId: string;
  licenseLevel: number;
  payRate: string;
  billRate: string;
  label: string;
};

type ShiftInitial = {
  id?: string;
  title?: string;
  siteId?: string | null;
  startTime?: string;
  endTime?: string;
  payRate?: string;
  billRate?: string;
  requiredLicenseLevel?: number;
  headcount?: number;
  notes?: string | null;
  siteRateId?: string | null;
  shiftType?: string | null;
};

type Props = {
  open: boolean;
  onOpenChange: (b: boolean) => void;
  initial: ShiftInitial | null;
  onSaved: () => void;
};

// Convert a Date or ISO string to the value format <input type="datetime-local"> expects.
function toLocalInput(iso: string | undefined | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function levelLabel(level: number, customLabel: string): string {
  const base = level <= 1 ? "Support (no licence)" : level === 4 ? "L4 / PPO" : level === 3 ? "L3 Armed" : "L2 Unarmed";
  return customLabel ? `${base} — ${customLabel}` : base;
}

export function ShiftDialog({ open, onOpenChange, initial, onSaved }: Props) {
  const isEdit = !!initial?.id;
  const { options: siteOptions } = useFkOptions("sites");

  const [title, setTitle] = useState("");
  const [siteId, setSiteId] = useState<string | null>(null);
  const [startTime, setStartTime] = useState("");
  const [endTime, setEndTime] = useState("");
  const [requiredLicenseLevel, setRequiredLicenseLevel] = useState<number>(2);
  const [headcount, setHeadcount] = useState<number>(1);
  const [payRate, setPayRate] = useState<string>("0");
  const [billRate, setBillRate] = useState<string>("0");
  const [siteRateId, setSiteRateId] = useState<string | null>(null);
  const [notes, setNotes] = useState("");
  const [shiftType, setShiftType] = useState<string>("standard");
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const [siteRates, setSiteRates] = useState<SiteRate[]>([]);
  const [ratesLoading, setRatesLoading] = useState(false);

  // Reset state every time the dialog opens (and on initial change for edit→edit).
  useEffect(() => {
    if (!open) return;
    setTitle(initial?.title ?? "");
    setSiteId(initial?.siteId ?? null);
    setStartTime(toLocalInput(initial?.startTime));
    setEndTime(toLocalInput(initial?.endTime));
    setRequiredLicenseLevel(initial?.requiredLicenseLevel ?? 2);
    setHeadcount(initial?.headcount ?? 1);
    setPayRate(initial?.payRate != null ? String(initial.payRate) : "0");
    setBillRate(initial?.billRate != null ? String(initial.billRate) : "0");
    setSiteRateId(initial?.siteRateId ?? null);
    setNotes(initial?.notes ?? "");
    setShiftType(initial?.shiftType ?? "standard");
    setErr(null);
  }, [open, initial]);

  // Load the site's rate card whenever the selected site changes. Empty list
  // when no site is picked — the rate picker just shows the "no rates" hint.
  useEffect(() => {
    if (!open) return;
    if (!siteId) { setSiteRates([]); return; }
    let cancelled = false;
    setRatesLoading(true);
    api<SiteRate[]>(`/admin/sites/${siteId}/rates`)
      .then((rows) => { if (!cancelled) setSiteRates(rows ?? []); })
      .catch(() => { if (!cancelled) setSiteRates([]); })
      .finally(() => { if (!cancelled) setRatesLoading(false); });
    return () => { cancelled = true; };
  }, [siteId, open]);

  // When the user picks a rate from the site's card, snapshot both pay+bill
  // into the shift form (admin can still override below). siteRateId is
  // stored so the shift carries an auditable link back to the rate row.
  const applySiteRate = useCallback((rate: SiteRate) => {
    setPayRate(String(rate.payRate));
    setBillRate(String(rate.billRate));
    setSiteRateId(rate.id);
    if (rate.licenseLevel) setRequiredLicenseLevel(rate.licenseLevel);
  }, []);

  // Auto-suggest the rate matching the currently selected license level
  // whenever the site's rate card finishes loading or the level changes —
  // but only if the admin hasn't already picked a rate manually.
  // Auto-apply only when exactly one rate matches (unambiguous); when
  // multiple labeled rates exist for the same level, leave it for the admin
  // to pick from the card rather than silently picking the wrong one.
  useEffect(() => {
    if (!open) return;
    if (siteRateId) return; // already chosen, don't overwrite
    if (siteRates.length === 0) return;
    const matches = siteRates.filter((r) => r.licenseLevel === requiredLicenseLevel);
    if (matches.length !== 1) return;
    const [match] = matches;
    setPayRate(String(match.payRate));
    setBillRate(String(match.billRate));
    setSiteRateId(match.id);
  }, [siteRates, requiredLicenseLevel, siteRateId, open]);

  const matchingRate = useMemo(
    () => siteRates.find((r) => r.id === siteRateId) ?? null,
    [siteRates, siteRateId],
  );

  // Show an amber hint if the admin manually typed a rate that no longer
  // matches any row on the site's card — common after they intended to
  // override for a single shift. Purely informational.
  const customRate = siteRateId == null && siteId != null && siteRates.length > 0;

  async function submit() {
    setErr(null);
    if (!title.trim()) { setErr("Title is required"); return; }
    if (!startTime || !endTime) { setErr("Start and end time are required"); return; }
    if (new Date(endTime) <= new Date(startTime)) { setErr("End time must be after start time"); return; }
    const payNum = Number(payRate);
    const billNum = Number(billRate);
    if (!Number.isFinite(payNum) || payNum < 0) { setErr("Pay rate must be a non-negative number"); return; }
    if (!Number.isFinite(billNum) || billNum < 0) { setErr("Bill rate must be a non-negative number"); return; }

    setSubmitting(true);
    try {
      const body = {
        title: title.trim(),
        siteId: siteId || null,
        startTime: new Date(startTime).toISOString(),
        endTime: new Date(endTime).toISOString(),
        payRate: String(payNum),
        billRate: String(billNum),
        requiredLicenseLevel,
        headcount: Math.max(1, headcount | 0),
        notes: notes.trim() || null,
        siteRateId: siteRateId || null,
        shiftType: shiftType === "ppo_detail" ? "ppo_detail" : "standard",
      };
      if (isEdit) {
        await api(`/shifts/${initial!.id}`, { method: "PUT", body: JSON.stringify(body) });
      } else {
        await api(`/shifts`, { method: "POST", body: JSON.stringify(body) });
      }
      onSaved();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit shift" : "New shift"}</DialogTitle>
          <DialogDescription>
            Pay and bill rates default to this site's rate card for the chosen license level. Override any field below for a one-off shift.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div>
            <Label htmlFor="shift-title">Title</Label>
            <Input id="shift-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Front Lobby — Overnight" />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <Label>Site</Label>
              <Select
                value={siteId ?? ""}
                onValueChange={(v) => {
                  // Changing site → reset the rate selection so the next
                  // load auto-picks from the new site's card.
                  setSiteId(v || null);
                  setSiteRateId(null);
                }}
              >
                <SelectTrigger><SelectValue placeholder="Select a site" /></SelectTrigger>
                <SelectContent>
                  {siteOptions.map((o) => (
                    <SelectItem key={o.id} value={o.id}>{o.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>License level required</Label>
              <Select
                value={String(requiredLicenseLevel)}
                onValueChange={(v) => {
                  const lvl = Number(v);
                  setRequiredLicenseLevel(lvl);
                  // Auto-apply only when unambiguous; if multiple labeled rates
                  // exist for this level, clear selection so the admin picks.
                  const matches = siteRates.filter((r) => r.licenseLevel === lvl);
                  if (matches.length === 1) applySiteRate(matches[0]);
                  else setSiteRateId(null);
                }}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="1">Support (no licence)</SelectItem>
                  <SelectItem value="2">L2 Unarmed</SelectItem>
                  <SelectItem value="3">L3 Armed</SelectItem>
                  <SelectItem value="4">L4 / PPO</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <Label htmlFor="shift-start">Start time</Label>
              <Input id="shift-start" type="datetime-local" value={startTime} onChange={(e) => setStartTime(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="shift-end">End time</Label>
              <Input id="shift-end" type="datetime-local" value={endTime} onChange={(e) => setEndTime(e.target.value)} />
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
                  This site has no rate card configured. Set rates per license level on the site's detail page, or enter values manually below.
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
                  This shift uses a custom rate that won't be saved back to the site's rate card.
                </div>
              )}
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <Label htmlFor="shift-pay">Pay rate ($/hr)</Label>
              <Input
                id="shift-pay"
                type="number"
                min="0"
                step="0.01"
                value={payRate}
                onChange={(e) => {
                  setPayRate(e.target.value);
                  // Manual edit clears the rate-card link so the audit trail
                  // is honest about the override.
                  if (siteRateId && matchingRate && Number(e.target.value) !== Number(matchingRate.payRate)) {
                    setSiteRateId(null);
                  }
                }}
              />
            </div>
            <div>
              <Label htmlFor="shift-bill">Bill rate ($/hr)</Label>
              <Input
                id="shift-bill"
                type="number"
                min="0"
                step="0.01"
                value={billRate}
                onChange={(e) => {
                  setBillRate(e.target.value);
                  if (siteRateId && matchingRate && Number(e.target.value) !== Number(matchingRate.billRate)) {
                    setSiteRateId(null);
                  }
                }}
              />
            </div>
          </div>

          <div>
            <Label htmlFor="shift-headcount">Headcount</Label>
            <Input
              id="shift-headcount"
              type="number"
              min="1"
              step="1"
              value={headcount}
              onChange={(e) => setHeadcount(Math.max(1, Number(e.target.value) | 0))}
            />
          </div>

          <div>
            <Label>Shift type</Label>
            <Select value={shiftType} onValueChange={(v) => setShiftType(v)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="standard">Standard</SelectItem>
                <SelectItem value="ppo_detail">PPO / Protection Detail</SelectItem>
              </SelectContent>
            </Select>
            {shiftType === "ppo_detail" && (
              <p className="mt-1 text-xs text-muted-foreground">
                Build the executive-protection package (principals, threats, destinations) from the
                shield button on this shift after saving.
              </p>
            )}
          </div>

          <div>
            <Label htmlFor="shift-notes">Notes</Label>
            <Textarea id="shift-notes" rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} />
          </div>

          {err && (
            <div className="text-sm text-destructive border border-destructive/40 rounded px-3 py-2">
              {err}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={submitting}>Cancel</Button>
          <Button onClick={submit} disabled={submitting}>
            {submitting ? "Saving…" : isEdit ? "Save changes" : "Create shift"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
