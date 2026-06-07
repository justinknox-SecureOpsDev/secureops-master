---
name: Two phone fields must stay in sync
description: employees.phone vs users.phoneNumber — which is which, and every write path that must mirror between them
---

There are TWO phone columns and they serve different masters:

- `employees.phone` — the HR/employee-file field. What OfficerProfile / admin Employees grid display.
- `users.phoneNumber` — the ACCOUNT record. This is the **only** field the SMS pipeline reads (`lib/sms.ts` filters `smsOptIn && /^\+\d{8,15}$/`). Account-profile phone display also reads this.

**Rule:** any write to `employees.phone` must mirror the normalized value into `users.phoneNumber` (and vice-versa where applicable), or officers silently become SMS-unreachable while their profile still shows a number.

**Why:** they were never kept in sync. A bulk HR import populated `employees.phone` (without `+1`) but left `users.phoneNumber` blank, so only ~2 of ~235 accounts were SMS-reachable and profiles showed no phone. Required a one-time prod backfill (normalize to E.164 + copy across) plus code so it never drifts again.

**How to apply — every mutating surface must mirror + E.164-normalize:**
- `POST /employees`, `PUT /employees/:id` (employees.ts) — mirror to `users.phoneNumber`; PUT does it as an *isolated* `db.update` so it doesn't pollute the `employee_changes` diff / high-risk-self-edit fan-out (which already track `phone`).
- `PATCH /me/employee` (auth.ts) — the MOBILE self-service path. Previously didn't even normalize. Now normalizes phone + emergencyContactPhone, treats provided-but-empty as a clear→null, and mirrors to `users.phoneNumber`.
- Application approve (applications.ts) — sets `users.phoneNumber = app.phone` in both insert and re-approve update branches (`app.phone` already E.164 at submit).
- Admin generic grid `PUT /admin/tables/:table/:id` (admin.ts) — bypasses the dedicated handlers, so it normalizes employees phone fields AND mirrors BOTH directions: employees→users and users→employees. The users-grid reverse mirror intentionally does NOT emit an `employee_changes` row (that log is tied to `tableName==='employees'`); the users request is still captured by audit middleware.

Normalization is `normalizePhoneToE164` (lib/phone.ts), default-to-US (+1). admin.ts has a local `normalizePhoneFieldInPlace(body, key, label)` wrapper that coerces ""/null→null.
