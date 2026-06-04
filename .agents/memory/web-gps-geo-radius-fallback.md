---
name: Mobile-web GPS & geo-radius fallbacks
description: Why geo-radius features (clock-in, geofence) need a manual fallback on web, not just on missing-location
---

# Mobile-web GPS is inaccurate — geo-radius features need a manual fallback

Browser geolocation on mobile **web** is resolved from wifi/IP, not satellites, so it
routinely returns coordinates that are off by **miles**. It usually returns *something*
(permission granted, a fix exists) — it's just wrong.

**Consequence:** any server feature that geo-resolves the nearest site within a tight
radius (officer self clock-in `POST /time-entries/clock-in` with no `shiftId` →
`resolveNearestSite`, `GEO_RESOLVE_RADIUS_MILES = 1`) will reject a real, on-site
officer with `422 "No Site Nearby"` purely because the browser fix was wrong.

**Rule:** the manual-site-picker fallback must trigger on the **422 geo-resolve
failure**, not only when location is entirely missing (`!location`). Officers with an
inaccurate-but-present web fix would otherwise dead-end on an error banner with no way
to clock in.

**Why:** native GPS is accurate, so a 422 there genuinely means "not near a site" and
the correct UX is the message ("move closer / tap a reserved shift"). On web a 422 is
almost always a bad browser fix, so route it to the manual picker (which clocks in
using the **site's own coordinates**, guaranteeing the geo-resolve succeeds).

**How to apply:** gate the fallback on `Platform.OS === "web"` AND that the failed
attempt was not itself a manual pick (otherwise you loop), AND the error is the
422 / `"No Site Nearby"` shape. The picker is fed by `GET /me/clock-in-sites`
(employee-safe site list with coords). Sites missing coords show "NEEDS SETUP" —
that's an admin geocoding gap, surfaced in the picker, not a code bug.
