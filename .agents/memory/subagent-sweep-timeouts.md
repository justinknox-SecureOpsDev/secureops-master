---
name: Async subagent sweep timeouts
description: Large mechanical multi-file sweeps can hit the subagent StartToClose timeout; how to size and recover.
---

Rule: for big mechanical sweeps (20+ call sites across many files), split the file list across 2+ parallel async subagents instead of one giant task.

**Why:** A single subagent given ~18 files of timezone fixes hit the hard StartToClose timeout (workflow status `failed: Child workflow timeout`) after finishing only part of the list. The mobile sweep of similar per-file size but fewer files completed fine.

**How to apply:**
- Keep each subagent's list to roughly 10 files of mechanical edits.
- A timed-out subagent's edits REMAIN in the working tree — don't assume all-or-nothing. Re-run the acceptance grep to compute the true remainder, then launch fresh subagents for just that remainder.
- Grep caveat when verifying: single-line greps miss multi-line calls whose `timeZone:` option sits on a continuation line — inspect flagged sites with context before re-fixing them.
