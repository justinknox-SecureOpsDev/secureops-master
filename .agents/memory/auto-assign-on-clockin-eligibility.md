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
clock-in, dispatch auto-assign, swaps, admin-assign) must apply the same licence-level
eligibility gate as `POST /shifts/:id/claim` — `shift.requiredLicenseLevel <=
getEffectiveLevel(userId)` (higher covers lower; effective level = MAX(highest
unexpired licence, support-staff baseline)).

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
