/**
 * StaffingRowsEditor
 *
 * Reusable multi-position / headcount editor for shift-creation dialogs.
 * Each row maps to one shift record when saved.
 *
 * Positions are picked BY NAME from the site's rate card ("Floor Manager",
 * "Overnight Supervisor", …). The chosen position carries its own license
 * level and pay/bill rates, so a site can staff three different L2 positions
 * on one shift. "Custom rate" keeps the manual escape hatch: pick the license
 * level and type the rates (they are never written back to the rate card).
 *
 * Admins see pay/bill rate inputs; site managers are rate-blind (those fields
 * are hidden and the server derives rates from the site's defaults), so they
 * pick a license level directly.
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
  /** Internal slot number assigned server-side; only a fallback label source. */
  rateTier: number;
  /** Admin-chosen position name. Null on rows created before naming existed. */
  name?: string | null;
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
  /** Non-null ⟹ rates were snapped from a site rate card (a named position). */
  siteRateId: string | null;
};

type Props = {
  rows: StaffingRow[];
  onChange: (rows: StaffingRow[]) => void;
  siteRates: SiteRate[];
  ratesLoading: boolean;
  /** When true, hide pay/bill inputs and the position picker. */
  isSiteManager: boolean;
  /** Whether a site is selected at all (gate for the position picker). */
  hasSite: boolean;
};

const LEVELS = [
  { value: 1, label: "Support — no license required" },
  { value: 2, label: "L2 Unarmed" },
  { value: 3, label: "L3 Armed" },
  { value: 4, label: "L4 / PPO" },
] as const;

const CUSTOM_VALUE = "custom";

/** A rate's position name, falling back to its slot number for legacy rows. */
export function rateName(r: Pick<SiteRate, "name" | "rateTier">): string {
  return (r.name ?? "").trim() || `Rate ${r.rateTier ?? 1}`;
}

function shortLevelLabel(level: number): string {
  return level <= 1 ? "Support" : level === 4 ? "L4 / PPO" : level === 3 ? "L3 Armed" : "L2 Unarmed";
}

/** "Floor Manager — L2 Unarmed" (+ optional free-text label from the card). */
export function positionOptionLabel(r: SiteRate): string {
  const base = `${rateName(r)} — ${shortLevelLabel(r.licenseLevel)}`;
  return r.label ? `${base} · ${r.label}` : base;
}

function defaultRateForLevel(rates: SiteRate[], level: number): SiteRate | null {
  const forLevel = rates.filter((r) => r.licenseLevel === level);
  if (forLevel.length === 0) return null;
  return forLevel.reduce((best, r) => (r.rateTier < best.rateTier ? r : best));
}

