---
name: a11y/validation self-starts its own api-server
description: Why mass-restarting workflows causes api-server EADDRINUSE on 8080, and the safe way to restart.
---

The `a11y` (and other self-bootstrapping validation) workflow checks whether an api-server is already running on 8080 and, if not, **starts its own** as a prerequisite for its scan.

**Why it bites:** restarting *all* workflows at once (e.g. after adding a secret) races the dedicated `artifacts/api-server: API Server` workflow against the a11y-spawned one. Whichever binds 8080 first wins; the other dies with `listen EADDRINUSE 0.0.0.0:8080`. The dedicated workflow then shows FAILED even though an api-server is actually serving (the a11y one).

**How to apply:**
- Only restart the *specific* workflow you need — adding a secret does NOT require restarting every workflow; restart just `artifacts/api-server: API Server` (and the consuming web/expo workflow if relevant).
- If api-server is already FAILED with EADDRINUSE after a mass restart: let the a11y/validation workflows finish (they free 8080 on exit), then restart `artifacts/api-server: API Server` alone.
- Confirm health with `curl localhost:8080/api/brand` (expect 200), not by tailing a rotated/stale log file (the timestamped log path changes per restart, so an old path still shows the prior failure).
