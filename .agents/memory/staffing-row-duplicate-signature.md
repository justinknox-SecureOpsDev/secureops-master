---
name: Staffing-row duplicates keyed by level + rate signature
description: Multi-position shift creation allows the same license level at different rate tiers; duplicates are level+rate, not level alone.
---

Rule: in multi-position shift creation (bulk-create and repeat), two staffing
rows are duplicates only when they share BOTH the license level AND the rate
selection (same site-rate-card id, or for custom rows, identical pay+bill
values). Same level at different tiers (e.g. L3 Rate 1 + L3 Rate 2) is a
legitimate staffing pattern and must be accepted.

**Why:** the first implementation rejected duplicate license levels outright,
which blocked admins from staffing one shift with two rate tiers of the same
level — a real WCSG use case reported as "can't select different rate tiers
when creating repeating shifts."

**How to apply:** the signature lives in three places that must stay in sync:
the shared frontend helper (`staffingRowSignature` / `hasDuplicateStaffingRows`
in the admin portal's StaffingRowsEditor), and the server-side validation in
both `POST /shifts/bulk-create` and `POST /shifts/repeat`. Any new bulk-staffing
entry point must reuse the same signature semantics, not level-only checks.
