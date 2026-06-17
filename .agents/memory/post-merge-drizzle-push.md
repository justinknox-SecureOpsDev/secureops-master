---
name: Post-merge script must use non-interactive drizzle push
description: Why post-merge.sh hangs/times out on drizzle-kit push, and the unique-index-vs-constraint phantom diff that makes the prompt recur
---

# Post-merge setup + drizzle-kit push

**Rule 1 — post-merge.sh must push non-interactively.** The platform runs
`scripts/post-merge.sh` after every task merge with **stdin closed (`/dev/null`)** and a
timeout. Plain `drizzle-kit push` becomes interactive whenever it has a data-loss-risk
statement (e.g. adding a unique constraint to a table that already has rows: "Do you want
to truncate …? ❯ No / Yes"). With stdin closed it just hangs until the timeout → setup
fails. Use the force variant: `pnpm --filter @workspace/db run push-force`
(`drizzle-kit push --force`). Also use the real package name `@workspace/db`, not a loose
`--filter db`.

**Why:** seen live — post-merge timed out at 20 s on the `site_rates_site_level_label_uniq`
truncate prompt. `--force` answers prompts non-interactively (picks the non-destructive
"add without truncating" default — it does NOT truncate; verified rows survived).

**Rule 2 — a drizzle `unique()` backed in the DB by a standalone UNIQUE INDEX (not a
constraint) makes push re-emit the "add unique constraint / truncate?" prompt on EVERY
run, forever.** drizzle reads `pg_constraint` for unique constraints; a bare
`CREATE UNIQUE INDEX <name>` satisfies uniqueness but is invisible there, so drizzle thinks
the constraint is still missing and tries to add it each push (harmless under `--force`,
but noisy and masks genuine future drift). `schema-drift` won't catch it either — it
deliberately does NOT treat `.unique()` as a named-index requirement.

**Fix (non-destructive, no rebuild, no data scan):** promote the existing index into a
constraint of the same name:
`ALTER TABLE <t> ADD CONSTRAINT <name> UNIQUE USING INDEX <name>;`
After that, `push-force` is a clean no-op ("[✓] Changes applied", no prompt).

**How to apply:** if a post-merge / `db push` log keeps printing a truncate prompt for a
unique constraint that "should already exist", check `pg_constraint` vs `pg_indexes` for
that name — if it's an index but not a constraint, promote it with `USING INDEX`.
