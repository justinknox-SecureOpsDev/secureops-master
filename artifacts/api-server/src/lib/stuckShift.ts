import { resolveAutoClockOutDelayMinutes, SHIFTLESS_AUTO_CLOCKOUT_ABANDONMENT_HOURS, GEOFENCE_FRESH_MS } from "./scheduledJobs";

// "Stuck" open entry — one autoClockOutEndedShifts (scheduledJobs.ts) should
// normally have already closed, but didn't (the officer's geofence keeps
// reporting a fresh "inside" ping, or the site has auto-clock-out disabled
// entirely). This must be derived from that job's OWN effective policy per
// site/company — a fixed threshold shorter than a site's configured delay
// (up to AUTO_CLOCKOUT_DELAY_MAX_MINUTES = 12h, see scheduledJobs.ts) would
// flag — and let an admin truncate — entries the policy hasn't even reached
// yet. So:
//   - shift-linked, auto-clock-out enabled: stuck once
//     now > scheduledEnd + resolveAutoClockOutDelayMinutes(...) + a
//     STUCK_SWEEP_BUFFER_MINUTES safety margin past that deadline (the job
//     ticks every 5 minutes; the buffer absorbs a slow tick without
//     flagging an entry the sweep is about to close on its own).
//   - shift-less (walk-up), auto-clock-out enabled: same idea, anchored on
//     SHIFTLESS_AUTO_CLOCKOUT_ABANDONMENT_HOURS instead of a shift end.
//   - auto-clock-out DISABLED for the site: the background job skips this
//     site entirely (see the `autoClockOutEnabled === false` early-continue
//     in autoClockOutEndedShifts), so there is no policy deadline to defer
//     to at all — this manual flag is the ONLY backstop. Use a flat
//     STUCK_DISABLED_SITE_HOURS from clock-in so these don't sit open
//     forever with nothing surfacing them.
// On top of all of the above: an entry with a FRESH "inside" geofence ping
// is never flagged, matching the sweep's own on-site exclusion exactly (see
// GEOFENCE_FRESH_MS / pingFresh in autoClockOutEndedShifts) — that officer is
// demonstrably still on site, so this is not a stuck record at all, and
// truncating it (via the admin one-click-close OR the automated admin alert
// below) would be wrong.
//
// Shared by the dispatch status board (admin-facing manual close) AND the
// notifyStuckOpenShifts scheduled job (automated admin alert, see
// scheduledJobs.ts) — both must agree on exactly which entries are "stuck",
// or an admin could get paged about an entry the board doesn't even flag
// (or vice versa).
export const STUCK_SWEEP_BUFFER_MINUTES = 30;
export const STUCK_DISABLED_SITE_HOURS = 16;
export const HOUR_MS = 60 * 60 * 1000;
export const MIN_MS_LOCAL = 60 * 1000;

/**
 * Decide whether an open time entry should be flagged "stuck", using the
 * SAME effective auto-clock-out policy — including the fresh-"inside"-
 * geofence exclusion — the scheduledJobs.ts sweep uses, rather than a fixed
 * threshold or a partial copy of that policy. This must only ever flag
 * entries the sweep has already had a fair chance to close AND has no
 * on-site evidence it should be leaving open.
 */
export function isStuckOpenEntry(args: {
  now: number;
  clockInTime: Date;
  shiftEndTime: Date | null;
  autoClockOutEnabled: boolean | null | undefined;
  autoClockOutDelayMinutes: number | null | undefined;
  companyDefaultDelayMinutes: number | null | undefined;
  geofenceState: string | null | undefined;
  lastLocationAt: Date | null | undefined;
}): boolean {
  const { now, clockInTime, shiftEndTime, autoClockOutEnabled } = args;

  // Same exclusion as the sweep's own `pingFresh` check: a fresh "inside"
  // ping is proof of life, regardless of how the timing policy resolves.
  const pingFresh =
    args.lastLocationAt != null && now - args.lastLocationAt.getTime() <= GEOFENCE_FRESH_MS;
  if (args.geofenceState === "inside" && pingFresh) return false;

  // null site → the sweep job treats that as enabled (see
  // scheduledJobs.ts), so only an explicit `false` takes the disabled path.
  if (autoClockOutEnabled === false) {
    return now - clockInTime.getTime() > STUCK_DISABLED_SITE_HOURS * HOUR_MS;
  }

  if (shiftEndTime) {
    const delayMinutes = resolveAutoClockOutDelayMinutes(
      args.autoClockOutDelayMinutes,
      args.companyDefaultDelayMinutes,
    );
    const deadlineMs = new Date(shiftEndTime).getTime() + delayMinutes * MIN_MS_LOCAL;
    return now - deadlineMs > STUCK_SWEEP_BUFFER_MINUTES * MIN_MS_LOCAL;
  }

  // Shift-less (walk-up) entry, auto-clock-out enabled: mirrors the sweep's
  // own SHIFTLESS_AUTO_CLOCKOUT_ABANDONMENT_HOURS anchor.
  const walkUpDeadlineMs = clockInTime.getTime()
    + SHIFTLESS_AUTO_CLOCKOUT_ABANDONMENT_HOURS * HOUR_MS;
  return now - walkUpDeadlineMs > STUCK_SWEEP_BUFFER_MINUTES * MIN_MS_LOCAL;
}
