/**
 * Shared validation for a shift's [start, end) window.
 *
 * A single shift can never legitimately span more than MAX_SHIFT_HOURS. The
 * longest real posts in the system are overnight ~20h shifts; anything beyond a
 * day is almost always a wrong end DATE. Left unguarded, a multi-day shift makes
 * every rostered officer look on-duty for that whole span, so the overlap guard
 * silently rejects all their other assignments ("already assigned another
 * shift") and blocks their self clock-in — while the bad shift stays hidden from
 * day/upcoming views. Every shift create/edit/ingestion path validates here so
 * the rule can't drift between writers (POST / PUT / bulk / repeat + scheduler
 * sync inbound).
 */
export const MAX_SHIFT_HOURS = 24;
export const MAX_SHIFT_DURATION_MS = MAX_SHIFT_HOURS * 60 * 60 * 1000;

export type ShiftWindowValidation =
  | { ok: true }
  | { ok: false; code: "invalid_dates" | "end_before_start" | "too_long"; message: string };

/** Validate a shift window. Accepts Date objects or epoch-ms numbers. */
export function validateShiftWindow(start: Date | number, end: Date | number): ShiftWindowValidation {
  const startMs = start instanceof Date ? start.getTime() : start;
  const endMs = end instanceof Date ? end.getTime() : end;
  if (Number.isNaN(startMs) || Number.isNaN(endMs)) {
    return { ok: false, code: "invalid_dates", message: "startTime and endTime must be valid dates." };
  }
  if (endMs <= startMs) {
    return { ok: false, code: "end_before_start", message: "endTime must be after startTime." };
  }
  if (endMs - startMs > MAX_SHIFT_DURATION_MS) {
    return {
      ok: false,
      code: "too_long",
      message: `A shift can't be longer than ${MAX_SHIFT_HOURS} hours — check the start/end dates (this usually means the end date is wrong).`,
    };
  }
  return { ok: true };
}
