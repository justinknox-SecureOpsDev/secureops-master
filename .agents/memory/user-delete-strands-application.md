---
name: User delete strands application
description: Deleting a user row leaves applications.created_employee_id dangling (no FK); every user-delete path must un-strand the linked application, and boot repairs of stranded rows must be concurrency-safe.
---

`applications.created_employee_id` has **NO foreign key** to `users`. Deleting a
user (or a cascade removing them) leaves any application that pointed at them
frozen as `approved` referencing a now-missing account. That applicant silently
disappears from the Onboarding list and can never log in or finish onboarding.

**Rule:** Every path that deletes a `users` row must un-strand its linked
application(s) in the SAME transaction — set the application back to
`under_review`, clear `created_employee_id`, both two-admin approvals, and all
onboarding-email fields. Use the shared reset helper (`lib/onboardingLifecycle.ts`
`resetApplicationsForDeletedUser`) so the dedicated "Remove from onboarding"
action and the generic admin Users-table CRUD delete can never drift apart.

**Why:** The generic admin table delete (`DELETE /admin/tables/users/:id`)
originally removed the user with no application cleanup, stranding ~26 real
approved applicants in prod (May–Jul 2026). The dedicated
`DELETE /admin/onboarding/:employeeId` path always cleaned up; only the generic
CRUD path was buggy — so the two delete paths MUST share one cleanup.

**How to apply:** Any new user-delete surface (bulk delete, cascade, admin CRUD)
must call the shared reset before/with the delete. Repairing already-stranded
rows in prod = idempotent boot backfill + republish, since agent SQL only
writes dev (prod DB is separate + read-only).

**Boot-repair concurrency (the non-obvious part):** A boot backfill that
PROVISIONS accounts + SENDS invites must survive redeploy overlap (two instances
booting at once). Pre-selecting rows then processing is NOT safe — both
instances double-provision + double-invite the same person. Claim each row with
`SELECT ... FOR UPDATE` + re-check "still stranded" INSIDE the per-row tx so the
loser bails. Notify AFTER commit (email/SMS can't live in a DB tx) = at-most-once
delivery; record delivery status so an admin can resend. Never reuse/overwrite an
account that already owns the applicant's email — it may be a different
legitimate onboarding; skip for manual review. SMS is NOT env-suppressed (unlike
email), so gate the whole auto-repair to `NODE_ENV=production` with an off-switch
env var.
