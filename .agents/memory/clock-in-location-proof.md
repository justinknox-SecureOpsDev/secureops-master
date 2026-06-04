---
name: Clock-in location-proof invariant
description: Authorization rules for the time-entry clock-in paths (GPS vs GPS-less) — which paths may auto-assign and which require a roster.
---

# Clock-in location-proof invariant

The clock-in handler (`POST /time-entries/clock-in`, `routes/timeEntries.ts`) has three
entry paths. Their trust model is NOT interchangeable:

- **Geo-resolve (lat/lng → nearest site within 1 mi)** — location-proven. May
  `resolveOrAssignShiftForAdHocClockIn` (auto-assign the officer to an open shift at the
  resolved site).
- **Explicit `siteId` (manual picker, GPS-less)** — NO location proof. For non-admins it
  MUST require an accepted, live/upcoming roster assignment at that site (else 403
  `not_rostered_here`) and may attach ONLY to that own shift. It must NEVER auto-assign to
  arbitrary open shifts. Same gate applies to `GET /me/clock-in-sites` (officers see only
  their rostered sites; admins see all).
- **`shiftId` (tap a reserved shift)** — authorized by the accepted assignment itself.

**Why:** the manual `siteId` path was originally added to fix officers being unable to
clock in at sites with NULL coordinates (geo-resolve can never match those). A first cut
trusted *any* siteId and exposed all sites in the picker + allowed auto-assign — that let
an officer fabricate presence at a remote site and self-attach to its open shifts
(payroll/dispatch spoofing). Architect flagged it as a blocking regression.

**How to apply:** any future change that lets a clock-in proceed without verified GPS must
keep the accepted-roster requirement and must not auto-assign. Only add an upper
start-time bound (block far-future shifts) if product explicitly wants it — currently the
`siteId` path matches the `shiftId` path's broad trust (any accepted non-completed shift).
