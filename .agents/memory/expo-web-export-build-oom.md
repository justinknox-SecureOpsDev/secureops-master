---
name: Expo web export OOMs the cloud build
description: Why the production publish build intermittently fails during the security-ops Expo web export, and the fix.
---

# Expo web export OOM-kills the cloud build machine

The production deployment is an **application-router** deployment (`.replit` `[deployment] router = "application"`, `deploymentTarget = "cloudrun"`) that builds and serves all three artifacts via path routing: `security-ops` (Expo web) at `/`, `admin-portal` (Vite static) at `/admin-portal/`, `api-server` at `/api`. So the publish runs **every** artifact's `build` script, including the heavy `expo export --platform web` (Metro bundle).

**Symptom:** publish fails intermittently (success/failure interleaved across attempts) during the Expo step. Build log dies mid-Metro-bundle (e.g. ~81% of modules) and the next line is `Security scan skipped: connection lost`. It is *not* a timeout (failures hit ~90s in) and *not* a compile error (api-server + admin-portal build fine, and all three build locally). It is an **OS-level OOM kill** on the small `cr-2-4` (2 vCPU / 4 GB) build machine.

**Why:** Metro defaults its transform-worker count to the build **host's** reported CPU count, not the 2-vCPU allocation, so it over-spawns worker processes whose combined heaps exceed 4 GB. It got worse as the mobile app grew (more modules to bundle pushed it over the edge).

**Fix:** pin Metro workers in `artifacts/security-ops/package.json` `build` script: `expo export --platform web --output-dir web-dist --max-workers 2`. (Source maps are already off — `expo export` only emits them with `-s/--source-maps`.) Do **not** raise `--max-old-space-size` here: the kill is OS/cgroup-level, so giving Node *more* heap makes it worse; the lever is fewer workers / less peak memory.

**Also note (separate concern):** `replit.md` requires this app to run on **Reserved VM**, not autoscale/cloudrun (stateful in-process WS registry + scheduled jobs with a boot mutex). The live deployment is on `cloud_run` — a correctness mismatch worth flagging to the user, independent of the build OOM.