/**
 * Two rows are duplicates only when they describe the SAME position: the same
 * named rate-card position, or — for custom rows — the same license level at
 * identical pay and bill. Two DIFFERENT named positions at the same level are
 * a legitimate staffing pattern.
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

/** Client-side duplicate copy, phrased in position names. */
export function duplicateStaffingMessage(rows: StaffingRow[], siteRates: SiteRate[] = []): string {
  const seen = new Set<string>();
  for (const r of rows) {
    const sig = staffingRowSignature(r);
    if (seen.has(sig)) {
      const card = r.siteRateId ? siteRates.find((s) => s.id === r.siteRateId) : null;
      return card
        ? `Duplicate position: "${rateName(card)}" appears twice. Merge the rows or pick a different position.`
        : `Duplicate position: ${shortLevelLabel(r.requiredLicenseLevel)} at the same pay and bill rate appears twice. Merge the rows or pick a different position.`;
    }
    seen.add(sig);
  }
  return "Duplicate position — merge the rows or pick a different position.";
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
  // Signature counts for duplicate detection: named position, or level + rates
  // for custom rows. Two rows only clash when they'd produce identical shifts.
  const signatureCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const r of rows) {
      const sig = staffingRowSignature(r);
      counts.set(sig, (counts.get(sig) ?? 0) + 1);
    }
    return counts;
  }, [rows]);

  // Positions can only be picked by name when this site actually has a rate
  // card and the user is allowed to see rates.
  const canPickPositions = !isSiteManager && hasSite && siteRates.length > 0;

  const updateRow = useCallback((key: string, patch: Partial<StaffingRow>) => {
    onChange(rows.map((r) => r.key === key ? { ...r, ...patch } : r));
  }, [rows, onChange]);

  const removeRow = useCallback((key: string) => {
    onChange(rows.filter((r) => r.key !== key));
  }, [rows, onChange]);

  const addRow = useCallback(() => {
    // Offer the next UNUSED named position, at any license level — a site with
    // three L2 positions can staff all three on one shift.
    const usedRateIds = new Set(rows.map((r) => r.siteRateId).filter(Boolean));
    const unusedRate = siteRates.find((r) => !usedRateIds.has(r.id));
    if (!isSiteManager && unusedRate) {
      const row = newStaffingRow(unusedRate.licenseLevel, []);
      onChange([...rows, {
        ...row,
        payRate: String(unusedRate.payRate),
        billRate: String(unusedRate.billRate),
        siteRateId: unusedRate.id,
      }]);
      return;
    }
    // No named position left (or no rate card): fall back to the first unused
    // license level, then to a plain custom row.
    const usedLevels = new Set(rows.map((r) => r.requiredLicenseLevel));
    const nextLevel = LEVELS.find((l) => !usedLevels.has(l.value))?.value;
    onChange([...rows, newStaffingRow(nextLevel ?? 2, [])]);
  }, [rows, onChange, siteRates, isSiteManager]);

  // When siteRates first arrive (or the site changes), auto-fill any rows
  // that still have the default "0" rates so the form starts populated.
  useEffect(() => {
    if (siteRates.length === 0) return;
    let changed = false;
    const next = rows.map((r) => {
      // Only auto-fill rows that haven't been manually edited yet.
      if (r.siteRateId !== null) return r; // already snapped to a position
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

  // Site managers pick by license level only, so more rows than levels would
  // always be duplicates. Admins are uncapped — positions are free-form.
  const addDisabled = isSiteManager && rows.length >= LEVELS.length;

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
        const isCustomRate = row.siteRateId == null && canPickPositions;

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
                  {canPickPositions ? (
                    <>
                      <Label className="text-xs" id={`${row.key}-position-label`}>Position</Label>
                      <Select
                        value={row.siteRateId ?? CUSTOM_VALUE}
                        onValueChange={(v) => {
                          if (v === CUSTOM_VALUE) {
                            updateRow(row.key, { siteRateId: null });
                            return;
                          }
                          const rate = siteRates.find((r) => r.id === v);
                          if (!rate) return;
                          // License level and rates follow from the position.
                          updateRow(row.key, {
                            siteRateId: rate.id,
                            requiredLicenseLevel: rate.licenseLevel,
                            payRate: String(rate.payRate),
                            billRate: String(rate.billRate),
                          });
                        }}
                      >
                        <SelectTrigger className="h-8 text-sm" aria-labelledby={`${row.key}-position-label`}><SelectValue /></SelectTrigger>
                        <SelectContent>
                          {siteRates.map((r) => (
                            <SelectItem key={r.id} value={r.id}>{positionOptionLabel(r)}</SelectItem>
                          ))}
                          <SelectItem value={CUSTOM_VALUE}>Custom rate…</SelectItem>
                        </SelectContent>
                      </Select>
                    </>
                  ) : (
                    <>
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
                    </>
                  )}
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
                {matchingRate
                  ? `Duplicate position — "${rateName(matchingRate)}" is already on another row. Pick a different position.`
                  : "Duplicate position — another row has the same license level at the same pay and bill rate. Pick a different position."}
              </div>
            )}

            {/* Rates — only for admins with a site */}
            {!isSiteManager && hasSite && (
              <div className="rounded border border-brand-gold/30 bg-brand-cream/20 p-2.5">
                <div className="flex items-center justify-between mb-1.5">
                  <span className="text-xs font-medium text-muted-foreground">Rate</span>
                  {matchingRate && (
                    <span className="text-xs text-emerald-700">
                      {positionOptionLabel(matchingRate)}
                    </span>
                  )}
                </div>
                {ratesLoading ? (
                  <span className="text-xs text-muted-foreground">Loading…</span>
                ) : siteRates.length === 0 ? (
                  <span className="text-xs text-muted-foreground">
                    No positions on this site's rate card — enter values manually.
                  </span>
                ) : null}

                {/* Custom rows still choose their own license level. */}
                {isCustomRate && (
                  <div className="mt-1.5">
                    <Label className="text-xs" id={`${row.key}-level-label`}>License level</Label>
                    <Select
                      value={String(row.requiredLicenseLevel)}
                      onValueChange={(v) => updateRow(row.key, { requiredLicenseLevel: Number(v) })}
                    >
                      <SelectTrigger className="h-8 text-sm" aria-labelledby={`${row.key}-level-label`}><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {LEVELS.map((l) => (
                          <SelectItem key={l.value} value={String(l.value)}>{l.label}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
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
