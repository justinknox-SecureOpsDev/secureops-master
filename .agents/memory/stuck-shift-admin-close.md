---
name: Stuck open shift admin-close surface
description: Design constraints for any manual "this open shift/time-entry looks stuck" admin flag, alongside an automatic sweep job that already closes most of them.
---

When a DB-level "one open record per officer" invariant exists, a genuinely stuck record (crash, forgotten clock-out, automation disabled, stale-looking live state) permanently blocks that officer until someone closes it — so a manual admin escape hatch needs its own care even when an automatic sweep already exists.

Two coexistence rules for a manual "stuck" flag layered next to an automatic sweep job:

1. **Derive the threshold from the sweep job's own effective policy, never a hand-picked constant.** If the automated closer's wait is itself configurable (e.g. per-site/company, with a disable option), a fixed manual threshold can be shorter than some configuration's legitimate window — flagging, and letting an admin one-click truncate, a record that policy hasn't actually abandoned yet. Only fall back to a flat constant for configurations where the automated sweep never runs at all (e.g. explicitly disabled).

2. **Resolve any per-entity policy lookup (e.g. which site's settings apply) with the EXACT same precedence the automated job uses**, not a different-but-plausible one (e.g. "shift's site" vs "record's own site"). The two usually agree, but a mismatched/legacy record can diverge, and getting it backwards makes the manual flag key off a different policy than the job that actually governs the record.

**Why:** a manual close action is destructive and typically one-click; false positives (or the wrong policy) mean an admin can prematurely truncate a record that's still legitimately open, silently shorting the underlying data (e.g. pay).

**How to apply:** if the sweep job's policy resolution changes (new inputs, different precedence, a new cap), the manual flag's threshold and site-resolution must be re-derived from the same source, not hand-tuned separately. Prefer reusing the sweep job's own exported resolver function over reimplementing its logic.

A third consumer (an automated admin-alert scheduled job paging admins when an entry crosses the same "stuck" threshold) reused this by extracting the shared decision function out of the route file into its own module, which both the route and scheduledJobs.ts import — rather than duplicating it a second time or leaving it owned by the route. That created a real import cycle (the shared module needs a couple of constants/resolvers that still live in scheduledJobs.ts, which now imports the shared module back). This is safe in this codebase's ESM setup as long as every cross-reference is used only *inside a function body* (deferred to call time), never read at a module's top level during initial evaluation — confirmed via `tsc --noEmit` and the full test run. Don't avoid a warranted extraction out of fear of the cycle; just keep top-level code in each module free of the other's bindings.
