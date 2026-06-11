---
name: Dev/test email suppression
description: Outbound email only actually sends in production; dev/test are suppressed to avoid flooding real inboxes.
---

# Dev/test email suppression

The Replit dev workspace (and the test runner) have live SMTP credentials, so before
this gate every server restart, scheduled job, seed/backfill, or exercised code path
sent REAL mail to the real WCSG admin/HR inboxes — flooding them whenever the agent
worked.

**Rule:** all outbound mail funnels through `sendEmailDetailed` in
`artifacts/api-server/src/lib/email.ts`. That single chokepoint short-circuits unless
`NODE_ENV === "production"` (escape hatch: `EMAIL_DEV_SEND=true`). Suppressed sends log
an info line and return `{ status: "suppressed", ok: true }`.

**Why `ok:true` but a distinct `"suppressed"` status (not `"sent"`):** the two are
decoupled on purpose. `ok:true` is required because the scheduled reminder jobs
(`lib/scheduledJobs.ts`) roll back their atomic UPDATE…RETURNING claim and retry every
tick when `sendEmail` returns false — returning `ok:false` for a suppressed send would
make every reminder churn forever in dev. But the *status* must NOT be `"sent"`, or
callers that persist delivery state (e.g. `applications.ts` writes
`onboardingEmailStatus`/`onboardingEmailSentAt`) would record dev mail as actually
delivered. `"suppressed"` keeps the persisted record honest while avoiding the churn.
Status branches only special-case `"bounced"`/`"failed"`, so `"suppressed"` flows
through the success path without setting an error.

**Why:** dev must never deliver live mail to production recipients. The repo also has no
separate sandbox SMTP — the dev secrets ARE the production mail account.

**How to apply:**
- Never add a new mail transport that bypasses `sendEmailDetailed`; keep the single
  chokepoint so the gate stays effective.
- Tests run with `NODE_ENV=test`, so they're suppressed too (no test asserts the
  `emailSent` response field, so returning ok:true is safe). If you ever need to test the
  real pipeline locally, set `EMAIL_DEV_SEND=true` for that run only.
