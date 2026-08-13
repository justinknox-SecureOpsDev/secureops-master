/**
 * StaffingRowsEditor
 *
 * Reusable multi-position / headcount editor for shift-creation dialogs.
 * Each row maps to one shift record when saved. The rate-card picker mirrors
 * ShiftDialog: clicking a card auto-fills pay+bill; manual edits clear the
 * card link so the audit trail is honest about overrides.
 *
 * Admins see pay/bill rate inputs; site managers are rate-blind (those fields
 * are hidden and the server derives rates from the site's defaults).
 */
import { useCallback, useEffect, useMemo } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { AlertTriangle, Plus, Trash2 } from "lucide-react";

export type SiteRate = {
  id: string;
  siteId: string;
  licenseLevel: number;
  rateTier: number;
  payRate: string;
  billRate: string;
  label: string | null;
};

export type StaffingRow = {
  /** Stable client-side key for React reconciliation. */
  key: string;
  requiredLicenseLevel: number;
  headcount: number;
  payRate: string;
  billRate: string;
  /** Non-null ⟹ rates were snapped from a site rate card. */
  siteRateId: string | null;
};

type Props = {
  rows: StaffingRow[];
  onChange: (rows: StaffingRow[]) => void;
  siteRates: SiteRate[];
  ratesLoading: boolean;
  /** When true, hide pay/bill inputs and the rate-card picker. */
  isSiteManager: boolean;
  /** Whether a site is selected at all (gate for the rate-card section). */
  hasSite: boolean;
};

const LEVELS = [
  { value: 1, label: "Support — no license required" },
  { value: 2, label: "L2 Unarmed" },
  { value: 3, label: "L3 Armed" },
  { value: 4, label: "L4 / PPO" },
] as const;

function defaultRateForLevel(rates: SiteRate[], level: number): SiteRate | null {
  const forLevel = rates.filter((r) => r.licenseLevel === level);
  if (forLevel.length === 0) return null;
  return forLevel.reduce((best, r) => (r.rateTier < best.rateTier ? r : best));
}

function levelLabel(level: number, customLabel: string | null, rateTier?: number): string {
  const base =
    level <= 1 ? "Support — no license required"
    : level === 4 ? "L4 / PPO"
    : level === 3 ? "L3 Armed"
    : "L2 Unarmed";
  const withTier = rateTier != null ? `${base} · Rate ${rateTier}` : base;
  return customLabel ? `${withTier} — ${customLabel}` : withTier;
}

/**
 * Two rows are duplicates only when they describe the SAME position at the
 * SAME rate: equal license level AND equal rate selection (rate-card id, or
 * for custom rows, the typed pay+bill values). Same level with different
 * tiers is a legitimate staffing pattern (e.g. L3 Rate 1 + L3 Rate 2).
 */
export function staffingRowSignature(
  r: Pick<StaffingRow, "requiredLicenseLevel" | "payRate" | "billRate" | "siteRateId">,
): string {
  return r.siteRateId
    ? `${r.requiredLicenseLevel}|card:${r.siteRateId}`
    : `${r.requiredLicenseLevel}|custom:${Number(r.payRate) || 0}|${Number(r.billRate) || 0}`;
}

export function hasDuplicateStaffingRows(rows: StaffingRow[]): boolean {
  const seen = new Set<string>();
  for (const r of rows) {
    const sig = staffingRowSignature(r);
    if (seen.has(sig)) return true;
    seen.add(sig);
  }
  return false;
}

let _keyCounter = 0;
export function newStaffingRow(level = 2, siteRates: SiteRate[] = []): StaffingRow {
  const key = `row-${++_keyCounter}`;
  const match = defaultRateForLevel(siteRates, level);
  return {
    key,
    requiredLicenseLevel: level,
    headcount: 1,
    payRate: match ? String(match.payRate) : "0",
    billRate: match ? String(match.billRate) : "0",
    siteRateId: match ? match.id : null,
  };
}

