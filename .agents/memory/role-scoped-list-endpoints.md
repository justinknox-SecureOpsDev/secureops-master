---
name: Role-scoped list endpoints on personal screens
description: List endpoints widen by ROLE, not by identity — a personal "my stuff" screen must pass an explicit self filter or it silently shows staff other people's rows.
---

Several api-server list endpoints widen their result set by the caller's ROLE
when no filter is supplied. `GET /time-entries` is the canonical example: with
no `employeeId` param an `admin` gets EVERY employee's entries and a
`site_manager` gets every entry at their managed sites. That is deliberate —
the admin approval queue depends on it.

**Rule:** any *personal* screen ("my shifts", "my time", "confirm your last
shift") must pass an explicit self filter (`employeeId = me`) AND re-assert
ownership on the row it acts on. Never assume "the list I got back is mine."

**Why:** the officer Clock screen fetched the list unscoped and then took the
first `awaiting_confirmation` row. For an ordinary employee that row was always
theirs, so it looked correct for years. For an admin who actually worked a
shift, the first row was a *different officer's* entry — the confirmation card
rendered a stranger's clock-in/clock-out times, and tapping confirm failed with
403 because `POST /time-entries/:id/confirm` is correctly owner-gated. The
symptom ("wrong hours, and I can't confirm") looks like a time-entry bug but is
really a list-scoping bug. It only reproduces for staff roles, which is why it
survived employee testing.

**Also:** list endpoints feeding a "latest" UI need an explicit `ORDER BY`.
Unordered Postgres results made "your last shift" mean "an arbitrary row".
Sort server-side AND pick the max client-side; don't trust list position.

**How to apply:** when wiring any list endpoint into a self-service screen,
check the route's role branch first. If the no-filter branch widens for staff
roles, pass the self filter explicitly and gate the query on the user id being
loaded. Belt-and-braces client-side ownership filtering is cheap and makes the
screen degrade safely if the param is ever dropped.
