---
name: Hiring pipeline — one provisioning transition
description: Account/onboarding provisioning happens at exactly one transition in the applicant pipeline; every sibling status route needs an explicit guard against it.
---

Applicant provisioning (users row + temp password + onboarding token + onboarding
email/SMS + `applications.created_employee_id`) must happen at exactly ONE
transition, and `applications.status === "approved"` alone must never be read as
"this applicant has an account".

**Why:** the pre-hire background-check gate moved provisioning off the second
approval and onto the "check cleared" step. Approved-but-unprovisioned became a
real, long-lived state. Every other status route was written when approval and
provisioning were the same event, so they silently allowed contradictory states:
"mark under review" could drag a gated application back and let the two-admin
approval run again on top of an existing account, and "reject" would mark a
provisioned applicant rejected while leaving a live login and onboarding token.

**How to apply:** when adding any transition to the applicant pipeline
(approve / review / request-info / reject / background-check), decide explicitly
what it does at each of: pre-approval, gated-not-provisioned, provisioned. Gate
on `createdEmployeeId` for "does an account exist" and on the background-check
column for "is it parked at the gate" — not on `status`. Same rule for a
provisioning failure inside the clear step: do not record the gate as passed
unless the account was actually created, or the applicant is stranded (cleared,
no login, no way back through the gate).

Related: any admin-supplied object key that gets copied onto a person's file
must be bound to the acting user's own upload namespace
(`/objects/uploads/u/<userId>/`), never accepted as a bare `/objects/...` path.
