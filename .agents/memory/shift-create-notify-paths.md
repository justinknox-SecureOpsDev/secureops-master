---
name: Shift-create notification fan-out
description: The complete set of shift-create code paths that must notify, and the conventions each follows.
---

# Shift-create notification fan-out

There are FOUR distinct paths that insert into `shiftsTable`. Any change to "who
gets paged when a shift is created" must be applied consistently across all of
them — they do not share one chokepoint at the route layer:

1. `POST /shifts` (routes/shifts.ts) — single create. Calls the shared
   `lib/shiftNotify.notifyShiftCreated(shift)`.
2. `processInboundShift` (routes/schedulerWebhook.ts) — scheduler ingest, the
   PRIMARY production source. Calls `notifyShiftCreated` on the create branch.
3. `POST /shifts/repeat` (routes/shifts.ts) — bulk series (up to 366×). Sends
   ONE summary `site_shift_created` push+SMS to the site's managers; does NOT
   per-instance broadcast worker availability (storm avoidance).
4. `POST /admin/shift-requests/:id/approve` (routes/clientPortal.ts) — approves
   a client coverage request, inserting a date-range × licence-level loop of
   shifts. Sends ONE summary manager notification (mirrors path 3).

**Conventions (the durable decisions):**
- The worker "shift_available" broadcast targets `WORKER_ROLES` =
  employee + site_manager (NOT just employee). A site manager is a worker too.
- A site manager of THE SHIFT'S OWN site gets BOTH the worker broadcast AND the
  manager `site_shift_created` notice — do NOT dedupe/exclude them.
  **Why:** product requirement is literal "site managers still get the same
  employee notifications as well" in addition to the manager notice.
- Single-create paths (1, 2) fan out per shift. Bulk paths (3, 4) send a single
  summary manager notice and skip per-instance worker broadcasts to avoid a
  notification storm.
- `notifyShiftCreated` skips past-dated shifts (startTime <= now) so a scheduler
  backfill of historical rows pages nobody.

## ON CONFLICT DO UPDATE: fire side effects only on a genuine INSERT
`processInboundShift` upserts via `insert(...).onConflictDoUpdate(...)`. The
webhook and the periodic reconcile pull can both process the same `externalId`
concurrently and both miss the pre-SELECT, so both reach the upsert. To page
recipients at most once, detect a true insert in RETURNING:
`sql\`(xmax::text::bigint = 0)\`` — xmax is 0 for a freshly inserted tuple and
nonzero for the ON CONFLICT DO UPDATE loser. Gate the notification (and the
"created" vs "updated" action) on that flag. Cast through ::text::bigint, not
`= 0` directly (xid has no implicit int operator; xid range overflows int4).
