---
name: Subcontractor self-service portal pattern
description: How the subcontractor vendor portal mirrors the client portal (external-party account type, invite-before-record, upload ownership).
---

Subcontractors are a third external-party role (alongside client) with their own persistent login, not a one-time link.

**Invite-before-record:** admin invite only collects an email and creates a placeholder `users` row (role `"subcontractor"`, `subcontractorId` null). The actual `subcontractors` table record is created on the vendor's OWN first profile submission (which also splits `contactName` into `firstName`/`lastName`). Don't require admin to pre-fill vendor data.

**Why:** admins were manually re-collecting COI/W-9/bank info every time; self-service only works if the record can start empty and be completed by the vendor.

**How to apply:** any new external-party account type (client, subcontractor, and future ones) should follow this same trio:
1. `usersTable.<role>Id` nullable FK, `onDelete: "set null"`, mirroring `clientId`.
2. A dedicated `require<Role>` auth middleware mirroring `requireClient`/`requireSubcontractor`.
3. Ownership-scoped upload endpoints keyed by `/objects/uploads/u/<userId>/` prefix — never trust a client-supplied record id for file access.

**Sensitive-field convention:** fields like Tax ID / bank account+routing are masked to last-4 on every read; the save endpoint treats the masked placeholder value as "no change" (don't overwrite real data with the mask string).

**Router classification gate:** any new router mounted in `routes/index.ts` MUST be deliberately added to either `CORE_UNGATED_ROUTERS` or `SELF_GATED_ROUTERS` in `featureGating.test.ts` — external-party portals (client, subcontractor) are core/ungated since they're an account type, not a paid feature tier. Forgetting this makes the whole gate test fail with "UNGATED ROUTER".
