---
name: Subcontractor QR rate flow
description: Where subcontractor pay/bill rates live and the public-endpoint rate-free invariant
---

# Subcontractor QR rates

Rates live on the **QR token** (`subcontractor_qr_tokens.pay_rate` / `bill_rate`), NOT on
individual time entries. Entries keep `qr_token_id`, so rate resolution is always a join.

**Rules:**
- Invoice bill-rate priority: QR token `billRate` → site `defaultBillRate` → unpriced
  (surfaces via unpricedHours). Holiday 1.5× + cent rounding applies to whichever rate wins.
- `payRate` is admin-only reference data; it never affects client invoices.
- **Public endpoints must stay rate-free**: `GET/POST /subcontractor/clock/:token` return only
  site/company context. A test (`subcontractorQrRates.test.ts`) guards this — keep it green
  when touching those responses.
- Changing a token's rate does NOT retro-reprice already-generated draft invoices; the new
  rate applies on the next `upsertWeeklyInvoice` re-sync (same behavior as the fee toggle).

**Why:** People scanning the QR code are subcontractor workers; showing pay/bill rates leaks
WCSG's margins to vendors and clients' rates to workers.
