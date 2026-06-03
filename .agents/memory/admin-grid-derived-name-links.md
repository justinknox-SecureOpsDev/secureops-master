---
name: Admin grid derived-name cell links
description: Why the Employees-table name click "did nothing" and how derived cells should link to a profile vs a filtered grid.
---

# Admin grid derived-name cell links

In the admin portal's generic CRUD grid (`DataGrid` / `lib/tables.ts`), a derived
cell (e.g. the Employees table `__name`) can link two ways:

- `derived.linkTo: { table, filterField }` — builds `/tables/{table}?filter[{filterField}]={fkValue}`.
- `derived.linkRoute: (fkValue) => "/route/:id"` — direct app route; takes precedence over `linkTo`.

**Gotcha / why:** A derived name cell that uses `linkTo` pointing back at *its own*
table (self-referential filter, e.g. employees `__name` → `linkTo employees`)
re-renders the same grid filtered to that row. To the user this looks like the
click "does nothing" — the perceived no-op bug. To open a profile, use
`linkRoute` to the dedicated route (employees name → `/personnel/:userId`,
keyed on `users.id`, since OfficerProfile fetches `GET /employees/:id` by user id).

**How to apply:** When a name/derived cell should open a detail/profile page,
use `linkRoute`. Reserve `linkTo` for genuine "drill into the related grid"
cases (e.g. shift_assignments / time_entries name cells intentionally filter the
employees grid). Always URI-encode the path segment in the `linkRoute` builder.