export function StaffingRowsEditor({
  rows, onChange, siteRates, ratesLoading, isSiteManager, hasSite,
}: Props) {
  // Signature counts for duplicate detection: level + rate selection. Two
  // rows only clash when they'd produce identical shift records.
  const signatureCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const r of rows) {
      const sig = staffingRowSignature(r);
      counts.set(sig, (counts.get(sig) ?? 0) + 1);
    }
    return counts;
  }, [rows]);

  const updateRow = useCallback((key: string, patch: Partial<StaffingRow>) => {
    onChange(rows.map((r) => r.key === key ? { ...r, ...patch } : r));
  }, [rows, onChange]);

  const removeRow = useCallback((key: string) => {
    onChange(rows.filter((r) => r.key !== key));
  }, [rows, onChange]);

  const addRow = useCallback(() => {
    // Prefer the first UNUSED license level; once all levels are in play,
    // fall back to the first unused rate-card row (a different tier of an
    // already-used level) so multi-tier staffing keeps working.
    const usedSet = new Set(rows.map((r) => r.requiredLicenseLevel));
    const nextLevel = LEVELS.find((l) => !usedSet.has(l.value))?.value;
    if (nextLevel !== undefined) {
      onChange([...rows, newStaffingRow(nextLevel, siteRates)]);
      return;
    }
    const usedRateIds = new Set(rows.map((r) => r.siteRateId).filter(Boolean));
    const unusedRate = siteRates.find((r) => !usedRateIds.has(r.id));
    if (unusedRate) {
      const row = newStaffingRow(unusedRate.licenseLevel, []);
      onChange([...rows, {
        ...row,
        payRate: String(unusedRate.payRate),
        billRate: String(unusedRate.billRate),
        siteRateId: unusedRate.id,
      }]);
      return;
    }
    onChange([...rows, newStaffingRow(2, [])]); // custom-rate row
  }, [rows, onChange, siteRates]);

  // When siteRates first arrive (or the site changes), auto-fill any rows
  // that still have the default "0" rates so the form starts populated.
  useEffect(() => {
    if (siteRates.length === 0) return;
    let changed = false;
    const next = rows.map((r) => {
      // Only auto-fill rows that haven't been manually edited yet.
      if (r.siteRateId !== null) return r; // already snapped to a card
      if (Number(r.payRate) !== 0 || Number(r.billRate) !== 0) return r; // manual value
      const match = defaultRateForLevel(siteRates, r.requiredLicenseLevel);
      if (!match) return r;
      changed = true;
      return { ...r, payRate: String(match.payRate), billRate: String(match.billRate), siteRateId: match.id };
    });
    if (changed) onChange(next);
    // Intentionally only depends on siteRates identity to avoid re-running on every keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [siteRates]);

  // Adding stops making sense once every level AND every rate-card row is in
  // use (admins with no rate card can still express distinct custom rates,
  // so cap generously rather than exactly).
  const maxRows = Math.max(LEVELS.length, LEVELS.length + siteRates.length - new Set(siteRates.map((r) => r.licenseLevel)).size);
  const addDisabled = rows.length >= (isSiteManager ? LEVELS.length : Math.max(maxRows, LEVELS.length));

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <Label className="text-sm font-medium">Positions &amp; staffing</Label>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={addRow}
          disabled={addDisabled}
          className="h-7 text-xs gap-1"
        >
          <Plus className="w-3 h-3" /> Add position
        </Button>
      </div>

      {rows.map((row, idx) => {
        const isDuplicate = (signatureCounts.get(staffingRowSignature(row)) ?? 0) > 1;
        const matchingRate = siteRates.find((r) => r.id === row.siteRateId) ?? null;
        const isCustomRate = row.siteRateId == null && hasSite && siteRates.length > 0 && !isSiteManager;

        return (
          <div
            key={row.key}
            className={`rounded-lg border p-3 space-y-3 ${isDuplicate ? "border-destructive/60 bg-destructive/5" : "border-border bg-muted/20"}`}
          >
            {/* Row header */}
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide w-5 shrink-0">
                {idx + 1}
              </span>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 flex-1">
                <div>
                  <Label className="text-xs" id={`${row.key}-level-label`}>License level</Label>
                  <Select
                    value={String(row.requiredLicenseLevel)}
                    onValueChange={(v) => {
                      const lvl = Number(v);
                      const match = defaultRateForLevel(siteRates, lvl);
                      updateRow(row.key, {
                        requiredLicenseLevel: lvl,
                        ...(match ? { payRate: String(match.payRate), billRate: String(match.billRate), siteRateId: match.id } : { siteRateId: null }),
                      });
                    }}
                  >
                    <SelectTrigger className="h-8 text-sm" aria-labelledby={`${row.key}-level-label`}><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {LEVELS.map((l) => (
                        <SelectItem key={l.value} value={String(l.value)}>{l.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label className="text-xs" htmlFor={`${row.key}-headcount`}>Staff count</Label>
                  <Input
                    id={`${row.key}-headcount`}
                    type="number"
                    min="1"
                    step="1"
                    className="h-8 text-sm"
                    value={row.headcount}
                    onChange={(e) => updateRow(row.key, { headcount: Math.max(1, Math.floor(Number(e.target.value)) || 1) })}
                  />
                </div>
              </div>
              {rows.length > 1 && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 shrink-0 text-muted-foreground hover:text-destructive"
                  onClick={() => removeRow(row.key)}
                  aria-label="Remove position"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </Button>
              )}
            </div>

            {isDuplicate && (
              <div className="text-xs text-destructive flex items-center gap-1">
                <AlertTriangle className="w-3 h-3 shrink-0" />
                Duplicate position — same license level and rate as another row. Pick a different rate tier or change the level.
              </div>
            )}

            {/* Rate card picker — only for admins with a site */}
            {!isSiteManager && hasSite && (
              <div className="rounded border border-brand-gold/30 bg-brand-cream/20 p-2.5">
                <div className="flex items-center justify-between mb-1.5">
                  <span className="text-xs font-medium text-muted-foreground">Rate card</span>
                  {matchingRate && (
                    <span className="text-xs text-emerald-700">
                      {levelLabel(matchingRate.licenseLevel, matchingRate.label, matchingRate.rateTier)}
                    </span>
                  )}
                </div>
                {ratesLoading ? (
                  <span className="text-xs text-muted-foreground">Loading…</span>
                ) : siteRates.length === 0 ? (
                  <span className="text-xs text-muted-foreground">
                    No rate card for this site — enter values manually.
                  </span>
                ) : (
                  <div className="flex flex-wrap gap-1.5">
                    {siteRates.map((r) => {
                      const sel = r.id === row.siteRateId;
                      return (
                        <button
                          key={r.id}
                          type="button"
                          onClick={() => updateRow(row.key, {
                            payRate: String(r.payRate),
                            billRate: String(r.billRate),
                            siteRateId: r.id,
                            requiredLicenseLevel: r.licenseLevel,
                          })}
                          className={`text-left px-2.5 py-1.5 rounded border text-xs transition ${
                            sel
                              ? "bg-brand-navy text-white border-brand-navy"
                              : "bg-white hover:bg-brand-cream/60 border-brand-gold/40"
                          }`}
                        >
                          <div className="font-semibold">{levelLabel(r.licenseLevel, r.label, r.rateTier)}</div>
                          <div className={sel ? "text-white/80" : "text-muted-foreground"}>
                            Pay ${parseFloat(r.payRate).toFixed(2)} · Bill ${parseFloat(r.billRate).toFixed(2)}
                          </div>
                        </button>
                      );
                    })}
                    <button
                      type="button"
                      onClick={() => updateRow(row.key, { siteRateId: null })}
                      className={`px-2.5 py-1.5 rounded border text-xs ${
                        row.siteRateId == null
                          ? "bg-amber-100 border-amber-400 text-amber-900"
                          : "bg-white hover:bg-amber-50 border-dashed border-amber-300 text-amber-800"
                      }`}
                    >
                      Custom
                    </button>
                  </div>
                )}
                {isCustomRate && (
                  <div className="mt-1.5 text-xs text-amber-800 flex items-center gap-1">
                    <AlertTriangle className="w-3 h-3 shrink-0" />
                    Custom rate — won't be saved back to the site's rate card.
                  </div>
                )}

                {/* Pay / bill rate inputs */}
                <div className="grid grid-cols-2 gap-2 mt-2">
                  <div>
                    <Label className="text-xs" htmlFor={`${row.key}-pay`}>Pay ($/hr)</Label>
                    <Input
                      id={`${row.key}-pay`}
                      type="number"
                      min="0"
                      step="0.01"
                      className="h-7 text-xs"
                      value={row.payRate}
                      onChange={(e) => {
                        const v = e.target.value;
                        const cleared = matchingRate && Number(v) !== Number(matchingRate.payRate) ? null : row.siteRateId;
                        updateRow(row.key, { payRate: v, siteRateId: cleared });
                      }}
                    />
                  </div>
                  <div>
                    <Label className="text-xs" htmlFor={`${row.key}-bill`}>Bill ($/hr)</Label>
                    <Input
                      id={`${row.key}-bill`}
                      type="number"
                      min="0"
                      step="0.01"
                      className="h-7 text-xs"
                      value={row.billRate}
                      onChange={(e) => {
                        const v = e.target.value;
                        const cleared = matchingRate && Number(v) !== Number(matchingRate.billRate) ? null : row.siteRateId;
                        updateRow(row.key, { billRate: v, siteRateId: cleared });
                      }}
                    />
                  </div>
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
