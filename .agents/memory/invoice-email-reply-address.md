---
name: Invoice email addresses — three distinct surfaces
description: "Wrong email on invoices" can mean the body contact line, the From address, or the reply target; they come from different places.
---

An outbound invoice exposes three different addresses. When someone reports
"the invoice shows the wrong email", establish which one they mean before
changing anything.

1. **Body contact line + PDF footer** — `brand.billingEmail`. Resolution order
   is `platform_brand_config.billing_email` (DB override, loaded into the
   in-memory `brand` object at boot and re-applied on the platform PUT) then the
   `BILLING_EMAIL` env var, then a hardcoded default. Because it is cached in
   memory, a DB correction made *after* the last deploy/boot is not live until
   the server restarts.
2. **From / sender** — `RESEND_FROM || SMTP_FROM`. This is provider config, must
   stay on a verified sending domain, and is *not* editable from the brand admin
   UI. If the visible sender is wrong, the fix is the secret, not the code.
3. **Reply target** — `replyTo` on the message. Without it, replies go back to
   the From address (often a no-reply/system mailbox on the sending domain).
   Invoice sends set `replyTo: brand.billingEmail` so a client hitting Reply
   reaches accounts receivable.

**Why:** these were conflated during a bug report where the prod DB already held
the correct billing address, so the body was right and only the sender/reply
path was wrong — no amount of editing brand config would have fixed it.

**How to apply:** `EmailMessage.replyTo` is optional and wired into *both* the
Resend and SMTP providers; any new transactional email that a human is expected
to answer should set it rather than relying on the From address.
