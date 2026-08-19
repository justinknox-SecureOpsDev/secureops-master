---
name: Platform agreement terms — provider authority
description: Why signed MSA/User-Agreement values may only come from operator-controlled sources, and which tenant-writable sources look safe but aren't.
---

# Signed platform agreements: the customer only accepts

Every value printed into the SOBBU platform agreements (MSA, User Agreement)
is the provider's to set. The signing customer supplies **only** their
acceptance and their own guarantor details. Fields carry an explicit
`authority` (`provider` | `customer`) and provider is the fail-safe default.

**Why:** the customer's own first admin is a **super-admin** by design (they
need branding and platform screens). "Super-admin" is therefore *not* the
authority boundary — treating it as one lets a customer set the price, plan
tier, legal name or billing contact on the contract they then sign.

**How to apply — adding or changing an agreement field:**

- Resolve provider values **only** from operator-controlled sources: the
  control-plane-owned columns of platform customer config, operator env, org
  code, deployment domain, static defaults.
- Never source one from tenant-editable configuration. Brand config is the
  trap: it is edited from the tenant portal, so `brand.companyName` /
  `brand.billingEmail` are customer-controlled values. Prefer no fallback at
  all — a blank required term must **block signing** ("contact SOBBU"), never
  quietly borrow a tenant value and never offer the customer an input.
- Provider-owned columns of the customer-config row are refused (403, no
  partial write) by the tenant-facing update route and are read-only in the
  portal; the control-plane HMAC route remains their only writer.
- Required operator env for a signable agreement is enforced by the tenant
  preflight check, so an operator can't ship an unsignable deployment.

**How to apply — the terms digest:** signing-context publishes a digest that
must round-trip on POST (mismatch = 409 `terms_changed`). It must cover the
**document text and consent wording**, not just the values — and the signing
page must render the template the *server* returned, or a stale browser bundle
can display one document and sign another. The signer's own inputs
(guarantor details, signature) are deliberately outside the digest.
