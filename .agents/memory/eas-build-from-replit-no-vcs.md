---
name: EAS build from Replit uses EAS_NO_VCS
description: Why EAS builds/submits kicked off from Replit must set EAS_NO_VCS=1 (archive working dir, not git HEAD)
---

# EAS builds from Replit must archive the working directory

Always `export EAS_NO_VCS=1` before `eas build` / `eas submit` from the Replit workspace (both iOS and Android).

**Why:** On Replit the fix you just made usually lives only in the working directory — git HEAD lags behind and checkpoints are NOT git commits. EAS's default VCS mode archives **git HEAD**, so an uncommitted change (e.g. an `app.json` permission/manifest fix) is silently left out and you rebuild the exact code you were trying to fix — a policy-rejection resubmit would ship the rejected bits again with no error.

`EAS_NO_VCS=1` makes EAS tar the working directory instead (still respecting `.easignore`/`.gitignore`), so the current on-disk source is what's built. EAS prints "Using EAS CLI without version control system is not recommended" — that warning is expected and fine here.

**How to apply:** Before spending a ~15–25 min build, grep the working-dir source to confirm the fix is actually present. Build with `EAS_NO_VCS=1 eas build --platform <p> --profile production --non-interactive --no-wait`, then poll `eas build:view <id>` across turns (builds run on Expo's servers; a local shell can't block that long, and background procs don't survive a ShellExec return — use `sleep` inside one call, or poll in separate turns). The `eas` CLI is a project devDependency (`node_modules/.bin/eas`), so it's on PATH even though eas-cli was pulled from `.replit [nix]`. Auth is non-interactive via `EXPO_TOKEN`. Android production reuses the remote keystore and autoIncrements versionCode from the remote version source with no prompts. The durable AAB link is the `expo.dev/artifacts/...` URL (re-signs per request); the raw `eascdn`/S3 URL it redirects to expires in ~15 min.
