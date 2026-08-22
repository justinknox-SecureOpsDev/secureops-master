---
name: admin-portal timing-sensitive test flakes under load
description: deepLinkFocus.test.tsx and similar animation/timing admin-portal specs fail under heavy parallel load but pass in isolation
---

`artifacts/admin-portal/src/pages/__tests__/deepLinkFocus.test.tsx` asserts a
transient animation class is applied to a row inside `waitFor`. Under heavy
parallel jsdom load it can fail because the class has already been swapped back
to the resting `className` by the time the assertion samples it.

**Why:** the flash class is present for a short window. Parallel jsdom load
starves that window, and the same load pushes slower form specs (Apply wizard,
row form dialog, settings pages) past the default 5000ms `testTimeout`. The
tell is non-determinism: the set of failing files varies run to run on an
unchanged tree. A real break fails the same test every time.

**How to apply:** if admin-portal failures are confined to animation/timing
specs or show as `Test timed out in 5000ms` with `act(...)` warnings, and you
did not touch admin-portal source, re-run the affected file alone. Green in
isolation, plus a varying failure set across runs, identifies contention rather
than a regression — investigate the load, not the test. Same family as the
api-server WS-broadcast and clock-in nearest-site full-suite flakes.

Do not "fix" this by shrinking your own test file: adding one more spec
lengthens the tail, it does not raise peak worker concurrency, so a suite that
passes at N files was not tipped over by your N+1th.
