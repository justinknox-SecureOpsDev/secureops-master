---
name: axe parent-opacity contrast trap
description: Why Tailwind opacity-* on a container makes axe-core flag color-contrast, and how to fix it
---

# Parent `opacity-*` dims descendants and trips axe color-contrast

A Tailwind `opacity-40` / `opacity-60` utility on a *container* element multiplies the
alpha of every descendant. axe-core's color-contrast check reports the **blended**
foreground/background (e.g. amber-400 text inside an `opacity-60` div computes as
`#9c7409` on navy, ~4.04:1 → fails 4.5:1). You **cannot** undo this on the child —
CSS `opacity` compounds; a child `opacity-100` does not restore full contrast.

**Why:** the admin-portal a11y gate (`scripts/src/a11y-admin-portal.ts`) gates on
critical/serious WCAG violations. Two shared `AppShell.tsx` elements caused contrast
fails across many authenticated pages: the dev-only "DEV" badge (dimmed by its parent
subtitle `opacity-60`) and the sidebar footer (`opacity-40` muted text).

**How to apply:** move the `opacity-*` onto the specific leaf text node that should be
muted (e.g. a sibling `<span className="opacity-60">label</span>`), leaving
high-contrast siblings (badges) at full opacity. For muted-but-readable text, `opacity-40`
on a light-on-dark string is ~3.4:1; `opacity-60` clears 4.5:1. Prefer adjusting opacity
or using a known-contrast color over leaving it on the container.

Process note: the a11y gate reuses already-running dev servers (Vite HMR picks up edits,
no restart needed), but `/tmp/logs/*` only refreshes via `refreshAllLogs` — after
re-running the gate, call it to read the *fresh* result instead of a stale log file.
