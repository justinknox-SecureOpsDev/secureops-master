---
name: Site processing fees do not re-price existing invoices
description: Each site owns its invoice processing fee; stored invoice fee fields are historical snapshots unless a draft is auto-resynced or an admin explicitly recalculates.
---

Each site's processing-fee setting is the sole input for new invoice
calculations. Existing invoices retain their stored `processing_fee_rate`,
`processing_fee_amount`, and `total_amount` snapshots.

**Why:** a fee is part of the financial record presented and potentially paid
by the client. A later site-policy change must not silently rewrite settled
records. Open auto-synced drafts are the exception because they are still
derived from the current roster/time-entry data.

**How to apply:**
- Configure the fee on the specific site; sites start disabled and default to
  an 8.25% rate when enabled.
- A site-fee change re-syncs that site's open auto-synced draft invoices.
  Paid and void invoices must remain unchanged.
- Re-pricing is done per invoice via `POST /invoices/:id/recalculate-fee`, which
  refuses `paid` and `void` (settled financial records) but allows
  `draft`/`sent`/`overdue`. The admin-portal Recalculate button must stay
  visible for **drafts** too — right after changing a site fee, drafts are the
  most common thing an admin is staring at, and hiding the button there leaves
  no UI path to fix them.
- `calcTotals` recomputes `subtotal` from the stored line items as well as the
  fee, so a recalculate also picks up any line-item drift. That is intended, but
  it means recalculate is not a fee-only operation.
