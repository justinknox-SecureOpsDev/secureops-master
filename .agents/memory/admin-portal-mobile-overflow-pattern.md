---
name: Admin portal mobile overflow pattern
description: Conventions for making admin-portal tables/dialogs usable on mobile browsers without tripping the a11y gate.
---

Rules for mobile-usable admin-portal surfaces:

- **Wide tables**: never leave a raw `<table>` inside an `overflow-hidden` card — actions at the right edge become unreachable on phones. Wrap in `<div className="overflow-x-auto" tabIndex={0} role="region" aria-label="…">`. The tabIndex/role/aria-label trio is required or the axe gate fails `scrollable-region-focusable`. Nested tables inside a `<td>` do NOT need their own wrapper (the outer scroll container suffices).
- **Dialogs**: base `ui/dialog.tsx` DialogContent already ships `w-[calc(100%-1.5rem)] max-h-[calc(100dvh-2rem)] overflow-y-auto`. Do not re-add `max-h-[90vh] overflow-y-auto` overrides per dialog — they fight the base (tailwind-merge keeps the override, losing the dvh-safe base). Only pass width overrides like `max-w-2xl`.
- **Dialog form grids**: `grid grid-cols-2` truncates Select values (site names) on phones — use `grid-cols-1 sm:grid-cols-2`. Watch for `col-span-2` children: on a 1-col grid they create an implicit overflow column, so either leave such grids alone (they're already effectively 1-col) or make spans responsive too.
- **App shell**: root uses `h-dvh` (not `h-screen` — mobile URL bar clips it); `<main>` uses `overflow-auto` so both axes scroll.

**Why:** July 2026 mobile-browser bug report: portal unscrollable, ShiftDialog site names cut off, LicenseRenewals Approve/Reject unreachable — all traced to these three patterns.

**How to apply:** any new admin-portal table card, dialog, or two-column form grid must follow these defaults; check at ~390px width.
