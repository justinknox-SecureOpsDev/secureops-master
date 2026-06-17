---
name: PPO Detail protection package
description: Authz model + mobile photo-signing rule for the executive-protection (close-protection) shift package — the highest-sensitivity PII surface.
---

# PPO Detail protection package

A shift with `shifts.shiftType = "ppo_detail"` carries an executive-protection
package: `protection_details` (1:1), `protection_persons` (kind principal|threat,
optional demographics + `photoKeys` jsonb string[] of object paths), and ordered
geocoded `protection_destinations`. It holds the most sensitive PII in the system.

## Authorization (must stay invariant)

- **Read** (`GET /shifts/:id/protection-detail`): admin/dispatcher/lead OR an
  `employee` with an **ACCEPTED** assignment to that exact shift. Everyone else
  (pending/unassigned officer, client, unauth) → 403/401.
- **Write** (`PUT`): admin only (`requireAdmin`), replace-all, geocodes
  destinations. Audited as `shifts.write` (router-level audit middleware; raw
  body redacted to counts).
- **Photos**: `canSignProtectionPhoto(path, userId, role)` mirrors the read rule —
  exact `jsonb_exists(photoKeys, path)` membership, staff readers allowed, employees
  need an accepted assignment to a parent shift.
- **NEVER** on public/share surfaces (incident share links etc.).

## Mobile signs ALL roles through `/me/storage/sign`

The mobile read view (`security-ops/components/ProtectionPackageView.tsx`) uses
`AttachmentImage scope="me"` (→ `GET /me/storage/sign`) uniformly for every role.

**Why this matters:** staff readers (admin/dispatcher) generally have **no
employee row**. `/me/storage/sign` must therefore NOT early-403 on a missing
employee row. Employee-scoped owned-object sources (employee doc keys, own
incident attachments, own renewal docs) are gated behind `if (emp)`; the final
allow/deny is `owned.has(path) || canSignProtectionPhoto(...)`. This lets staff
sign protection photos without widening access to any foreign object (a no-emp
caller gets an empty `owned` set and can only reach protection photos).

**How to apply:** any new role/surface that needs to display protection photos on
mobile should rely on `canSignProtectionPhoto`, not on having an employee row.
Don't reintroduce a blanket "No employee record" 403 at the top of that handler.
