---
name: Permission demo video export
description: How artifacts/permission-video produces Google Play permission demo MP4s (Chromium frame-capture + ffmpeg) and how to run/screenshot/export it.
---

`artifacts/permission-video` is a throwaway Vite artifact that renders animated phone-mockup demo videos for Google Play foreground-service / background-location permission declarations. Videos are selected by URL query param: `/permission-video/?v=media`, `?v=mic`, default = location. Each uses `useVideoPlayer({ durations })` which loops scenes and calls `window.startRecording/stopRecording` (Replit pipeline hooks).

**Export to MP4 without the Replit recording pipeline:** `scripts/capture-video.mjs` uses `puppeteer-core` + the system Chromium (glob `/nix/store/*-chromium-*/bin/chromium`) to screenshot the running page at 30fps for a fixed duration, then `ffmpeg` (`libx264 -crf 18 -pix_fmt yuv420p -movflags +faststart`) encodes the frames. Args: `--url --dur=<ms> --out`.

**Gotchas:**
- A ~21s capture takes ~4-5 min. Run ONE video per ShellExec call — two sequential captures blow the 5-min shell timeout.
- The artifact's dev workflow is NOT auto-listed in `.replit` (only managed artifacts are). To run/screenshot/export it, register a workflow via `verifyAndReplaceDotReplit` (`PORT=8082 BASE_PATH=/permission-video/ pnpm --filter @workspace/permission-video run dev`; port 8082 is already a registered [[ports]] entry).
- Verify scenes from the finished MP4 with `ffmpeg -i in.mp4 -ss <t> -frames:v 1 out.png` — put `-ss` AFTER `-i` for accurate seek; before `-i` it snaps to sparse keyframes and lands on the wrong scene.
- Deliver via `presentAsset`; user uploads to YouTube (unlisted) and pastes the URL into the matching Play Console field.
