/**
 * Single source of truth for officer pay-rate resolution.
 *
 * Precedence (highest wins):
 *   1. Per-entry admin override (`time_entries.pay_rate_override`) — an
 *      explicit, deliberate correction on one specific entry.
 *   2. Employee profile rate (`employees.hourly_rate`) — the authoritative
 *      default for that person.
 *   3. Shift pay rate (`shifts.pay_rate`, snapshotted from the site default).
 *   4. $0 — nothing to price with (source "none"); callers keep raising the
 *      existing "Pay rate is $0" warnings for this case.
 *
 * "Set" means present, finite and GREATER THAN ZERO at every level. Never
 * use `??`/null-coalescing here: `shifts.pay_rate` is NOT NULL DEFAULT '0',
 * so a `0.00` value is "not null" and a coalescing chain would let it beat a
 * real profile rate — the exact bug this helper exists to prevent.
 *
 * The federal-holiday 1.5× premium applies on top of whichever rate wins,
 * and the premium rate is rounded to cents BEFORE multiplying by hours
 * (identical to invoiceSync/payroll) so `rate × hours == gross` reconciles
 * everywhere the rate is displayed.
 *
 * Every surface that prices officer pay (Payroll Board buckets, weekly
 * payroll generation, analytics labor cost, apply-rate guard, officer-facing
 * rate displays) MUST call this helper rather than re-implementing the
 * chain — duplicated money logic has drifted here before.
 */
import { getFederalHolidayName, HOLIDAY_PAY_MULTIPLIER } from "./holidays";

export type PayRateSource = "override" | "profile" | "shift" | "none";

export interface ResolvedPayRate {
  /** The winning base rate in $/hr (0 when source === "none"). */
  baseRate: number;
  /**
   * Holiday-adjusted rate: baseRate × 1.5 rounded to cents when the clock-in
   * falls on a US federal holiday (business timezone), else baseRate.
   */
  effectiveRate: number;
  /** Which candidate won. */
  source: PayRateSource;
  /** Federal holiday name when the premium applied, else null. */
  holidayName: string | null;
}

/** Parse a candidate rate; null/zero/negative/non-finite all mean "not set". */
function asSetRate(value: string | number | null | undefined): number | null {
  if (value == null) return null;
  const n = typeof value === "number" ? value : parseFloat(String(value));
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

export function resolvePayRate(input: {
  /** time_entries.pay_rate_override */
  overrideRate?: string | number | null;
  /** employees.hourly_rate */
  profileRate?: string | number | null;
  /** shifts.pay_rate */
  shiftRate?: string | number | null;
  /** Clock-in instant, for the federal-holiday premium. Omit to skip it. */
  clockInTime?: Date | string | null;
}): ResolvedPayRate {
  const override = asSetRate(input.overrideRate);
  const profile = asSetRate(input.profileRate);
  const shift = asSetRate(input.shiftRate);

  let baseRate = 0;
  let source: PayRateSource = "none";
  if (override != null) {
    baseRate = override;
    source = "override";
  } else if (profile != null) {
    baseRate = profile;
    source = "profile";
  } else if (shift != null) {
    baseRate = shift;
    source = "shift";
  }

  const holidayName = input.clockInTime != null ? getFederalHolidayName(input.clockInTime) : null;
  // Round the premium rate to cents BEFORE multiplying by hours so the
  // displayed per-entry rate reconciles with the gross (rate × hours).
  const effectiveRate = holidayName
    ? Math.round(baseRate * HOLIDAY_PAY_MULTIPLIER * 100) / 100
    : baseRate;

  return { baseRate, effectiveRate, source, holidayName };
}
