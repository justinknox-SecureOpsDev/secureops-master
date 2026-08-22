/**
 * The shared result model used by the operator-facing preflight checks
 * (`check-fork-integrity.ts` and the checks it composes).
 *
 * It lives in its own module so a check can be written as a self-contained
 * unit — collect facts, turn facts into `CheckResult`s — and then be folded
 * into the fork-integrity report without the two modules importing each other.
 */

export type Severity = "required" | "recommended";

export interface CheckResult {
  area: string;
  name: string;
  severity: Severity;
  ok: boolean;
  detail?: string;
  /** Supporting lines printed under the check (e.g. every differing path). */
  items?: string[];
}
