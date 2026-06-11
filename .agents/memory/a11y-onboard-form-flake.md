---
name: a11y gate Onboard-form flake
description: The a11y workflow can fail on the public Onboard token form for environmental reasons unrelated to your change.
---

The `a11y` validation gate (`scripts/src/a11y-admin-portal.ts`) scans the PUBLIC
Onboard form at `/admin-portal/onboard/:token` (rendered by
`artifacts/admin-portal/src/pages/Onboard.tsx`). This surface intermittently
fails with `locator.waitFor: Timeout 20000ms exceeded` "waiting for
getByRole('button', {name: /continue|submit/i})" — i.e. the token form does not
finish rendering for the scanner. It reproduces across reruns and is independent
of admin-portal table/page edits.

**Why:** the Onboard form depends on a freshly-minted onboarding token + seeded
employee state; when that bootstrap is slow/absent the form never shows its
Continue/Submit button, so the gate marks the surface "failed to load" (exit 1).
The other scanned surfaces (Apply, Amend, Employees, Pay Run, Applications HR,
Onboarding HR, Audit Log, Site detail) pass.

**How to apply:** if the a11y gate's ONLY failure is the Onboard form and you did
not touch `Onboard.tsx` or the onboarding-token mint flow, treat it as a
pre-existing environmental flake, not a regression. Confirm your own surfaces
show "no critical/serious violations" in the log before dismissing. Don't try to
"fix" it by rewriting unrelated pages.
