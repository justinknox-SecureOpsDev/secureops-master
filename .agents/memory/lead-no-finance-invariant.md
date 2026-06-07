---
name: Lead role finance/PII boundary (full employee + scheduling)
description: What a lead CAN vs CANNOT see after leads became full employees with scheduling powers
---

The mobile **lead** role is a **full employee PLUS scheduling powers**. A lead lives in
the normal `(employee)` shell (Home / My Shifts / Clock / Incidents / Chat / Radio /
Profile) and reaches scheduling via a lead-only **Schedule** tab
(`app/(employee)/schedule`, re-exports the `(admin)/shifts` screens). There is NO
redirect into the admin shell anymore.

**The boundary is OWN vs OTHER, not "all finance".**
- A lead SEES their OWN finance like any officer: own hourly rate + banking/tax +
  W-2 doc on their Profile, own paystubs (`/me/payroll`), own rate readonly + editable
  bank details in edit-profile.
- A lead must NEVER see OTHER people's finance/PII: pay/bill rates on the shifts they
  schedule, and other officers' banking/SSN/tax on the roster.

**Why:** Product policy (Task: "make Lead a full employee + scheduling"). Earlier design
made leads restricted-admins with ALL finance hidden incl. their own — that was wrong;
they are employees who also schedule.

**How the OTHER-people boundary is enforced (keep these unchanged):**
1. `stripShiftFinanceForLead` in `routes/shifts.ts` strips payRate/billRate for leads on
   every `/shifts` read. **Consequence:** the lead's own `(employee)/shifts.tsx` My Shifts
   list keeps its `{!isLead && ...}` per-shift pay row hidden — the data is stripped
   server-side, so showing it would render $0.00. Own rate comes from Profile, not here.
2. Roster/employee projection: `GET /employees/:id` strips finance/PII for a lead reading
   SOMEONE ELSE, but returns the FULL record on a **lead self-read**
   (`role==="lead" && userId===id`). `GET /employees` list stays stripped (roster = others).
3. The `(admin)/shifts/*` screens (create/edit/[id]/index) hide pay/bill rate fields for
   leads — these are the "shifts they schedule" surfaces.

**Own-finance endpoints already work for leads with no change:** `/me/payroll` pins to
`req.user.userId`; `SELF_UPDATABLE_EMP_KEYS` (PUT `/employees/:id` non-admin path)
includes bank fields, so leads self-edit banking like employees.

**`AuthContext` purges the React Query cache on login/logout** (`queryClient.clear()`) so a
prior admin session's cached payroll/invoice data can't linger for the next signed-in user.

**Defense-in-depth leftover:** `(admin)/_layout.tsx` still prunes non-shifts tabs for leads
(`href:null`). Leads no longer land in the admin shell, so this is dormant but harmless.
