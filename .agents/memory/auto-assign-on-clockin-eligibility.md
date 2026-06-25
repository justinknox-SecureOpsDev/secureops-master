---
name: Auto-assign on clock-in must honor claim eligibility
description: Why the ad-hoc clock-in auto-assign path enforces the same licence-level gate as the manual shift-claim route.
---

# Auto-assign on ad-hoc clock-in must honor the same eligibility as manual claim

When an officer does an ad-hoc geo clock-in (mobile sends only lat/lng, no shiftId)
and has no accepted assignment, the clock-in handler auto-assigns them to an OPEN
shift at the resolved site so they surface on the Dispatch status board (which is
driven entirely by *accepted* shift_assignments joined to an open time entry with a
non-null matching shiftId — ad-hoc clock-ins with null shiftId never appear as on
duty otherwise).

**Rule:** any path that creates an `accepted` shift_assignment row (auto-assign on
clock-in, dispatch auto-assign, swaps, admin-assign, AND the scheduler-webhook roster
sync `reconcileShiftRoster`) must apply the same licence-level eligibility gate as
`POST /shifts/:id/claim` — `shift.requiredLicenseLevel <= getEffectiveLevel(userId)`
(higher covers lower; effective level = MAX(highest unexpired licence, support-staff
baseline)).

**Broader rule (the geo ad-hoc resolve has THREE shift-returning paths, not just auto-assign):**
`resolveOrAssignShiftForAdHocClockIn` can bind a `shiftId` to the time entry — and flip that
shift to `status='active'` — via (1) an already-accepted assignment at the resolved site,
(2) auto-assign to an open shift, or (3) a billing-only `findMatchingScheduledShift` fallback.
The licence-level gate must cover ALL THREE, not only the assignment-creating step (2).
Step 1 (rostered but under-licensed — e.g. an admin mis-assigned them to an armed shift) must
return 403 `license_required` exactly like the explicit `shiftId` path. Step 3 (not rostered)
must SKIP the attach (clock in site-only, `shiftId` null) rather than 403 — there was no
accepted assignment to block. Pass the caller's effective level in (Infinity for admins so
they bypass; step 2 keeps its own freshly-read worker level so admin auto-assign behaviour is
unchanged). Attaching OR activating a higher-level shift is just as much a false
compliance/billing record as creating the assignment, so a `shiftId`-only/`status='active'`
flip is NOT a safe shortcut around the gate.

**Scheduler roster sync:** the external scheduler is NOT trusted to vet clearance, so
`reconcileShiftRoster` SKIPS under-licensed officers in `assignedOfficerEmails` (logged
warn), treating them exactly like an unlisted email — not added, and removed from the
roster if a later edit raises the bar above their level. Tests that roster a *secondary*
officer onto a level-≥2 shift must now give that officer an unexpired licence in setup,
or the gate correctly drops them and the assertion fails.

**Why:** the clock-in handler only checks the officer holds *some* unexpired licence,
not the shift's required level. Without the extra gate, an L2/L3 officer could be
auto-assigned to an L4/armed shift, creating a compliance/billing record asserting
they covered work they aren't licensed for. This is a security-compliance product;
that record is the problem, not just the UI.

**Headcount/fullness:** count ALL assignment rows in the authoritative in-tx recheck
(matches the claim route), not just `status='accepted'`. In practice they're equal —
decline DELETEs the assignment row and one-tap reserve inserts `accepted` directly, so
every row is `accepted` — but counting all keeps the fullness gate identical to claim.
The race-safe pattern is: per-candidate tx + `SELECT ... FOR UPDATE` on the shift row +
dup check + headcount recheck + INSERT.
