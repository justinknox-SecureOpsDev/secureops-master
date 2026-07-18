---
name: Auto clock-out geofence gate
description: Policy for when the scheduled auto clock-out job closes an open time entry after shift end.
---

# Auto clock-out fires only on a confirmed `outside` geofence reading

The auto clock-out scheduled job (`autoClockOutEndedShifts` in `artifacts/api-server/src/lib/scheduledJobs.ts`) closes an open time entry only when BOTH hold: the shift end has passed (plus the 10-min `AUTO_CLOCKOUT_GRACE_MS`) AND the time entry's `geofence_state === "outside"`. Any other state — `inside` (even a stale reading), or `null`/never-evaluated (GPS off, manual clock-in) — is deliberately left OPEN.

**Why:** Product owner asked auto clock-out to never close someone who is still on site. Officers still inside (or whose location can't be confirmed) must not be auto-closed; they rely on the forgot-to-clock-out reminder job and/or manual correction. The earlier "stale inside still gets clocked out (freshness veto)" behavior was intentionally removed — do NOT reintroduce a freshness window or treat `null` as "clock them out" thinking it's a forgotten-clock-out cleanup bug; that is the explicitly requested tradeoff.

**How to apply:** `geofence_state` is nullable text written only as `inside`/`outside` by `evaluateGeofence`, so the strict `if (geofenceState !== "outside") continue;` is correct and fail-closed. If you ever need to auto-close never-evaluated entries, that is a new product decision, not a bug fix. The forgot-to-clock-out reminder job remains the safety net for entries left open.
