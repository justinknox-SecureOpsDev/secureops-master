---
name: Right-to-work status is self-editable (self-attested)
description: Why officers can self-edit rightToWorkStatus from the mobile profile, and the guardrail that makes it acceptable.
---

# Right-to-work status is officer-self-editable, by design

Officers CAN edit `rightToWorkStatus` (and DOB, city/state of birth, SSN last 4
`niNumber`, tax code, direct-deposit consent) from the Expo self-service profile
(`PATCH /me/employee`). This is intentional — do not "fix" it back to admin-only.

**Why:** The product owner explicitly and repeatedly asked for officers to have
"full access to edit their personal information." `rightToWorkStatus` is a
compliance field, so making it self-editable is a deliberate data-integrity
trade-off, not an oversight.

**The guardrail that makes it acceptable:** the value is treated as
*self-attested*, NOT HR-verified. `niNumber`, `rightToWorkStatus`, and
`directDepositConsent` are in `HIGH_RISK_SELF_EDIT_FIELDS`, so any self-change
fires a same-day HR re-verification alert (push + email digest). Eligibility
gating still flows from license level, never from this free-text field.

**How to apply:**
- If asked to make compliance accuracy stronger, add a separate
  verified/pending marker (store self-reported separately from HR-verified)
  rather than removing the officer's ability to edit it.
- Any NEW self-editable field that is compliance- or money-sensitive must be
  added to `HIGH_RISK_SELF_EDIT_FIELDS` so the HR alert fires.
- License number/level/expiry remain admin-only (they drive eligibility) — keep
  them out of the `PATCH /me/employee` allow-list.
- The mobile client must only send `directDepositConsent` when it differs from
  the loaded value; sending it unconditionally turns a null→false load into a
  spurious high-risk alert.
