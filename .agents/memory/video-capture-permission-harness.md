---
name: In-repo video capture (permission-video harness)
description: How this repl builds & exports shareable videos, the virtual-clock capture technique, and the determinism rules scenes must follow.
---

# In-repo video capture

This project builds shareable videos **in-repo** — there is no dedicated video
artifact because `createArtifact` is locked to `mockup-sandbox`. Scenes render in
the `permission-video` Vite app behind `?v=` route variants (e.g. `?v=training`,
`?v=media`, `?v=mic`); a Node script screenshots the running page frame-by-frame
and encodes with ffmpeg.

## Exporter: scripts/capture-video-vt.mjs (deterministic)
Injects a **virtual JS clock** into the page (`page.evaluateOnNewDocument`,
before app code) that overrides `requestAnimationFrame`/`cancelAnimationFrame`,
`performance.now`, `Date.now`, and `setTimeout`/`setInterval`/clear*. It steps
the clock exactly `1000/FPS` per frame (`window.__advance`), takes a NORMAL
`page.screenshot`, and encodes JPEG frames with libx264. Because it is
deterministic, a long render can be chunked across processes via `--from/--count`
(fast-forwards the clock with no screenshots to reach `--from`) and `--encode=0|1`.

**Why not CDP virtual time (`Emulation.setVirtualTimePolicy`)?**
In new-headless Chromium 138, `Page.captureScreenshot` **deadlocks after the 2nd
`advance`** — the compositor won't produce a frame while the virtual clock is
paused (only the first capture ever succeeds). It is renderer-level: a separate
CDP session for captures does NOT help. Normal screenshots work reliably and
repeatedly, so control *animation* time in JS instead of browser time.

## Rules when authoring scenes or the exporter
- **Scenes must animate via framer-motion / rAF, NEVER CSS animations or
  transitions** (`animate-pulse`, `transition-colors`, `duration-*`, etc.). CSS
  runs on the *real* compositor clock, not the injected clock, so it plays at the
  wrong speed in the export (screenshots take ~66ms real per 33ms virtual frame)
  and breaks chunked reproducibility. framer-motion `transition=` PROPS are fine
  (they are rAF-driven).
- **React flush:** React's scheduler uses `MessageChannel`, not `setTimeout`, so
  faking timers does not stall it. After each `__advance`, yield ONE real
  macrotask via `MessageChannel` (`window.__flush`) so scene-change re-renders
  paint before the screenshot.
- **Readiness gate must poll from Node** (real timers) for
  `window.__replitVideoPlayerMounted` — `page.waitForFunction` polls with
  rAF/setTimeout, which are faked in-page and never fire.
- Scene timing lives in `lib/video/hooks.ts` (`useVideoPlayer` scene durations +
  `useSceneTimer`), all `setTimeout`-based → driven by the injected clock.

**Why:** solved 2026-07 while exporting the officer training video
(`?v=training`, ~41s, 1230 frames). Under-load real-time screenshotting sped the
output ~13×; CDP virtual time deadlocked on the 2nd frame; the injected-clock
approach renders the full video in ~90s at correct speed and is byte-reproducible.
