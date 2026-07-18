---
name: Site Manager per-site authorization invariant
description: Why role middleware alone is NOT enough for the site_manager role — every write route must also check canManageSite for the specific site being touched.
---

`requireAdminOrSiteManager` / `requireSchedulingStaff` only prove the caller has the
`site_manager` ROLE. They do NOT prove the caller manages the specific site a request
touches. The per-site scope (the `site_managers` join table) must be enforced inside
each route handler via `lib/siteManagerAuthz.ts` (`canManageSite(user, siteId)` /
`assertCanManageSite`). admin = all sites; site_manager = join-table scoped; everyone
else = false.

**Rule:** every shift/time-entry WRITE a site_manager can reach must resolve the target
site and call `canManageSite` before mutating — create/repeat/edit/delete shift, manual
assignment (`POST /shifts/:id/assignments`), claim approval, and time-entry approve/reject
(site resolved as `timeEntries.siteId ?? shifts.siteId`; deny null/unowned).

**Why:** Easy to add a new scheduling route, attach the role middleware, and forget the
per-site check — that silently lets a site_manager act on EVERY site. The manual
assignment route was exactly this miss in review: it had the role guard + licence gate
but no `canManageSite`, and `overrideLicense` was reachable by site_manager. Fix was to
call `canManageSite(shift.siteId)` before the licence gate (403 if unmanaged) and restrict
the licence override to admin/dispatcher only.

**How to apply:** when adding/auditing any route under `requireAdminOrSiteManager` or
`requireSchedulingStaff`, ask "does a site_manager hitting this touch a specific site, and
do I verify they manage THAT site?" If not, it's a hole. List endpoints filter to
`getManagedSiteIds` for site_manager.
