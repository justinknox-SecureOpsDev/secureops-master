---
name: admin-portal deepLinkFocus full-suite flake
description: deepLinkFocus.test.tsx (and other animation/timing-class admin-portal tests) flake under the full parallel admin-portal vitest run but pass in isolation
---

`artifacts/admin-portal/src/pages/__tests__/deepLinkFocus.test.tsx` asserts a
transient animation class (e.g. `wcsg-deep-link-flash`) is applied to a row
inside `waitFor`. Under the full `vitest run` (jsdom, all admin-portal specs in
parallel) it can fail because the class has already been swapped back to the
resting `className` by the time the assertion samples it — a timing race, not a
regression.

**Why:** Heavy parallel jsdom load (environment setup ~180s in the full run)
starves the short window in which the flash class is present. Run alone it passes
deterministically.

**How to apply:** If the only admin-portal test failures are in
deepLinkFocus.test.tsx (or similar animation/timing-class specs) and you didn't
touch admin-portal source, re-run that file in isolation
(`npx vitest run src/pages/__tests__/deepLinkFocus.test.tsx`) to confirm. Green
in isolation = pre-existing flake, safe to ignore for unrelated changes. Same
family as the api-server WS-broadcast and clock-in nearest-site full-suite flakes.

**Bigger trigger — the mark_task_complete validation gate.** That gate runs ALL
named checks in parallel (a11y spins up its OWN api-server + admin-portal) while
every dev workflow is still up, so the admin-portal vitest project's `environment`
setup balloons (~240s) and Apply-wizard / form specs blow the default 5000ms
`testTimeout`. Symptom: a VARYING set of admin-portal form tests "fails"
(applyServerErrorRouting, applySaveDraft, applyConfigurableFields,
standardFieldsManager, rowFormDialog, deepLinkFocus) with `Test timed out in
5000ms`, flooded by `act(...)` warnings. The count shrinks run-to-run as load
drops (saw 7 → 1) — that non-determinism IS the proof it's contention, not a
break. Confirm by running the named file(s) alone (passes, environment ~10s),
then mark complete with `skip_validation_reason` (flaky/environment-blocked) when
your change didn't touch admin-portal. The standalone `test` *workflow* (not the
gate) usually shows 78/78 green.
