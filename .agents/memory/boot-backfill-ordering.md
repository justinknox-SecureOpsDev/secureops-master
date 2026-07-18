---
name: Boot backfill ordering
description: api-server boot backfills are fire-and-forget; a backfill that reads another's output must be chained, not added as a sibling.
---

The api-server boot (`artifacts/api-server/src/index.ts`) kicks off several
one-time backfills as **independent fire-and-forget promise chains** (each its own
`.then/.catch`). They are NOT sequenced relative to each other.

**Why it matters:** some backfills produce data others consume. Example:
`backfillEmployeeProfileFields` copies `onboarding_submissions.acknowledgements`
onto the `employees` row (COALESCE). A later backfill that *reads*
`employees.acknowledgements` to decide a flag (e.g. must-sign-policies) will
mis-judge legacy rows if it runs before that copy finishes.

**How to apply:** a new boot backfill that depends on another backfill's output
must `Promise.all([...prereqDonePromises]).then(() => run())`, not just be appended
as another sibling. Capture the prerequisite chains in consts (their `.catch`
already swallows errors so `Promise.all` resolves even if a prereq fails — which is
the desired "still run, just logged" behavior). Live writes that populate the same
column at request time (e.g. onboarding completion writing acks straight to the
employees row) make the race legacy-rows-only, but the ordering fix is still the
clean guarantee.
