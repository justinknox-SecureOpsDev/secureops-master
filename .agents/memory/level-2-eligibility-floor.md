---
name: Level-2 eligibility floor & worker roles
description: Unarmed (level ≤ 2) shifts are open to every internal staff role; how the floor and the WORKER_ROLES gate are implemented and what they must NOT touch.
---

# Level-2 eligibility floor & worker roles

`lib/eligibility.ts` (api-server) defines `BASE_ELIGIBILITY_LEVEL = 2` and
`WORKER_ROLES = [employee, site_manager, dispatcher, admin]` with `isWorkerRole`:
- `getEffectiveLevel(userId)` → `Math.max(licenceMax, positionBaseline, isWorkerRole(role) ? 2 : 0)` — floor for ALL worker roles
- `effectiveLevelSql` → `greatest(licenceMax, supportBaseline, 2)` — floors unconditionally; safe only because every caller pre-filters `inArray(role, WORKER_ROLES)`

**Rule (July 2026):** EVERY internal staff role — admin, dispatcher, site_manager,
employee — has employee-level worker permissions: see/claim/be-assigned shifts.
Unarmed (level 1–2) work is open to all of them regardless of licence. Armed (3)
and L4/PPO (4) still require an actually held unexpired licence at that level.

**Why:** business decision — WCSG staff at every level work shifts; the earlier
employee-only worker set was replaced. Support-staff baseline (1) is subsumed.

**The ONLY excluded role is `client` (external client-portal users).** The floor
is gated on `isWorkerRole`, and the client barrier is the WORKER_ROLES pre-filter
plus an explicit `isWorkerRole` 403 on the claim route — an unconditional floor
without those gates would let client accounts claim unarmed shifts. **Gate on
role, NOT the presence of an `employees` row** — provisioning is not guaranteed
to create an employees row (admins and test fixtures may lack one), so an
employees-row gate wrongly drops real workers to 0.

**How to apply:**
- The two shared helpers are the single point of truth. Every shift-eligibility
  surface (shifts list/claim/assign/broadcast, clock-in auto-assign, swaps,
  availability, scheduler) inherits floor + role set automatically — never
  re-implement eligibility or a role list elsewhere.
- `dispatch.ts /assign-nearest` keeps its own inline correlated-subquery
  `effLevel` with the same `GREATEST(..., 2)` floor — second inline copy exists.
- `GET /shifts?view=worker` gives admins/dispatchers/site-managers the PERSONAL
  employee feed (real `getEffectiveLevel`, not global read); finance stripping
  stays keyed on the RAW role, so site_manager loses all finance even there.
- Effective level is an ELIGIBILITY figure, **not** a held licence. Surfaces
  reporting a *held* licence (profile, PDFs, licence grid, 403 messages) must
  read licence rows directly.
- **Chat is NOT affected.** Chat rooms compute membership from
  `MAX(licenses.level)` directly — the floor and widened WORKER_ROLES must never
  silently widen chat access.
- Gate tests must use an armed (level 3+) shift for "blocked" cases; level-2 no
  longer exercises the gate. The claim-route client-exclusion test covers the
  403 barrier.
- Known side effect: admins/dispatchers now receive worker broadcast pushes on
  shift creation (they're in the qualifying-worker set).
