---
name: Clock-in license gate scope
description: Which clock-in paths enforce the "unexpired license" check and why an accepted assignment bypasses it.
---

# Clock-in license gate scope

**Rule:** The blanket "must hold ≥1 unexpired license" 403 (`license_expired`) on POST /time-entries/clock-in applies ONLY to the ad-hoc GPS path (no `shiftId`, no `siteId`). The `shiftId` path and the manual site-pick path rely on an **accepted shift_assignment** as their authorization — an accepted assignment carries the admin's licensing decision (incl. `overrideLicense:true`), so no license re-check happens at clock-in.

**Why:** Admins can assign unlicensed/expired-license workers deliberately (`overrideLicense:true` on assignment). A blanket license gate at clock-in silently vetoed that admin decision and locked those workers out. Every accepted assignment is admin-created, admin-approved, or license-gated at creation (self-claims land `pending_approval` and only staff can accept), so trusting it is safe.

**How to apply:**
- Never re-add a path-agnostic license check to clock-in; if a new clock-in path is added, decide: assignment-backed → no license gate; ad-hoc/auto-assign → must apply the effective-level eligibility filter (same as geo auto-assign).
- `pending_approval` assignments must NEVER authorize clock-in (pinned by test in timeEntriesClockIn.test.ts).
- Accepted TOCTOU: a license expiring after acceptance still permits clock-in — intended, not a bug.
