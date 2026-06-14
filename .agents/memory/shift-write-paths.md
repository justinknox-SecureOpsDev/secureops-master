---
name: Shift write paths & window invariants
description: The full set of code paths that create/update a shift's start/end window, and why a duration/window invariant must be enforced at ALL of them via one shared validator.
---

# Shift write paths & window invariants

A shift's `[startTime, endTime)` window is written from MANY independent paths, not
just the obvious `POST /shifts`. Enforcing a window invariant (e.g. "no shift may
span > 24h") on only some of them lets malformed data leak in through the others.

**Why this matters:** a single multi-day shift (wrong end DATE) makes every rostered
officer look on-duty for that whole span, so the time-overlap guard silently rejects
all their other assignments ("already assigned another shift") AND blocks their self
clock-in — while the bad shift stays hidden from day/upcoming views (status never
auto-advances). This actually happened in prod and was very hard to diagnose.

**How to apply:** put the invariant in ONE shared validator (`lib/shiftWindow.ts` →
`validateShiftWindow(start, end)`), and call it from every writer. Known writers to
audit whenever you touch shift windows:

- In-app routes (`routes/shifts.ts`): `POST /shifts`, `PUT /shifts/:id` (validate the
  EFFECTIVE window — prefetch the row, fall back to stored value for the unchanged
  bound), `POST /shifts/repeat` (per-occurrence), `PUT /shifts/bulk` (a TIME-ONLY
  series edit can still bust the window: moving only the start of an overnight shift
  earlier, or only the end, while the other bound is anchored to a different day —
  build all patches first and reject the whole batch, never partial-apply),
  `POST /shifts/series/fix-timezone` (bounded ≤24h by single-day re-anchoring).
- **Scheduler webhook inbound** (`routes/schedulerWebhook.ts` `processInboundShift`):
  external create/update. This is a LIVE ingestion path in prod (the `SCHEDULER_*`
  secrets are set) and is a plausible source of bad data. Quarantine invalid windows
  (return `{action:"skipped", skipReason}` + a `logger.warn`) rather than ingesting.

HH:MM parsing gotcha: `/^\d{2}:\d{2}$/` accepts out-of-range values like `25:00`
(passes a naive duration check by yielding a small span). Use
`/^([01]\d|2[0-3]):[0-5]\d$/` to reject them at the format check.
