---
name: Platform vs tenant login brand
description: Web portal pre-auth login stays fixed "SecureOps Command"; mobile login is tenant-branded once an org is connected (org code = tenant identity pre-login).
---

# Platform vs tenant login brand

**Web portal:** every tenant signs in through the SAME pre-authentication login
screen, branded **"SecureOps Command"** (`admin-portal/src/pages/Login.tsx`).
Do NOT pull tenant brand into it (no `window.__BRAND__` there).

**Mobile (July 2026 change):** `security-ops/app/login.tsx` IS tenant-branded —
once an org code is connected the app knows the tenant pre-login, so the login
screen shows that org's logo/name/tagline and the whole app derives its palette
from that backend's `GET /api/brand` (see `constants/colors.ts derivePalette`).
The platform "SecureOps Command" lockup is only the fallback (no org / no brand
fetched), and the CONNECT screen stays neutral platform brand. WCSG default
colors short-circuit to the hand-tuned palette exactly; high-contrast palette
never follows tenant brand. Brand is persisted per-org on-device (hydrated
inside the org init barrier → no WCSG flash on relaunch) and cleared on org
switch.

**Why:** on web the server can't know the tenant pre-login; on mobile the
stored org code identifies the tenant before login, and customers expect their
own brand on the sign-in screen.

**The emblem ("Command Shield"):** one vector mark (shield + north star +
double command chevron, gold-on-navy) authored TWICE with identical geometry:
- web: `admin-portal/src/components/SecureOpsLogo.tsx` (inline JSX `<svg>`)
- mobile: `security-ops/components/SecureOpsLogo.tsx` (`react-native-svg`:
  `Defs/RadialGradient/LinearGradient/Stop`, numeric stop offsets vs web %)

**How to apply:** any change to the mark must be mirrored in BOTH components to
keep web/mobile parity. The emblem is intentionally hard-coded to the platform
gold/navy palette (`#c9a84c` / `#080c18`), independent of tenant tokens and of
the mobile high-contrast palette.

**GoldText renders a SINGLE non-wrapping line (mobile):** the login's gold
gradient text (`security-ops/app/login.tsx` `GoldText`) paints native strings as
one `react-native-svg` `<SvgText>` sized to the measured text — it CANNOT wrap or
auto-shrink, so long tenant company names ("WILLIAMS COUNCIL SECURITY GROUP")
clip on both edges on phones. Any long/variable brand string MUST pass
`numberOfLines`/`adjustsFontSizeToFit`, which switches GoldText to a plain
solid-gold `<Text>` (wraps/shrinks, drops the gradient). The short platform
lockup keeps the gradient. Re-check whenever a NEW brand string goes through
GoldText.
