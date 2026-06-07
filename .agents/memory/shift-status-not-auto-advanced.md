---
name: shift.status is not auto-advanced past its time
description: A shift row keeps status="upcoming" forever even after its start/end time passes; "upcoming" surfaces must add a date bound.
---

# shift.status never auto-advances — bound "upcoming" surfaces by time

`shifts.status` is a stored enum (`upcoming`/`active`/`completed`/`cancelled`).
Nothing advances it as wall-clock time passes — a shift whose `endTime` is days in
the past still has `status="upcoming"` in the DB. So **any query that surfaces
"upcoming" shifts by filtering on `status` alone will leak long-past rows.**

**Why:** the admin mobile dashboard "Upcoming Shifts" list showed shifts from weeks
prior because the admin-summary query filtered only on `status="upcoming"`.

**How to apply:** every "upcoming" surface must add a time bound — on BOTH any count
and any list it feeds. The preferred convention is `endTime >= now` (bound by
endTime, not startTime) so a shift that is currently in progress (started, not yet
ended) still counts as upcoming and doesn't vanish, while truly-finished rows are
excluded. (One older surface bounds by `startTime >= now`, which is also acceptable
but drops in-progress shifts — prefer `endTime >= now` for new code.) When you add a
new upcoming-shifts query, this date bound is mandatory; status alone is never
sufficient.
