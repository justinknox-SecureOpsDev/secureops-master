---
name: Admin time-card week-nav gating
description: Why "Weekly Time Card week arrows don't work" is usually an officer-selectability bug, not a nav bug.
---

On `/admin-portal/payroll/time-card` the week controls (prev / next / jump-to-current) are `disabled={!card || loading}` — they only do anything once a time card is loaded, and a card only loads once an officer is selected.

**Rule:** a report that "week navigation doesn't change the week" is almost never the nav plumbing. Check officer selectability first.

**Why:** the officer dropdown, under a site filter, was fed only by the site-officers endpoint (an INNER JOIN = officers *with* entries at that site). An officer with zero entries that week was unreachable, so no card ever loaded and the arrows stayed permanently disabled. The nav chain (navigate → wouter query → refetch effect) and the server week chain were both verified correct.

**How to apply:** admins must always be able to select ANY staff officer (to create a missing card), so the dropdown builds from the full `users` list; the site-officers list is only a convenience "Worked at this site" optgroup, with everyone else under "All officers". The server returns a full card (weekStart/prev/next) even for empty weeks, so once any officer is selected the arrows enable and navigation works.
