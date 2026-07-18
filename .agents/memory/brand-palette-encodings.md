---
name: Brand palette encodings & source-of-truth files
description: Where the WCSG/SecureOps brand colors live and why a palette change must touch every encoding + derived shade, not just the three base values.
---

# Brand palette: encodings & source-of-truth

The brand colors (navy / gold / cream — identifiers stay these names per
replit.md even when values are warm-black/gold) are encoded in THREE forms
across several source-of-truth files. A "change the brand color" task must
update ALL forms AND the derived shades, or surfaces drift / stay off-hue.

**Why:** a color swap that only replaces the base hex leaves HSL token
tuples, rgba() glows, and derived navy-2/-3 / card / border shades on the
OLD hue — screens keep reading as the old color even though the "main" color
changed. An architect review caught exactly this after a first pass.

**Taste history (WHY the current values):** current accent is a RICH metallic
gold `#c9a04a` (hue ~41°, sat ~54%) with champagne `#f0d89a` + deep `#aa8036`,
matched to the WCSG eagle-logo metal. Two earlier directions were rejected: (a)
a neon/gaudy ORANGE bronze (hue <35°, too saturated), then over-correcting to
(b) a DESATURATED "muted bronze" `#b1834e` (hue 32°) that read FLAT / PLAIN /
muddy. Landing spot: keep it clearly GOLD (hue 40-43°, NOT orange), keep it
SATURATED/bright (not muted), get "shine" from 3-stop gradients (champagne→gold
→deep) + inset highlight + a golden glow — deep-black-vs-bright-gold contrast is
a FEATURE, don't soften it. When the user says "flat/plain," add saturation +
gradient depth, not more brown.

**Encodings & files (how to apply — grep all three):**
1. Raw hex literals — spread across ~40 TS/TSX/CSS/HTML files. Notable
   defaults: `api-server/src/lib/brandConfig.ts` ENV_BRAND (feeds PDFs,
   emails, CSS vars), `admin-portal/src/lib/brand.ts` + `home/src/lib/brand.ts`
   defaults, `security-ops/constants/colors.ts` (mobile palette, incl.
   EXPO_PUBLIC_BRAND_* fallbacks).
2. HSL token tuples — `admin-portal/src/index.css` shadcn tokens + `--brand-*`.
   These are `hsl(...)` values here (NOT bare tuples), e.g. `--brand-gold:
   hsl(41 54% 54%)` (= `#c9a04a`) and `--brand-gold-ink: hsl(41 54% 27%)`
   (darker gold for gold text on light bg, AA ~7.4:1 on white).
3. rgba() triples — `home/src/index.css` glows/overlays, admin `Login.tsx`,
   `SiteDetailPage.tsx`. Same color as a decimal RGB triple, e.g. gold =
   `201, 160, 74`.

**Derived shades to warm too (not just the 3 bases):** home `--apex-navy-2/3`,
mobile `card/secondary/muted/input/border/mutedForeground`, admin remaining
`224°` foreground/border/sidebar HSL. Preserve LIGHTNESS when shifting hue so
axe contrast stays AA. EXCEPTION: admin `--chart-2` (a blue) is an intentional
categorical chart hue — leave it; charts want varied hues (gold/blue/orange/
green/purple), not brand-matched.

**Runtime override caveat:** a live `platform_brand_config` DB row or
`BRAND_COLOR_*` env vars override code defaults via public `GET /api/brand`.
Code changes alone won't show in a deployment that has stored overrides.

**Base gold vs gold-ink (AA):** base `--brand-gold`/`#c9a04a` is ~8.10:1 on
black but only ~2.44:1 on white (~1.92:1 on cream) — the BRIGHTER metallic gold
has LESS light-bg contrast than the old bronze, so the light-surface rule is
now stricter. It PASSES on dark surfaces (pins, headers, badges, fills w/ dark
text) but FAILS AA as normal TEXT on light/cream. For any gold *text on a light
admin surface* use `--brand-gold-ink` / `.brand-gold-ink` (or
`text-[var(--brand-gold-ink)]` in a Tailwind arbitrary/prose variant), never
the base. `--brand-gold-ink` is DERIVED at runtime by `applyBrandColors()`
(`admin-portal/src/lib/brand.ts`) via `goldInk()` — a CONTRAST-TARGETED darken
(loops until ≥4.6:1 on cream), NOT a fixed multiplier. A flat `darkenHex(_,0.36)`
under-darkened the brighter `#c9a04a` (→ ~4.27:1 on cream, AA-fail); the CSS
`:root` default `hsl(41 54% 27%)` was safe but the runtime override wasn't.
Decorative SVG icons in base gold on light bg (~2.4:1) are NOT flagged by axe's
text-contrast rule, but keep them decorative/labeled (WCAG 1.4.11).

**Verify:** admin-portal a11y gate (`pnpm --filter @workspace/scripts run a11y`)
is the contrast check — light theme, so warming dark TEXT tokens
(`--foreground`, `--muted-foreground`) is the a11y-sensitive part. BUT the gate
only scans a fixed subset (Apply/Onboard/Amend forms, Employees grid, Import
wizard, Pay Run, HR pages, Audit Log, Site detail) — public/legal pages like
`Legal.tsx` are NOT gated, so audit their bronze links by hand.
