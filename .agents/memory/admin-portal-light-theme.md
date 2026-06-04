---
name: admin-portal light theme tokens
description: The admin-portal renders on a LIGHT surface via shadcn theme tokens; hardcoded dark classes render invisible text.
---

The admin-portal (`artifacts/admin-portal`) renders on a **light** background using
shadcn/Tailwind theme tokens: `bg-background`, `bg-card`, `text-foreground`,
`text-muted-foreground`, `border-border`, `bg-muted`. See `pages/AuditLog.tsx` /
`pages/AppShell.tsx` for the canonical pattern.

**Rule:** Build new admin-portal pages with these tokens. Never hardcode dark-mode
classes (`text-white`, `text-white/60`, `bg-white/5`, `border-white/10`) or dark
color boxes (`bg-amber-900/30 text-amber-300`). On the light surface white text is
invisible. Use light semantic variants instead: `bg-amber-50/text-amber-900`,
`bg-red-50/text-red-700`, `text-green-700`. `brand-gold` / `brand-navy` are fine.

**Why:** The Scheduler Integration page shipped with a full set of dark-theme classes
and was completely unreadable in production until rewritten to theme tokens.

**How to apply:** When scaffolding or reviewing any admin-portal page, scan for
`text-white` / `bg-white/` / `*-900/30` and convert to theme tokens before shipping.
