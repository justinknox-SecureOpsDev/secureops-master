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

- **Read** (`GET /shifts/:id/protection-detail`): admin ONLY, OR an `employee`
  with an **ACCEPTED** assignment to that exact shift. Least-privilege on the
  highest-sensitivity PII: dispatcher, site_manager, client, pending/unassigned
  officer, unauth all → 403/401. **Why:** this is the most sensitive PII in the
  system, so standing role-based access (dispatcher/site_manager) is explicitly
  NOT granted — the only non-admin path is a per-shift accepted assignment.
- **Write** (`PUT`): admin only (`requireAdmin`), replace-all, geocodes
  destinations. Audited as `shifts.write` (router-level audit middleware; raw
  body redacted to counts).
  - **Replace-all wipes omitted sub-collections.** The PUT deletes+reinserts
    persons AND destinations from the body (`body.principals ?? []` etc.), so any
    caller/test that re-saves to tweak one collection MUST re-send the others or
    it silently nukes them — and downstream state-dependent reads (e.g. the
    photo-sign tests that need a principal's `photoKey` present) will fail.
  - **Destination ordering is positional**: `seq` is derived from array index on
    write, so reordering = reorder the array (no explicit seq field from client).
  - **arrival/departure are timestamptz** → coerce client ISO strings to `Date`
    (`new Date(...)`) before insert; passing the raw string into a drizzle
    timestamp column is the latent bug that was here.
- **Photos**: `canSignProtectionPhoto(path, userId, role)` mirrors the read rule —
  exact `jsonb_exists(photoKeys, path)` membership; admin allowed, employees need
  an accepted assignment to a parent shift, every other role refused.
- **NEVER** on public/share surfaces (incident share links etc.).

## Mobile signs ALL roles through `/me/storage/sign`

The mobile read view (`security-ops/components/ProtectionPackageView.tsx`) uses
`AttachmentImage scope="me"` (→ `GET /me/storage/sign`) uniformly for every role.

**Why this matters:** an admin generally has **no employee row**.
`/me/storage/sign` must therefore NOT early-403 on a missing employee row.
Employee-scoped owned-object sources (employee doc keys, own incident
attachments, own renewal docs) are gated behind `if (emp)`; the final allow/deny
is `owned.has(path) || canSignProtectionPhoto(...)`. This lets an admin sign
protection photos without widening access to any foreign object (a no-emp caller
gets an empty `owned` set and can only reach protection photos).

**How to apply:** any new role/surface that needs to display protection photos on
mobile should rely on `canSignProtectionPhoto`, not on having an employee row.
Don't reintroduce a blanket "No employee record" 403 at the top of that handler.
