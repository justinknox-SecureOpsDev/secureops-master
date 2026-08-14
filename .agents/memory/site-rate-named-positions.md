---
name: Site rates are named positions; rate_tier is an internal slot
description: Why site_rates.rate_tier survives as a hidden auto-assigned slot, how position names resolve on shifts, and the eligibility boundary.
---

Rule: a site's rate card is a list of admin-NAMED positions. The name is the
only rate identity admins see or pick. `rate_tier` still exists but is an
INTERNAL slot number assigned server-side (max+1 within the license level) and
must never be exposed as a picker or validated to 1–3.

**Why:** the historical `(site_id, license_level, rate_tier)` unique constraint
is on a populated production table, and this project's publish flow diffs
dev-DB vs prod-DB (adding/altering constraints on populated tables has wiped
tables before). Auto-assigning the slot keeps that constraint satisfiable while
removing the three-per-level cap, with no DDL beyond a nullable `name` column.

**How to apply:**
- Unnamed legacy rows must render a fallback (`Rate <slot>`); every duplicate
  check compares the *display* name so a new "Rate 1" cannot collide with a
  legacy unnamed row at the same level.
- Editing a rate targets it by id (a by-id update route), never an upsert on a
  numbered slot — slot-upsert silently overwrote a different position.
- Shifts snapshot the name at creation but reads prefer the LIVE rate-card name
  (so renames flow through); the snapshot only surfaces once the rate row is
  deleted. Position name is display-only.
- Eligibility (who may claim/be assigned) always comes from the numeric
  `requiredLicenseLevel`, never from a position name. Invoicing and payroll
  grouping likewise stay keyed to license level.
