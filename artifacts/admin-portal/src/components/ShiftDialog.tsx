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
import {
  StaffingRowsEditor, newStaffingRow, type SiteRate, type StaffingRow,
} from "@/components/StaffingRowsEditor";

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
  /** When true, hide rate fields (mirrors server-side site_manager rate-blind rule). */
  isSiteManager?: boolean;
};

// Convert a Date or ISO string to the value format <input type="datetime-local"> expects.
function toLocalInput(iso: string | undefined | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function levelLabel(level: number, customLabel: string | null, rateTier?: number): string {
  const base = level <= 1 ? "Support — no license required" : level === 4 ? "L4 / PPO" : level === 3 ? "L3 Armed" : "L2 Unarmed";
  const withTier = rateTier != null ? `${base} · Rate ${rateTier}` : base;
  return customLabel ? `${withTier} — ${customLabel}` : withTier;
}

function defaultRateForLevel(rates: SiteRate[], level: number): SiteRate | null {
  const forLevel = rates.filter((r) => r.licenseLevel === level);
  if (forLevel.length === 0) return null;
  return forLevel.reduce((best, r) => ((r.rateTier ?? 1) < (best.rateTier ?? 1) ? r : best));
}

export function ShiftDialog({ open, onOpenChange, initial, onSaved, isSiteManager = false }: Props) {
  const isEdit = !!initial?.id;
  const { options: siteOptions } = useFkOptions("sites");

  // ── Shared fields (both create & edit) ──
  const [title, setTitle] = useState("");
  const [siteId, setSiteId] = useState<string | null>(null);
  const [startTime, setStartTime] = useState("");
  const [endTime, setEndTime] = useState("");
  const [shiftType, setShiftType] = useState<string>("standard");
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // ── Single-position fields (edit mode only) ──
  const [requiredLicenseLevel, setRequiredLicenseLevel] = useState<number>(2);
  const [headcount, setHeadcount] = useState<number>(1);
  const [payRate, setPayRate] = useState<string>("0");
  const [billRate, setBillRate] = useState<string>("0");
  const [siteRateId, setSiteRateId] = useState<string | null>(null);

  // ── Multi-position rows (create mode only) ──
  const [staffingRows, setStaffingRows] = useState<StaffingRow[]>([newStaffingRow(2)]);

  // ── Site rate card (shared) ──
  const [siteRates, setSiteRates] = useState<SiteRate[]>([]);
  const [ratesLoading, setRatesLoading] = useState(false);

  // Reset everything when the dialog opens / initial changes.
  useEffect(() => {
    if (!open) return;
    setTitle(initial?.title ?? "");
    setSiteId(initial?.siteId ?? null);
    setStartTime(toLocalInput(initial?.startTime));
    setEndTime(toLocalInput(initial?.endTime));
    setShiftType(initial?.shiftType ?? "standard");
    setNotes(initial?.notes ?? "");
    setErr(null);

    // Edit mode single-position state.
    setRequiredLicenseLevel(initial?.requiredLicenseLevel ?? 2);
    setHeadcount(initial?.headcount ?? 1);
    setPayRate(initial?.payRate != null ? String(initial.payRate) : "0");
    setBillRate(initial?.billRate != null ? String(initial.billRate) : "0");
    setSiteRateId(initial?.siteRateId ?? null);

    // Create mode: reset to single empty row; it will be auto-filled once rates load.
    if (!initial?.id) {
      setStaffingRows([newStaffingRow(2)]);
    }
  }, [open, initial]);

  // Load rate card when site changes.
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

  // Edit-mode auto-suggest: when rate card loads or level changes, auto-pick
  // the matching card if the admin hasn't already overridden.
  const applySiteRate = useCallback((rate: SiteRate) => {
    setPayRate(String(rate.payRate));
    setBillRate(String(rate.billRate));
    setSiteRateId(rate.id);
    if (rate.licenseLevel) setRequiredLicenseLevel(rate.licenseLevel);
  }, []);

  useEffect(() => {
    if (!open || !isEdit) return;
    if (siteRateId) return;
    if (siteRates.length === 0) return;
    const match = defaultRateForLevel(siteRates, requiredLicenseLevel);
    if (match) {
      setPayRate(String(match.payRate));
      setBillRate(String(match.billRate));
      setSiteRateId(match.id);
    }
  }, [siteRates, requiredLicenseLevel, siteRateId, open, isEdit]);

  const matchingRate = useMemo(
    () => isEdit ? (siteRates.find((r) => r.id === siteRateId) ?? null) : null,
    [siteRates, siteRateId, isEdit],
  );
  const customRate = isEdit && siteRateId == null && siteId != null && siteRates.length > 0;

  // Duplicate level check (create mode only).
  const hasDuplicates = useMemo(() => {
    if (isEdit) return false;
    const counts = new Map<number, number>();
    for (const r of staffingRows) counts.set(r.requiredLicenseLevel, (counts.get(r.requiredLicenseLevel) ?? 0) + 1);
    return Array.from(counts.values()).some((n) => n > 1);
  }, [staffingRows, isEdit]);

  async function submit() {
    setErr(null);
    if (!title.trim()) { setErr("Title is required"); return; }
    if (!startTime || !endTime) { setErr("Start and end time are required"); return; }
    if (new Date(endTime) <= new Date(startTime)) { setErr("End time must be after start time"); return; }
    if (hasDuplicates) { setErr("Remove duplicate positions before saving"); return; }

    setSubmitting(true);
    try {
      if (isEdit) {
        // Edit: single-position update (unchanged path).
        const payNum = Number(payRate);
        const billNum = Number(billRate);
        if (!Number.isFinite(payNum) || payNum < 0) { setErr("Pay rate must be a non-negative number"); setSubmitting(false); return; }
        if (!Number.isFinite(billNum) || billNum < 0) { setErr("Bill rate must be a non-negative number"); setSubmitting(false); return; }
        await api(`/shifts/${initial!.id}`, {
          method: "PUT",
          body: JSON.stringify({
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
          }),
        });
      } else {
        // Create: one-or-many positions → bulk-create endpoint.
        const positions = staffingRows.map((r) => {
          const payNum = Number(r.payRate);
          const billNum = Number(r.billRate);
          return {
            requiredLicenseLevel: r.requiredLicenseLevel,
            headcount: Math.max(1, r.headcount),
            payRate: String(Number.isFinite(payNum) && payNum >= 0 ? payNum : 0),
            billRate: String(Number.isFinite(billNum) && billNum >= 0 ? billNum : 0),
            siteRateId: r.siteRateId || null,
          };
        });
        await api(`/shifts/bulk-create`, {
          method: "POST",
          body: JSON.stringify({
            title: title.trim(),
            siteId: siteId || null,
            startTime: new Date(startTime).toISOString(),
            endTime: new Date(endTime).toISOString(),
            notes: notes.trim() || null,
            shiftType: shiftType === "ppo_detail" ? "ppo_detail" : "standard",
            positions,
          }),
        });
      }
      onSaved();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  const totalStaff = staffingRows.reduce((sum, r) => sum + r.headcount, 0);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit shift" : "New shift"}</DialogTitle>
          <DialogDescription>
            {isEdit
              ? "Pay and bill rates default to this site's rate card. Override any field for a one-off shift."
              : "Add one position row per license level needed. Each row creates one shift record."}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {/* Title */}
          <div>
            <Label htmlFor="shift-title">Title</Label>
            <Input id="shift-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Front Lobby — Overnight" />
          </div>

          {/* Site + time */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <Label>Site</Label>
              <Select
                value={siteId ?? ""}
                onValueChange={(v) => {
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
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 sm:col-span-1">
              {/* intentional: times span a full row on desktop */}
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

          {/* ── CREATE MODE: multi-position staffing rows ── */}
          {!isEdit && (
            <StaffingRowsEditor
              rows={staffingRows}
              onChange={setStaffingRows}
              siteRates={siteRates}
              ratesLoading={ratesLoading}
              isSiteManager={isSiteManager}
              hasSite={!!siteId}
            />
          )}

          {/* ── EDIT MODE: single-position layout (unchanged UX) ── */}
          {isEdit && (
            <>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <Label>License level required</Label>
                  <Select
                    value={String(requiredLicenseLevel)}
                    onValueChange={(v) => {
                      const lvl = Number(v);
                      setRequiredLicenseLevel(lvl);
                      const match = defaultRateForLevel(siteRates, lvl);
                      if (match) applySiteRate(match);
                      else setSiteRateId(null);
                    }}
                  >
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="1">Support — no license required</SelectItem>
                      <SelectItem value="2">L2 Unarmed</SelectItem>
                      <SelectItem value="3">L3 Armed</SelectItem>
                      <SelectItem value="4">L4 / PPO</SelectItem>
                    </SelectContent>
                  </Select>
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
              </div>

              {/* Rate card picker — edit mode */}
              {siteId && !isSiteManager && (
                <div className="rounded-lg border border-brand-gold/40 bg-brand-cream/30 p-3">
                  <div className="flex items-center justify-between mb-2">
                    <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Site rate card</div>
                    {matchingRate && (
                      <div className="text-xs text-emerald-700">
                        Using: <strong>{levelLabel(matchingRate.licenseLevel, matchingRate.label, matchingRate.rateTier)}</strong>
                      </div>
                    )}
                  </div>
                  {ratesLoading ? (
                    <div className="text-xs text-muted-foreground">Loading rates…</div>
                  ) : siteRates.length === 0 ? (
                    <div className="text-xs text-muted-foreground">
                      This site has no rate card configured. Enter values manually below.
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
                            <div className="font-semibold">{levelLabel(r.licenseLevel, r.label, r.rateTier)}</div>
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

              {/* Pay / bill rate inputs — edit mode, admins only */}
              {!isSiteManager && (
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
              )}
            </>
          )}

          {/* Shift type */}
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

          {/* Notes */}
          <div>
            <Label htmlFor="shift-notes">Notes</Label>
            <Textarea id="shift-notes" rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} />
          </div>

          {/* Create preview summary */}
          {!isEdit && staffingRows.length > 0 && (
            <div className="rounded-md bg-brand-cream/40 border border-brand-gold/30 px-3 py-2 text-sm">
              <span className="font-medium">Preview:</span>{" "}
              <b>{staffingRows.length}</b> position{staffingRows.length === 1 ? "" : "s"},{" "}
              <b>{totalStaff}</b> total officer{totalStaff === 1 ? "" : "s"} —{" "}
              will create <b>{staffingRows.length}</b> shift record{staffingRows.length === 1 ? "" : "s"}.
            </div>
          )}

          {err && (
            <div className="text-sm text-destructive border border-destructive/40 rounded px-3 py-2">
              {err}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={submitting}>Cancel</Button>
          <Button onClick={submit} disabled={submitting || hasDuplicates}>
            {submitting
              ? "Saving…"
              : isEdit
                ? "Save changes"
                : staffingRows.length === 1
                  ? "Create shift"
                  : `Create ${staffingRows.length} shifts`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
