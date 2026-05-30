---
name: expo-router Tabs reuse vs nested Stack
description: Why dynamic detail/edit routes must live in a nested Stack, not flat under a Tabs layout
---

# expo-router: flat Tabs reuse screen instances

**Rule:** In expo-router (v6), a `<Tabs>` layout keeps ONE instance per route and never
remounts it once visited. Do NOT put dynamic detail/create/edit routes (`shifts/[id]`,
`shifts/edit/[id]`, etc.) as flat siblings under a Tabs `_layout`. Give each such section
its own folder with a nested `<Stack>` `_layout` (e.g. `shifts/_layout.tsx`,
`shifts/index.tsx`, `shifts/[id].tsx`, `shifts/edit/[id].tsx`). Register only the section
folder (`name="shifts"`) in the parent Tabs.

**Why:** Flat-under-Tabs caused two field bugs in the SecureOps admin app:
- Opening shift B reused the shift-A detail instance → brief flash of the wrong shift.
- The edit form's one-shot prefill guard (a boolean) persisted across the reused instance,
  so editing a second shift showed the FIRST shift's values — and saving wrote them back
  (data corruption). A Stack mounts a fresh instance per `router.push`, fixing both.
- An unregistered dynamic route under Tabs also leaks a stray entry into the tab bar; a
  nested Stack auto-includes it instead.

**How to apply:** When a tab needs drill-down screens, make it a nested Stack from the
start. `router.push("/(group)/section/[id]")` / `router.back()` resolve unchanged. Set
`headerShown:false` on both the section's Tabs.Screen and the nested Stack when screens
render their own in-screen headers. Defensive extra: prefill effects should key on the
route param (`hydratedId === id`) not a boolean, so they self-correct even if an instance
is ever reused.

**Same-named `[id]` across sibling routes in ONE Stack still bleeds params.**
Even with the nested Stack + param-keyed prefill above, the "edit opens the WRONG
shift most of the time" bug came back. Root cause: `shifts/[id]` (detail) and
`shifts/edit/[id]` (edit) both expose a dynamic segment literally named `id` in the
same Stack, so expo-router merges that param across the stacked screens and
`useLocalSearchParams` on the edit screen can read the detail screen's `id`. Fix:
give each route a DISTINCT param name — rename the edit route to
`shifts/edit/[shiftId].tsx` and read `const { shiftId: id } = useLocalSearchParams()`
(alias to keep the body unchanged). Positional path-template callers
(`.../edit/${item.id}`) need no change. Rule: never reuse a dynamic segment name
across two routes that can co-exist in the same navigator stack.

**Related:** Mobile shift eligibility must use EFFECTIVE level
`max(maxLicenseLevel, position==='support_staff' ? 1 : 0)`, not raw `maxLicenseLevel`, to
mirror the server's `getEffectiveLevel`/`positionBaselineLevel` — otherwise support /
non-licensed staff are wrongly excluded from level-1 ("Support") shifts.
