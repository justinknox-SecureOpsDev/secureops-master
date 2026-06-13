---
name: Bill rate is admin-only
description: Which finance fields each role may see on shift / time-entry API responses, and why.
---

# Bill rate vs pay rate visibility

**Rule:** `billRate` / `billableRate` (the CLIENT-facing markup) must NEVER appear in
a non-admin API response. `payRate` / `hourlyRate` (the officer's OWN compensation)
MAY be shown to that officer.

Role matrix for shift/time-entry response shaping:
- **admin** — all finance.
- **lead** — NO finance at all (pay + bill stripped) — separate lead-no-finance invariant.
- **officer, dispatcher, any other non-admin** — strip bill only; keep pay.

**Why:** bill rate is commercial data (what WCSG charges the client); exposing it to
officers/dispatchers leaks margin. Dispatchers lose it too (least-exposure) — safe
because they cannot set rates (shift create/edit is admin/lead only).

**How to apply:** route ALL shift response shaping through
`stripShiftFinanceForRole(role, row)` in `routes/shifts.ts` (used at GET/POST /shifts,
GET/PUT /shifts/:id). For time entries, non-admin responses in `routes/timeEntries.ts`
(`GET /time-entries`, `GET /time-entries/active`) destructure-omit `billRate` from the
shared `baseSelect` (which joins `shifts.billRate`). Any NEW non-admin-reachable surface
that joins shift/time-entry finance must repeat this. Out of scope (intentional):
`clientPortal.ts` shows a client THEIR OWN bill rate; `exports.ts`/`admin.ts` are admin-only.
Pinned by an officer test in `__tests__/leadOwnFinance.test.ts`.
