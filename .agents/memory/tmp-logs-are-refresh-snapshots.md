---
name: /tmp/logs are refresh_all_logs snapshots
description: Why ls -t on /tmp/logs shows stale workflow results after a restart
---

`/tmp/logs/*.log` files are point-in-time snapshots written by the `refresh_all_logs` tool, NOT live workflow output. Restarting a workflow (e.g. `test`) does not update these files on its own.

**Why:** After `restart_workflow("test")`, `ls -t /tmp/logs/test_*` kept returning the same stale file (an old FAILED run) for many minutes, even though the workflow had re-run and passed. The header (`<status>FAILED</status>`, `run_id`, `timestamp`) is frozen at the moment of the last snapshot.

**How to apply:** After restarting any workflow, call `refresh_all_logs` to get the current result before reading `/tmp/logs`. Do not trust `ls -t` mtime/content on `/tmp/logs` as the latest run — it only reflects the last `refresh_all_logs` call.
