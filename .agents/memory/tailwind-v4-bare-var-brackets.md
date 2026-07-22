---
name: Tailwind v4 bare CSS-var brackets silently no-op
description: shadcn/Radix classes like max-h-[--radix-...] compile to invalid CSS under Tailwind v4; use parenthesis syntax (--var) instead.
---

The rule: under Tailwind v4 (this repo pins ^4.1.x), the v3 arbitrary-value shorthand with a bare custom property — `max-h-[--radix-select-content-available-height]`, `border-[--color-border]`, `h-[--cell-size]` — no longer expands to `var(...)`. It compiles to an invalid declaration (`max-height: --radix-...`) that browsers silently drop. The v4 syntax is parentheses: `max-h-(--radix-select-content-available-height)`. Explicit `[var(--x)]` forms remain valid and must NOT be converted.

**Why:** stock shadcn ui components copied before the v4 migration carried the v3 shorthand. Symptom was invisible until it mattered: the admin-portal Select dropdown (New shift → Site picker) lost its `max-height`, rendered the full site list off-screen, and Radix's internal scrolling never activated ("can't scroll the list"). Same failure class hit chart.tsx tooltip indicator colors; calendar.tsx cell sizing was latent.

**How to apply:** whenever a popup/dropdown renders unbounded, unscrollable, or an element loses a var-driven style, grep for bare-var brackets: `grep -rn -- '-\[--' artifacts/*/src lib`. Convert matches with `sed -E 's/\[(--[a-z-]+)\]/(\1)/g'` (scoped to the matched files). Any newly pasted shadcn/community component is a fresh risk — run the grep after adding one. Verify via dev-served compiled CSS: `curl localhost:80/admin-portal/src/index.css | grep 'max-height: var(--radix'` (invalid form shows the bare token without `var(`).
