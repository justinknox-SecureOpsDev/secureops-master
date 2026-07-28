---
name: Invoice send preview gate
description: Invoice emails cannot be sent without redeeming a single-use preview ticket; what the ticket fingerprint must cover and why "mark sent" is not a bypass.
---

# Invoice send requires a redeemed preview ticket

An invoice email cannot go out until an admin has seen the actual rendered
email and pressed confirm. This is enforced **server-side**, not by the dialog:
`POST /invoices/send-preview` renders the email and issues a single-use ticket
bound to `(invoiceId, adminUserId, contentDigest)`; `POST /invoices/:id/send`
redeems it **before any mutation** and returns `409 { code: "preview_required" }`
otherwise.

**Why:** a dialog is only a convention — any caller (a script, a stale tab, a
future bulk action) can POST straight to the send endpoint. The user asked that
invoices "can't send" without review, which only a server-side interlock
delivers. A `confirmed: true` boolean would not work: it is satisfiable by a
caller that never rendered a preview. The ticket cannot be produced without
actually rendering the email.

**How to apply:**

- Any *new* path that emails an invoice must redeem a ticket. Do not add a
  second send route that skips it.
- The digest must cover **everything the client can see** — the email body *and*
  every field printed on the attached PDF (`clientAddress`, `notes`, `siteName`,
  dates), not just the money fields. A PDF-only field that is left out of the
  digest lets the attachment change after approval. `renderInvoiceEmail` builds
  a narrowed row for the digest, so a field added to the PDF must be added
  there too or it is silently uncovered.
- The recipient address is **deliberately excluded** from the digest: the To
  field is editable inside the confirmation dialog, so changing it is already a
  deliberate act taken while looking at the preview.
- The ticket store is in-memory with a 30-minute TTL. Losing tickets on restart
  fails **closed** (the admin re-reviews). Do not "fix" this by relaxing the
  check or persisting weakly.
- The From address must never appear in the preview payload or UI — it comes
  from the `RESEND_FROM` / `SMTP_FROM` secret. Only Reply-to is shown.

## "Mark sent" is not a bypass

`PUT /invoices/:id` accepts `status: "sent"` and the portal has a bulk
"Mark sent" action. Code review flags this as a hole in the gate; it is not.
That route **sends no email** — it is bookkeeping for "delivered by other
means". The gate is about email leaving the building. Blocking it would break a
legitimate workflow. Confirm this before "closing" it.
