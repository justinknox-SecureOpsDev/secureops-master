---
name: Invoice unpriced-hours under-billing
description: Approved hours with no resolvable bill rate silently drop from invoices; both generate paths must surface unpricedHours.
---

**Rule:** Any invoice-building path (weekly auto-sync, weekly route, custom-period) must count approved hours it cannot price and surface them as `unpricedHours` (API response + persistent portal banner + `logger.warn` for the UI-less approval hook). Never silently drop them.

**Why:** A prod invoice under-billed ~$1,146 (35 of 130 hours dropped) because ad-hoc time entries had `shift_id NULL` and the site had no `default_bill_rate` — the bill-rate chain (`shifts.billRate` → `sites.defaultBillRate`) resolved to nothing and the entries vanished with only a transient toast on one path and nothing on the weekly path. The customer found it by diffing the CSV.

**How to apply:**
- "Invoice doesn't match time-entries CSV" support reports → first check for entries with `shift_id IS NULL` at a site with `default_bill_rate IS NULL` in the period.
- Remediation is always: set the site's default bill rate → regenerate (creates a NEW draft) → void/delete the short draft. Watch for overlapping weekly drafts before sending (double-billing).
- Any new invoice-building path must accumulate unpriced hours in every entry loop (officer + subcontractor) and compute/log them BEFORE any empty-lineItems early return, or all-unpriced weeks stay silent.
