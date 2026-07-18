---
name: Replit agent bash — background processes don't persist
description: setsid/nohup/& processes are killed when the bash tool call returns; long ops must be polled across turns, not run as a local daemon.
---

In the Replit main-agent bash tool, any process you background (`&`, `setsid`, `nohup`, `disown`) is killed when that single bash call returns — the tool tears down the process group. A backgrounded process only runs for the lifetime of the bash call that launched it (≤120s cap).

**How to apply:** For work longer than ~110s, either (a) finish it inside one call within the 120s cap, or (b) if it runs on a REMOTE service (EAS build/submit, deploy, hosted CI), kick it off, let the remote complete on its own, and poll its status in later turns — never depend on a local watcher/daemon surviving between turns. `/tmp` is also not guaranteed to persist between turns, so re-materialize any scratch files each turn.

**Why:** a ~30-min EAS auto-submit watcher (setsid, poll-loop) logged its first line then silently died the moment the parent bash call returned, wasting a cycle. Polling `eas build:view` across turns + a one-shot `eas submit --no-wait` once the remote build was FINISHED worked cleanly.
