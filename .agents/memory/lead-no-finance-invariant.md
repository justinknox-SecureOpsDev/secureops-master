---
name: Site Manager (formerly "lead") finance/PII boundary — OWN vs OTHER
description: What a site_manager CAN vs CANNOT see — they are a full employee with scheduling powers, not a finance-blind restricted admin. (Role value renamed lead -> site_manager.)
---

The mobile **site manager** role (`users.role === "site_manager"`, formerly `"lead"`)
is a **full employee PLUS site-scoped scheduling powers**. They live in the normal
`(employee)` shell and reach scheduling/approvals via gated tabs. There is NO redirect
into the admin shell.

**The boundary is OWN vs OTHER, NOT "all finance".** When a task says "managers see
NO finance", it means no OTHER-people / client finance — NOT hiding their own pay.
- A site manager SEES their OWN finance like any officer: own hourly rate + banking/tax
  + W-2 doc on Profile, own paystubs (`/me/payroll`), own rate readonly + editable bank
  details in edit-profile. `GET /employees/:id` returns the FULL record on a self read
  (`role==="site_manager" && userId===id`).
- A site manager must NEVER see OTHER people's / the client's finance: pay/bill rates on
  the shifts + time entries they schedule/approve, the payroll board, invoices, client
  billing terms, and other officers' banking/SSN/tax on the roster.

**Why:** Product policy. An earlier design made the role a restricted-admin with ALL
finance hidden incl. their own — that was explicitly judged WRONG; they are employees
who also schedule. So do NOT block `/me/payroll` or strip self employee finance for a
site manager — that regresses the policy and breaks `siteManagerOwnFinance.test.ts`.

**How the OTHER-people boundary is enforced (keep unchanged):**
1. `stripShiftFinanceForRole` strips payRate+billRate for site_manager on every shift read;
   `stripTimeEntryBillRateForRole` strips BOTH payRate+billRate for site_manager on time-entry
   reads (officers keep payRate; admin/dispatcher see both). Single source of truth in
   `lib/financeVisibility.ts`. See `shift-finance-field-visibility.md` for the full matrix.
2. `GET /employees/:id` strips finance/PII when a site_manager reads SOMEONE ELSE, full
   record on self read; `GET /employees` list stays stripped (roster = others).
3. The `(admin)/shifts/*` screens hide pay/bill rate fields for site managers.

**`AuthContext` purges the React Query cache on login/logout** so a prior admin session's
cached payroll/invoice data can't linger for the next signed-in user.

If you ever read a middleware/route comment that says site managers "must never see
payroll/financial data" with no OWN/OTHER qualifier, it is overbroad — the live policy
is OWN-vs-OTHER above.
