---
name: Lead role "no financial info" invariant
description: Where finance must be hidden for the mobile lead role, especially deep-linkable screens
---

The mobile **lead** role manages scheduling + staffing but must NEVER see financial
data (payRate / billRate / hourlyRate / earnings / bank / tax / payroll / paystubs /
W-2 / invoices). Leads now get the full employee experience (employee shell) PLUS a
lead-only Schedule tab, so the invariant must hold across *employee* surfaces too.

**Why:** It is a hard product/security policy, not a cosmetic choice. A code review
caught real leaks after the first pass hid only tab/link entry points.

**How to apply — hiding a link/tab is NOT enough for top-level screens.**
Expo-router top-level screens listed in `ALLOWED_TOP_SCREENS` (RootLayoutNav) are
deep-linkable by path even if no UI links to them. Finance screens reachable that way
(`/paystubs`, `/edit-profile` bank/rate sections) need an in-screen role guard that
redirects leads before any fetch/render — not just `href:null` on the tab or a hidden
button. Pattern: `const isLead = user?.role === "lead"` → `router.replace("/(employee)/home")`
in an effect + `if (isLead) return null`.

Surfaces that must gate on `isLead`: profile (rate bar, BANKING & TAX section, W-2 doc,
"My paystubs" link), My Shifts (per-shift rate/earnings row), edit-profile (read-only
hourly rate + Bank details section AND omit bank fields from the submit payload so an
empty hidden form can't wipe data), and the `/paystubs` route guard. home.tsx and
clock.tsx show only hours — no money — so they need no gating.
