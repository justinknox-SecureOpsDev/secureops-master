---
name: Admin settings-surface auto-discovery for static checks
description: How to auto-detect "singleton config" admin pages (vs CRUD list pages) via regex scanning, and a regex pitfall that causes false negatives.
---

## Distinguishing a settings surface from a CRUD list, by convention
In this codebase, a GET-then-PUT/PATCH-to-the-same-path admin page is a genuine
"loads one stored config, saves it back" settings surface (Branding, Customer
account, Feature flags, Permissions, Legal & Agreements) — as opposed to a
CRUD list of independently-creatable records (Policies, Radio channels,
Company Owners, the Application Builder's custom questions/fields) — mainly by
two structural signals, neither of which is named anywhere in a shared
constant:
1. **Route prefix**: real settings surfaces live under `/admin/platform/*` or
   `/admin/permissions`; CRUD collections use other prefixes
   (`/admin/policies`, `/admin/radio/channels`, `/admin/company-owners`,
   `/admin/application-*`). This is the most reliable, generalizable signal —
   a new settings feature will almost always land under one of those two
   prefixes by existing convention.
2. Weaker/unreliable signals that looked promising but produced false
   positives on inspection: "no bare create POST to the same path" (true for
   Permissions/Agreements but ALSO true for the non-settings Company Owners
   toggle page and the Application Builder's per-key PATCH sub-view), and
   "GET response type is a wrapped object, not a bare array" (true for the 5
   real surfaces AND for Company Owners, so it doesn't exclude that case
   either). Company Owners and the Application Builder's field-visibility
   editor are structurally almost identical to Permissions.tsx (fixed set of
   keys, per-key PATCH, no create) — there is no clean code-shape signal that
   separates them; only the route-prefix convention does.

## Regex pitfall: don't let a "generic type param" pattern skip over unrelated parens
When scanning for `api<T>(...)` call sites with a regex that tries to also
tolerate function-type generics like `<(x: number) => void>` (by allowing one
level of nested parens inside `<...>`), the "nested parens" sub-pattern can
run away and match across an entire unrelated function body if that body
contains any `(...)` before the next `>`. E.g. `api<{ permission: X }>(` was
mis-parsed as extending all the way to a `>(` several lines later inside
`qc.setQueryData<PermsResponse>(`, silently swallowing the real call (and any
`method:` inside it) into "argument text" that was actually a different
statement — a false negative that only surfaces as "this known call site
mysteriously isn't discovered," not a crash. Fix: keep the generic-type
character class free of parens entirely (`<[^>()]*>`) unless a real call site
in this codebase actually needs a paren inside its type param — none do here.
Lesson applies to any future regex-based static-analysis test in this repo
that walks `api<T>(...)`/similar call sites.
