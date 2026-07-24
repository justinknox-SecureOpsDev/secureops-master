---
name: Inactive-site lifecycle invariant
description: What site status='inactive' must block vs deliberately allow, and the multiple shift-insert paths that each need the guard.
---

Sites are retired via `sites.status='inactive'` instead of hard-delete (delete stays 409-blocked with dependents).

**The invariant:** deactivation blocks NEW work intake only — existing operations continue.

**Must block (each path checks status itself):**
- `GET /sites` default listing (active only unless `includeInactive=true`)
- geo clock-in nearest-site resolution + `/me/clock-in-sites` picker
- `POST /shifts` and `/shifts/repeat`
- client-portal site picker, coverage-request creation, AND coverage-request **approval** — approval inserts shifts directly in its own transaction, bypassing `POST /shifts`, so the guard must be re-applied there.

**Why the approval path matters:** any route that inserts into `shifts` directly is a second intake path; a new "sites can't take X" rule must be grepped against ALL `insert(shiftsTable)` call sites, not just the canonical route.

**Deliberately NOT blocked (do not "fix"):**
- invoiceSync/payroll (late approvals for a retired site must still bill)
- scheduler webhook inbound sync (data integrity)
- existing upcoming shifts staying claimable/clockable
- admin manual + dispatch clock-in with explicit siteId (trusted-admin recovery)

**How to apply:** when adding any new shift/coverage/booking intake surface, add the `status='active'` check; when a scan flags the allowed paths above, they are intentional (comments in code note this).
