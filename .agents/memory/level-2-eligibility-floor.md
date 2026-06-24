---
name: Level-2 eligibility floor
description: Unarmed (level ≤ 2) shifts are open to every employee; how the floor is implemented and what it must NOT touch.
---

# Level-2 eligibility floor

`lib/eligibility.ts` (api-server) defines `BASE_ELIGIBILITY_LEVEL = 2`. The shared
helpers floor at it, but the floor is EMPLOYEE-only (see role gate below):
- `getEffectiveLevel(userId)` → `Math.max(licenceMax, positionBaseline, isWorkerRole(role) ? 2 : 0)` — floor ONLY for worker roles (employee / site_manager)
- `effectiveLevelSql` → `greatest(licenceMax, supportBaseline, 2)` — floors unconditionally; safe only because every caller pre-filters `role='employee'`

**Rule:** any active employee can SEE and ACCEPT (claim) level-1 and level-2
unarmed shifts regardless of whether they hold a licence. Armed (3) and L4/PPO (4)
still require the officer to actually hold an unexpired licence at that level.

**Why:** business decision — WCSG wants unarmed posts fillable by anyone on staff,
not just licensed officers. Support-staff baseline (1) is now subsumed by the floor.

**The floor is EMPLOYEE-only, gated on `users.role`.** `getEffectiveLevel` floors
at 2 ONLY when the user's role is a worker role (`employee` / `site_manager`, via
`isWorkerRole`); non-worker accounts (admin / dispatcher / client) stay at their
real level (0). This matters because the claim route is bare `requireAuth` and
manual/scheduler assignment takes an arbitrary user id — an unconditional floor
would silently let a non-employee claim or be assigned to unarmed shifts. **Gate
on role, NOT the presence of an `employees` row** — provisioning is not guaranteed
to create an employees row (test fixtures and some data states have role=employee
with no employees row), so an employees-row gate wrongly drops real employees to
0. The SQL helper `effectiveLevelSql` and the inline dispatch `effLevel` floor
unconditionally, but that is safe because every query using them is already scoped
to `role='employee' AND status='active'`.

**How to apply:**
- The two shared helpers are the single point of truth. Every shift-eligibility
  surface (shifts list/claim/assign/broadcast, time-entry clock-in auto-assign,
  shift swaps, availability, scheduler webhook) inherits the floor automatically —
  do NOT re-implement an eligibility comparison anywhere else.
- One surface does NOT use the helpers: `dispatch.ts /assign-nearest` computes its
  own correlated-subquery `effLevel` (the aggregate-form `effectiveLevelSql` needs
  a GROUP BY it doesn't have). It was given the same `GREATEST(..., 2)` floor — if
  you touch eligibility, remember this second inline copy exists.
- The effective level is an ELIGIBILITY figure, **not** a statement of a held
  licence. A no-licence employee reads as effective 2 but holds nothing. Any
  surface that reports a *held* licence (officer profile, PDFs, licence grid, and
  the claim/assign 403 messages) must read the licence rows directly — never the
  effective level. The 403 messages describe the *requirement* ("requires a valid
  Level 3 (armed) licence …"), not the caller's level, for exactly this reason.
- **Chat is NOT affected.** Chat license-level / site rooms compute membership from
  `MAX(licenses.level)` directly in their own SQL, not from these helpers. Flooring
  eligibility must never silently widen chat room access — keep chat reading the
  real licence max.
- Tests that prove the eligibility GATE still works must use an armed (level 3+)
  shift for the "under-licensed officer is blocked/skipped" case; a level-2 shift
  no longer exercises the gate because everyone clears it.
