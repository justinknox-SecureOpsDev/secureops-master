---
name: Shared platform login brand (SecureOps Command)
description: The pre-auth login screens are platform-branded, NOT per-tenant; one shared SVG emblem renders on both web and mobile.
---

# Shared platform login brand

After the white-label work, every tenant company signs in through the SAME
pre-authentication login screen, branded **"SecureOps Command"** (the platform).
Per-company branding only takes over AFTER login.

**Rule:** the login screens (web `admin-portal/src/pages/Login.tsx` + mobile
`security-ops/app/login.tsx`) must show the FIXED platform brand. Do NOT pull
tenant brand into them — not `window.__BRAND__` on web, not
`EXPO_PUBLIC_COMPANY_NAME` on mobile. Both were removed from the login copy,
emblem, wordmark, and footer.

**Why:** all tenants share one login surface; leaking a tenant's company name /
appName there breaks the "shared platform entry" model and confuses users who
haven't authenticated yet (the system doesn't know the tenant pre-login anyway).

**The emblem ("Command Shield"):** one vector mark (shield + north star +
double command chevron, gold-on-navy) authored TWICE with identical geometry:
- web: `admin-portal/src/components/SecureOpsLogo.tsx` (inline JSX `<svg>`)
- mobile: `security-ops/components/SecureOpsLogo.tsx` (`react-native-svg`:
  `Defs/RadialGradient/LinearGradient/Stop`, numeric stop offsets vs web %)

**How to apply:** any change to the mark must be mirrored in BOTH components to
keep web/mobile parity. The emblem is intentionally hard-coded to the platform
gold/navy palette (`#c9a84c` / `#080c18`), independent of tenant tokens and of
the mobile high-contrast palette.
