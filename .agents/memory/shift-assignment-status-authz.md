---
name: Shift assignment PUT status authz
description: Why PUT /shifts/:id/assignments/:assignmentId must gate status transitions, not just ownership
---

The assignment-update route (`PUT /shifts/:id/assignments/:assignmentId`) historically did an
**ownership-only** check (`canManageRoster || existing.employeeId === caller`) and then ran an
unconditional `db.update(...).set({ status })`. That is NOT sufficient once any status is
privilege-bearing.

**Rule:** a non-manager (officer) may only ACCEPT an admin-issued invite
(`existing.status === 'pending'` → `'accepted'`) or DECLINE their own row (handled separately,
which DELETEs to free the slot). Any other transition by a non-manager must 403 — in particular
they must never push their own `pending_approval` (self-claim awaiting approval) to `accepted`.

**Why:** the shift-claim-requires-approval feature creates a HELD `pending_approval` row on claim;
approval is an admin/lead-only decision. Without the transition gate an officer could PUT their own
row to `accepted` and self-approve, defeating the entire feature (privilege escalation).

**How to apply:** any new assignment status that confers access/headcount/pay must be added to the
allow-list logic in that handler. Ownership alone is never enough — gate on (role, fromStatus,
toStatus).
