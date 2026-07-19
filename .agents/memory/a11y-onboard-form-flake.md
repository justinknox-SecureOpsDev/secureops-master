---
name: a11y gate public-form load flake
description: The a11y workflow can fail on public form surfaces (Onboard/Apply) for environmental load reasons unrelated to your change; also the spinner-only-button state-dependent axe trap.
---

The `a11y` validation gate (`scripts/src/a11y-admin-portal.ts`) scans public
form surfaces (`/admin-portal/onboard/:token`, `/admin-portal/apply`). Any of
them can intermittently fail with `locator.waitFor: Timeout 20000ms exceeded`
("could not render for scanning") — the page never finishes rendering for the
scanner. Observed on the Onboard form repeatedly, and on the Apply form when
the release-validation harness runs a11y concurrently with the test/typecheck/
front-door gates (heavy CPU/DB contention slows first paint past the 20s
waitFor). Flips between surfaces across reruns; independent of unrelated edits.

**Why:** these surfaces depend on live bootstrap (token mint, seeded state,
API responses) before their heading/button appears; under load or slow
bootstrap the scanner marks the surface "failed to load" (exit 1).

**How to apply:** if the a11y gate's ONLY failure is a "could not render for
scanning" timeout on a page you did not touch — and the same surface passed in
a recent run of the same code — treat it as an environmental flake, not a
regression. Confirm your own surfaces show "no critical/serious violations"
before dismissing. Don't "fix" it by rewriting unrelated pages.

**Related state-dependent trap (real bug, looks like a flake):** buttons that
swap their text for a spinner while loading (`{loading ? <Loader2/> :
"Refresh"}`) have NO accessible name mid-load; axe flags `button-name`
(critical) only when the scan catches the loading state — so the violation
appears/disappears across runs. Fix by adding a permanent `aria-label` to any
button whose visible text is conditionally replaced by an icon.
