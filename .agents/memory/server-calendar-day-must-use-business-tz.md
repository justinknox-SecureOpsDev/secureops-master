---
name: Server calendar-day bucketing must use business timezone
description: Any "what calendar day is this" decision on the server must use the business timezone (PAYROLL_TIMEZONE / Central), never server-local UTC.
---

Any server-side logic that decides **which calendar day** a timestamp belongs to — "today's"
shifts, day windows, daily rollups, status boards — MUST resolve the day in the business
timezone (`PAYROLL_TIMEZONE`, default `America/Chicago`), NOT the server's local time.

**Why:** In production the API runs in UTC. A server-local day boundary
(`new Date(now.getFullYear(), now.getMonth(), now.getDate())`) put every evening Central shift
(e.g. 9pm CT = 02:00 UTC the next day) into the *next* UTC day, so the Dispatch status board's
"Scheduled" bucket showed almost nothing — all the staffed evening shifts fell outside "today".
WCSG is a TX (Central) operation; the operator's day is Central, full stop. User directive:
"all times and dates should run on CST."

**How to apply:**
- Reuse `artifacts/api-server/src/lib/businessTime.ts`: `businessTimeZone()`,
  `startOfBusinessDay(now, tz)`, `businessDayWindow(now, tz)` → `{startOfDay, endOfDay}`.
- `endOfDay` is the **next local midnight** (not naive +24h) so DST days are 23h/25h. Use a
  **half-open** predicate: `startTime >= startOfDay AND startTime < endOfDay` (a shift at exactly
  next-midnight belongs to tomorrow).
- Frontend display: the same calendar reasoning applies — force `timeZone: "America/Chicago"`
  in `toLocaleString`/`toLocaleDateString` so rows don't render in the viewer's browser TZ.
- The holiday/payroll code already does this (`lib/holidays.ts` resolves the clock-in date in
  `PAYROLL_TIMEZONE`); keep new day-based logic consistent with it.
