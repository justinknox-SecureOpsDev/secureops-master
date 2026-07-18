---
name: Shift finance-field visibility (payRate vs billRate by role)
description: Which roles may see a shift's pay rate vs the client bill rate, and the leak pattern that bypasses it
---

**billRate (what the client is charged) is admin/dispatcher-only.** payRate (what an
officer earns) may be shown to that officer. The role matrix the central sanitizer enforces:

- **admin / dispatcher** — finance-bearing staff: see BOTH payRate and billRate.
- **lead** — schedules/staffs work but sees NO rate at all (payRate, billRate, hourlyRate,
  billableRate all stripped). Own rate comes from their Profile, not shift surfaces.
- **officer / employee / any other role** — see payRate, but NEVER billRate/billableRate.

**Single source of truth:** `stripShiftFinanceForRole` and `stripTimeEntryBillRateForRole`
in `artifacts/api-server/src/lib/financeVisibility.ts`. The mobile employee UI does NOT
render billRate (only `(admin)` screens do), so this leak/fix is API-layer, not client-side.

**The leak pattern to watch for:** `db.select().from(shiftsTable)` with NO explicit
projection returns the full row incl. billRate. Any endpoint that does this and serves
the rows to a non-admin caller (gated only by `requireAuth`) leaks the client charge.
The original officer leak was exactly this on the shift + time-entry list paths; a second
instance hid in `GET /dashboard/employee-summary` (nextShift + upcomingShifts spread raw
rows). Endpoints that select an explicit field list (omitting billRate) or are gated to
admin/dispatcher are safe — verified safe: search, dispatch/*, exports, shiftSwaps officer
routes, availability `/me/suggested-shifts`, clientPortal (client-scoped, omits rates).

**How to apply:** when adding ANY non-admin-reachable endpoint that returns shift rows,
either select an explicit projection that omits billRate/billableRate, or run every row
through `stripShiftFinanceForRole(req.user!.role, row)` before `res.json`. For joined
time-entry rows that pull `shiftsTable.billRate`, use `stripTimeEntryBillRateForRole`.
Pinned by `artifacts/api-server/src/__tests__/leadOwnFinance.test.ts`.

**Why:** billRate is commercially sensitive (reveals WCSG's margin over officer pay).
Officers seeing it is an information-disclosure defect.
