---
name: Processing fee toggle does not re-price existing invoices
description: Enabling the global/per-site processing fee only affects invoices created afterwards; existing rows keep NULL fee columns and need an explicit recalculate.
---

Turning the processing fee on (platform_customer_config.processing_fee_enabled,
or a per-site fee setting) changes only what **future** invoice writes compute.
Every invoice that already exists keeps `processing_fee_rate` /
`processing_fee_amount` NULL and its old `total_amount`.

**Why:** the fee is read from an in-memory singleton at invoice-write time
(`calcTotals`). There is no migration or trigger that walks existing rows when
the toggle flips, and the config's `updated_at` is frequently *later* than the
creation time of every invoice in the table — so "the fee isn't working" is
almost always this, not a computation bug.

**How to apply:**
- Diagnose by comparing `platform_customer_config.updated_at` against
  `max(invoices.created_at)`. If the config is newer, no invoice could have
  picked the fee up, and `count(*) FILTER (WHERE processing_fee_amount IS NOT NULL)`
  will be 0.
- Re-pricing is done per invoice via `POST /invoices/:id/recalculate-fee`, which
  refuses `paid` and `void` (settled financial records) but allows
  `draft`/`sent`/`overdue`. The admin-portal Recalculate button must stay
  visible for **drafts** too — right after flipping the toggle, drafts are the
  most common thing an admin is staring at, and hiding the button there leaves
  no UI path to fix them.
- `calcTotals` recomputes `subtotal` from the stored line items as well as the
  fee, so a recalculate also picks up any line-item drift. That is intended, but
  it means recalculate is not a fee-only operation.
- Site-level fee changes are handled separately by
  `resyncSiteAutoSyncedDrafts()` on site save; the **global** toggle has no
  equivalent auto-resync.
