---
name: Admin-portal inline/field-level feature gates
description: How to gate a single field or a section of an otherwise-ungated admin-portal page/table behind a plan feature, and why the static coverage test needed new parsers to stay meaningful.
---

## The gap

The admin portal already had two feature-gating mechanisms with static-analysis coverage in `featureGuards.test.ts`:
- Whole **route** gated via `<FeatureGuard feature="X">` in `App.tsx`.
- Whole **generic-grid table** gated via the `TABLE_FEATURE` map in `TablePage.tsx`.

Two plan features (`patrol`, `availability`) had neither, and were carried in the test's `ADMIN_ABSENT` allowlist with a comment claiming "mobile-only, no admin surface." That assumption was stale: the underlying data/actions (patrol checkpoints on a site's detail page, an employee's weekly-availability field) were always reachable admin-portal UI on pages that also contain a lot of unrelated, always-on content (Sites detail, the employees table/edit form, an officer's profile). Wrapping the *whole* route/table in `FeatureGuard`/`TABLE_FEATURE` would have hidden that unrelated content too — the wrong fix.

## The fix — two new gating primitives

1. **Field-level gate**: added `feature?: FeatureKey` to the `Field` type in `lib/tables.ts`. When set, the field is filtered out in `DataGrid.tsx` (grid columns), `RowFormDialog.tsx` (edit form), and `lib/import.ts` (`getImportableFields`) via `isFeatureEnabled(f.feature)`. Use this to hide ONE column/field in an otherwise-open table (e.g. `employees.availability`).
2. **Inline section gate**: added `FeatureLockedNote` / `FeatureSectionGuard` to `FeatureGate.tsx` — a compact dashed-border note (reusing `FEATURE_META` for the label/tier copy) to swap in for a `<section>` that shouldn't render when the feature is off, without hiding the rest of the page. Wrap the section's JSX in `isFeatureEnabled("X") ? <realSection/> : <FeatureLockedNote feature="X"/>`, and guard the section's own data-loading calls the same way so a disabled company doesn't even fire the (now backend-403'd) fetch.

**Why:** a single generic per-table or per-route mechanism can't express "hide this one card/field but keep the rest of the page," and bolting a whole-page `FeatureGuard` onto a multi-purpose page (like a site's detail view) would regress unrelated functionality.

## Keeping the coverage test honest

`featureGuards.test.ts` is a static-analysis guardrail: every `FeatureKey` must be either detected as guarded or explicitly listed as absent. Adding a new gating *mechanism* without teaching the test to detect it either false-fails (annoying) or — worse, as happened here — lets someone paper over a real gap by adding the key to the absent-list instead of building the surface.

**How to apply:** whenever you add a new UI-gating mechanism (a new field property, a new inline-check convention, a new wrapper component), add a corresponding regex/AST parser to `featureGuards.test.ts` and fold its result set into all three `guarded`/`used` unions in that file, not just the newest assertion. Treat `ADMIN_ABSENT` as something to shrink over time, not a place to file real gaps.

## Related: mobile has its own parallel surfaces, checked separately

The Expo app (`security-ops`) already gated the "Patrol" / "My availability" *nav buttons* on its own profile screen via `isEnabled(flags, "patrol"/"availability")`, unrelated to the admin-portal work above — the two apps have independent gating code paths for the same feature keys and must each be audited; one being correct doesn't imply the other is.
</content>
