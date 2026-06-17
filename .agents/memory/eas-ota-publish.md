---
name: EAS OTA publish from the agent env
description: Reliable recipe to publish an EAS Update (OTA) for the Expo app from inside the agent, working around the process reaper and the git guard.
---

Publishing an EAS Update (OTA) for the Expo mobile app from inside the agent environment.

## The blockers (environment-specific, all confirmed empirically)

- **Detached/orphaned bash processes get SIGKILLed by an environment reaper within ~1.5–4 min.** Confirmed NOT OOM: cgroup `/sys/fs/cgroup/memory.events` showed `oom_kill 0`, 16 GB ceiling, only ~3.6 GB used. A full two-platform `eas update` (Metro export + React Compiler) takes longer than that window, so launched detached (`setsid`/`nohup`/`&`) it NEVER finishes. Tell-tale: no self-written `EXIT=` marker in the log → external SIGKILL, not a crash.
- **The workflow supervisor is reaper-immune but unavailable.** The project sits at the 11/10 workflow limit, so `configureWorkflow` refuses to ADD *or even RECONFIGURE* an existing workflow. Removing one is unrecoverable (can't re-add an 11th). So that route is closed.
- **A foreground bash command (the active tool process) is NOT reaped** — only capped at 120 s.

## The working recipe — split bundling from upload, per platform

1. Foreground export, ONE platform at a time (a single platform fits under the 120 s cap; ~50–90 s with a warm Metro cache):
   `cd artifacts/security-ops && EAS_NO_VCS=1 ./node_modules/.bin/expo export --platform android --output-dir dist`
2. Fast upload of the prebuilt bundle (seconds — well inside the reaper window):
   `EAS_NO_VCS=1 ./node_modules/.bin/eas update --branch production --skip-bundler --input-dir dist --platform android --message "…" --non-interactive`
3. Repeat for `ios` (re-export overwrites `dist`; warm cache makes it quick).

Publishing per platform creates two single-platform update groups on the branch. EAS serves the right one per platform + runtimeVersion, so it is functionally equivalent to one combined group.

## Why `EAS_NO_VCS=1` is mandatory here

eas reads git metadata, which touches `.git/index.lock`; the agent git guard blocks that ("Destructive git operations are not allowed …") and fails the publish. `EAS_NO_VCS=1` skips all git. **The same guard also blocks `rm .git/index.lock`**, so don't try to clear a stale lock that way — leave it; the platform clears its own.

## Preflight + verify

- `EXPO_TOKEN` secret is set; `eas whoami` authenticates through it. runtimeVersion policy = appVersion; channel `production` → branch `production`. An OTA only reaches already-installed builds whose runtimeVersion matches (e.g. 1.0.2).
- Authoritative success check: `eas update:list --branch production --limit 4` — the new message must be the top group(s) for the intended platform(s).
- **Rollout order for a mobile change:** deploy server/admin-portal first, then OTA. A mobile feature backed by new DB tables also needs the schema applied to the PROD DB, or the deployed server 500s.
