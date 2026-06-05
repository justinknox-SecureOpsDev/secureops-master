---
name: Dispatch open-shifts "staffed shows as open"
description: Why recurring shifts make the Dispatch 72h open-shifts list look wrong, and the correct (non-bug) explanation.
---

When a user reports the Dispatch "open shifts (next 72h)" list shows shifts as OPEN that they
believe are already staffed, it is almost always **recurring shifts**, NOT a counting bug.

**The endpoint is correct.** `GET /dispatch/open-shifts?hours=72` counts `shift_assignments`
with `status='accepted'` and returns rows where `filled < headcount`. Every production
assignment-insert path uses `status='accepted'`, and decline DELETES the row, so there is no
"pending assignment silently ignored" failure mode. Verified: a fully-staffed shift is correctly
excluded; only genuinely-unstaffed or partially-filled multi-headcount shifts appear.

**Why it looks wrong to the user:** venues repeat every night (one separate shift per day).
The user staffs *tonight's* instance; the next 72h window also contains the SAME venue on the
next 2-3 nights, which are genuinely unstaffed. Same venue name → user thinks the staffed one is
shown. A calendar day-detail (in local/Central time) showing tonight as "filled" is consistent
with Dispatch showing the *other nights* as open.

**Why:** the open-shift row originally showed only weekday+time, not an explicit calendar date,
so Saturday's "Jaguars 9 PM" looked identical to the Friday one already filled.

**How to apply:** before assuming a bug, reproduce the live list against the prod read-replica
(`executeSql environment:"production"`) grouping by (venue, day) and annotate filled/headcount +
assigned officer names. Distinguish: (a) future-day recurrences, (b) partially-filled
multi-headcount shifts (correctly open), (c) MULTIPLE LEGITIMATE shifts at the same venue on the
same day at different times (e.g. Jaguars 9 PM and 11:59 PM are both real — do NOT assume a
"23:59 created seconds apart" row is an accidental duplicate; confirm with the user). The fix for
the confusion is display-side: show the date per row
(`fmtDate`) and "N of M slots still open (K assigned)" for partial fills — not a query change.

Note: this user "only uses the prod DB" — dev is near-empty, so always reproduce against prod data.
