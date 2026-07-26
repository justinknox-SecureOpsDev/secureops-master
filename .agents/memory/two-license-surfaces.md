---
name: Two license surfaces must stay in sync
description: SecureOps stores license data in two places; any flow that changes a license must update both or the officer profile goes stale.
---

# Two license surfaces

SecureOps keeps officer license data in **two** places, and they are NOT automatically linked:

1. **`licenses` table** — the eligibility source of truth (`maxLicenseLevel`, expiry reminders, shift-claim gating). Has its own `docKey` (card photo).
2. **`employees` table** denormalized snapshot — `siaLicenseLevel / siaLicenseNumber / siaLicenseExpiry / licenseDocKey` (UK column names, US labels), originally captured at onboarding. This is what the **admin OfficerProfile "Licence" section AND the profile PDF actually render** — they do NOT read the `licenses` table.

**Rule:** any flow that changes an officer's license (renewal approval, admin edit, onboarding) must write to BOTH surfaces, or the profile/PDF shows stale onboarding-time values even though eligibility is correct.

**Why:** the license-renewal approve handler originally only updated the `licenses` table, so approved renewals never showed up on the officer profile (wrong level, missing/old card photo). Fix mirrors the renewal onto `employees` in the same transaction.

**How to apply:** key the `employees` write on `eq(employeesTable.userId, <userId>)` — note `licenses.employeeId` is actually a `users.id`, same id space as `employees.userId`. Every user has an `employees` row (boot backfill ensures this), so the mirror UPDATE is safe.

**Partial-import corollary:** any upsert that *partially* updates a license (AI/PDF import, bulk edits) must NOT clobber the existing `licenses.level` when the incoming payload omits a level — `level: incoming ?? null` silently downgrades eligibility. On the update branch set `level` only when it was actually provided; on insert, null is fine.

**Active-license selection (create/edit paths):** license upload (`POST /licenses`) and edit (`PUT /licenses/:id`) mirror by recomputing the officer's **ACTIVE** license — the row with the latest `expiryDate` (`createdAt` tiebreak) — and writing THAT onto `employees`, inside the same transaction. This is deliberately smarter than a blind mirror: uploading/editing an *older* or expired license row must NOT clobber the profile with stale data. In the recompute path, only set `licenseDocKey` when the active license actually has a `docKey` — never blank an existing card photo just because the newest row lacks a scan.

**Renewal-path divergence (known):** the renewal-approve handler still *blind-mirrors* the approved renewal onto `employees` instead of recomputing the active license. It's safe in practice because a renewal extends expiry, so the renewed license is normally the active one — but the two writers diverge. If you touch any license writer, prefer funneling all of them through the shared active-recompute helper so there is ONE mirror invariant.

**Not-in-scope authz note:** `PUT /licenses/:id` is gated only by `requireStaff` (no self/admin ownership check, unlike `POST` and `GET` which restrict non-admins to their own record) — a latent IDOR where any staff user could edit another officer's license by UUID. Pre-existing; flagged, not fixed.
