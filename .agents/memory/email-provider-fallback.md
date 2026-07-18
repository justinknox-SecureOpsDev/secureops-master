---
name: Email provider fallback (Resend + SMTP)
description: How sendEmailDetailed chooses/falls-back between providers and why bounce-vs-failed classification matters
---

The api-server email sender supports two transports (Resend + SMTP/Gmail) selected by `EMAIL_PROVIDER` (`smtp` | `resend` | `auto`). Each provider helper returns `null` when unconfigured so the orchestrator skips it.

**Bounce vs failed is the load-bearing distinction.** `sendEmailDetailed` returns immediately on `ok` OR `status==="bounced"`, but falls through to the next provider on `"failed"`.

**Why:** a hard "bounced" means the recipient itself is bad — retrying on another provider would just bounce again, so we stop. But a transport/auth/quota/domain-config error must be `"failed"` so fallback can rescue delivery. Classifying a non-recipient error (e.g. Resend "domain not verified", or quota exceeded) as "bounced" silently kills the fallback — the exact bug we were fixing.

**How to apply:** when touching provider error parsing, only mark *recipient-specific* rejections (`invalid recipient/to/email`, `address not exist`) as `bounced`. Everything else (quota, auth, domain/sender verification, network) stays `failed`.

**Prod reality (June 2026):** both providers are configured. Resend free tier silently dies at ~100/day (`daily_quota_exceeded`). Production runs `EMAIL_PROVIDER=smtp` → Gmail/Workspace (admin@williamscouncil.com, App Password) primary, Resend fallback. Gmail SMTP needs an App Password (16 chars) + 2-Step Verification, host smtp.gmail.com:587.
