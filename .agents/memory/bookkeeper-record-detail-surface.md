---
name: Bookkeeper single-record detail surface
description: Which authorization tier to reuse when a non-owner, non-admin permission holder needs to open one record instead of a company-wide view.
---

## The decision

When a list is gated by an "owner OR permission" rule (sanitized for non-owners) but the only "open this record" destination is admin-only, add a separate single-record read/edit surface gated by the **same permission tier as the sibling write route for that record**, not the list's owner-or-permission gate.

**Why:** The line that matters is AGGREGATE vs SINGLE RECORD, not "any dollar figure." A transaction-level permission that already lets its holder create/edit one record necessarily reveals that record's own amounts — a new read endpoint for the same record should match what the existing write route already exposes, not invent stricter sanitization. The admin-only bulk/grid surface stays untouched; this is an additive, narrower surface alongside it, never a loosening of the admin-only one.

**How to apply:** A frontend "Open" action should route an admin to the existing admin surface and route everyone else who can see the row (because they hold the permission) to the new narrower detail page instead of hiding the action. Any list/detail test asserting "no link for a non-admin" needs updating to assert the narrower link instead of no link at all.

## Portal-shell reachability is a separate check from the permission gate

A role can be a valid, assignable target for a transaction-level permission (e.g. in an
ASSIGNABLE_ROLES list) while a portal's top-level role router still unconditionally routes
that role elsewhere (e.g. to a different app's redirect) before the permission is ever
consulted — making the grant a dead end. Always check the top-level router (not just the
list/detail pages) when adding a new assignable role to an existing permission key. Fix
pattern: add a narrow, explicit carve-out in the router (`role === X && hasPermission(key)`)
that renders a minimal dedicated nav/switch for just the surfaces that permission unlocks —
do not reuse an existing role's full nav/switch, since that role may have access the new
one shouldn't.
