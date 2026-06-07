---
name: Lead role "no financial info" invariant
description: Where finance must be hidden for the mobile lead role, and how leads are confined in the app shell
---

The mobile **lead** role manages scheduling + staffing but must NEVER see financial
data (payRate / billRate / hourlyRate / earnings / bank / tax / payroll / paystubs /
W-2 / invoices / client billing terms).

**Why:** It is a hard product/security policy, not a cosmetic choice. A code review
caught real leaks after the first pass hid only tab/link entry points.

**Current shell design:** Leads live in the **admin shell** (`app/(admin)/`) but are
confined to the **Shifts stack only**. The tab bar is pruned for leads in
`app/(admin)/_layout.tsx` (href:null on non-shifts tabs), and `RootLayoutNav` enforces
the route-level half: a lead in any auth group who is NOT in `(admin)/shifts` is
bounced to `/(admin)/shifts`. That single catch-all covers deep-links into every other
admin screen (payroll/invoices/dashboard/clients/employees) AND the entire `(employee)`
shell. Leads land on `/(admin)/shifts` from RootLayoutNav's default-landing and
post-login branches; sign-out lives on `(admin)/shifts/index.tsx`.

**How to apply — three layers, all required:**
1. **Server projection/guards** strip finance for leads on every read (shifts finance
   strip + rate fallback, clients/sites/employees lead projections). This is the real
   boundary — server 403s/strips so a lead never *fetches* finance.
2. **Route confinement** (`RootLayoutNav` lead catch-all + `(admin)/_layout` tab prune)
   keeps leads on Shifts. Hiding a tab is NOT enough on its own.
3. **Cross-session cache purge:** `AuthContext` calls `queryClient.clear()` on BOTH
   `login()` and `logout()`. Without this, a prior admin session's cached payroll/
   invoice data lingers in the React Query cache and surfaces to a lead who signs in
   next on the same device — even though the server would 403 a fresh fetch.

**Top-level deep-linkable screens escape the group catch-all.** Expo-router top-level
screens (e.g. `app/paystubs.tsx`) are NOT inside `(admin)`/`(employee)`, so the
RootLayoutNav group-guard does not catch them. Any finance-bearing top-level screen
needs its OWN in-screen lead guard: `const isLead = user?.role === "lead"` →
`router.replace("/(admin)/shifts")` in an effect + `if (isLead) return null` before any
fetch/render. `paystubs.tsx` already does this. Add the same to any future top-level
finance route.

**Historical note:** an earlier design put leads in the *employee* shell with a
lead-only "Schedule" tab (`app/(employee)/schedule`, still present in
`(employee)/_layout.tsx`). That path is now dormant — RootLayoutNav bounces leads out
of the employee shell — but the code was left in place rather than ripped out. If you
revisit the lead shell, reconcile these two designs instead of assuming only one exists.
