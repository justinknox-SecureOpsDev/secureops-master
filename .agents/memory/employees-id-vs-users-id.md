---
name: employees.id vs users.id in admin grid & profile surfaces
description: Admin personnel grid keys rows by employees.id, but profile-PDF / share / per-user routes resolve by users.id — send userId, not the grid row id.
---

# employees.id vs users.id

Admin generic-CRUD rows for the `employees` table are keyed by `employees.id` (the
employees-table PK) and ALSO carry a separate `userId` (= `users.id`). These are two
different UUIDs for the same person.

Per-user routes resolve by **users.id**, NOT employees.id:
- `GET /employees/:id/profile/pdf` → `buildEmployeeProfilePdf` matches `usersTable.id` only.
- employee share minting → `POST /admin/employees/:userId/share`.
- `licenses.employeeId` is itself a `users.id` (same id space as `employees.userId`).

**Rule:** any admin-portal action that takes a personnel-grid row and calls a per-user
route must send `row.userId ?? row.id`, never bare `row.id`. Sending `employees.id`
silently 404s (the lookup misses).

**Why:** the "Download profile PDF" button sent `initial.id` (employees.id) and 404'd in
production, while the adjacent "Share with client" button worked because it used
`userId ?? id`. Mirror the working sibling whenever adding a per-user action to the grid.
