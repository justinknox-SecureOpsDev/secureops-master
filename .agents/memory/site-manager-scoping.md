---
name: Site-manager role — per-site scoping + finance/PII boundary
description: What a site_manager (renamed from "lead") CAN vs CANNOT do; per-site authority model and the write-vs-read finance trap
---

The mobile/admin **`site_manager`** role (display "Site Manager", **renamed from
`lead`**) is a **full employee PLUS scheduling powers confined to its assigned
sites**. Role is plain TEXT (no pg enum); legacy `lead` rows are migrated by an
**awaited** boot data-repair (`lib/dataRepairs.ts`) before `listen()` so zod doesn't
500 on stale rows.

## Per-site authority model
- Many-to-many manager↔site (join table); admins assign on SiteDetailPage.
- One shared authority helper gates every scheduling/time surface; **admin +
  dispatcher bypass, site_manager scoped, everyone else denied, fails closed** when
  site membership is unresolved.
- Always derive the site from `site_id` server-side, never a client-supplied id, or
  it's an IDOR. Apply on every shift / assignment / claim / time-entry write+read.

## Boundary is OWN vs OTHER, not "all finance"
- A site manager SEES their OWN finance like any officer: own rate, banking/tax,
  own paystubs (`/me/payroll`), self-editable bank fields.
- A site manager must NEVER see OTHER people's finance or other-site PII:
  pay/bill rate is stripped from every shift read; `GET /employees/:id` strips
  finance/PII for reads of someone else (full record on self-read); `GET /clients`
  is scoped to clients that own a managed site, with billing/contact stripped.

## KEY TRAP: response finance-strip ≠ write-block
Stripping a finance field from the RESPONSE does **not** stop a site manager from
**writing** a finance linkage. `siteRateId` (FK to a rate card that drives pay/bill
rates) had to be **forced null on site-manager shift create** and **ignored on
edit** — otherwise a manager could point a shift at an arbitrary rate card even
though they can't see the resulting rates.
**Why:** a read-path rate strip leaves the write path open — a scoped role could
still point a record at finance it cannot see. **How to apply:** any client-supplied
id that *links to* finance/other-site data must be neutralized on the WRITE for
scoped roles (force null / ignore), in addition to read-strip — and a cross-scope
MOVE (e.g. a manager moving a shift between two managed sites) must RECOMPUTE all
carried finance from the destination (pay/bill from the new site's defaults, the
rate-card FK dropped) and fail closed if the destination has none, not merely drop
the FK. Nulling the strings won't work: shift pay/bill columns are NOT NULL.

## Notifications
Site managers are notified (push + SMS) on shift create AND on a pending claim,
**scoped to their sites** and **deduped against admins** (admins + managers can
overlap).

## Test gotcha (serial singleFork suite)
The api-server suite runs serial/single-fork and tests **share mutable DB fixtures**.
A `PUT /sites/:id/managers` test reassigns the shared "zeroManager" to a site, so a
later assertion that a manager "manages nothing" must use a **dedicated isolated
fixture no other test reassigns** — not the shared zeroManager.
