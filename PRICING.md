# Secure Ops Demo — Pricing Playbook

Reference guide for the platform owner. Prices in USD. All tiers run on the same codebase; tier differences are enforced by the `DISABLED_FEATURES` env var on the API server (see "Feature flags" below).

---

## 1. Recommended subscription tiers

Pricing assumes per-company billing, monthly, with a 12-month commitment. Annual upfront discount of ~15% is reasonable.

### Starter — $349/mo
Single-site or small operators (1–25 officers).

Included features:
- Scheduling (shifts, repeating series, open vacancy claim)
- Time clock + geo clock-in
- Officer + admin mobile apps (under your brand)
- Basic dashboard & dispatch
- Clients + sites + licenses
- Email + push notifications

`DISABLED_FEATURES=chat,radio,invoicing,payroll,hr,policies,swapRequests,licenseRenewals,dar,exports,trainings,patrol,availability,officerShares,incidents`

### Professional — $899/mo
Most security companies (25–150 officers).

Adds:
- Incident reporting + client share links
- Real-time chat
- Live officer map + geofence breach alerts
- Daily activity reports
- Swap requests + availability
- Patrol checkpoints
- License renewal workflow
- Audit log

`DISABLED_FEATURES=radio,invoicing,payroll,hr,trainings,exports,officerShares`

### Enterprise — $1,995/mo + $4/officer/mo over 150
Multi-site operators, full back-office (150+ officers).

Adds everything:
- HR pipeline (public application, onboarding, invitations)
- Payroll execution (Payroll Board, Pay Run, ACH CSV export, paystubs)
- Invoicing (auto-generated weekly, client-by-site)
- Push-to-talk radio
- Training certifications
- Bulk data exports
- Officer share links (external compliance)

`DISABLED_FEATURES=` (empty — all features enabled)

> **Add-ons** (any tier):
> - Stripe Connect direct deposits — $99/mo (passes Stripe fees through)
> - Twilio SMS notifications — $39/mo + Twilio usage at cost
> - Dedicated subdomain + custom email FROM — $25/mo
> - Additional sub-brand (multi-tenant white-label) — $199/mo per brand

---

## 2. Setup & onboarding services (one-time)

These are the things every new customer pays for *before* their monthly subscription starts.

| Service | Price | Scope |
|---|---|---|
| **Branding kit** | **$1,500** | Custom logo files, color palette, App Store / Play Store icons, email header, login screen artwork. Includes 2 revision rounds. |
| **White-label deployment** | **$2,500** | New isolated environment, customer's domain, SSL, env config, brand assets wired into `COMPANY_NAME` / colors / mobile bundle. |
| **Apple App Store distribution** | **$1,200 + $99/yr** | EAS build, App Store Connect setup, screenshots, review submission. Customer pays Apple's $99/yr developer fee directly. |
| **Google Play distribution** | **$800 + $25 one-time** | EAS build, Play Console setup, screenshots, review submission. Customer pays Google's $25 one-time developer fee directly. |
| **Data migration (basic)** | **$750** | Bulk import up to 500 employees + 50 clients + 200 sites from CSV. |
| **Data migration (large)** | **$2,000+** | Custom ETL from prior system (Deputy, When I Work, ABM, etc.). Quoted per source. |
| **Admin training (live)** | **$600** | Two 90-minute Zoom sessions for admin staff. Recorded for reuse. |
| **Officer training (video pack)** | **$400** | Branded onboarding video for officers (clock-in, incidents, chat, panic button). |
| **On-site go-live support** | **$1,800/day** | Optional. Travel billed at cost. |

**Typical "launch" bundle:** $5,650 — Branding + white-label deploy + App Store + Play Store + basic data migration + admin training.

---

## 3. Ongoing services (optional, monthly)

| Service | Price |
|---|---|
| Premium support (SLA 4hr biz hours, dedicated Slack) | $399/mo |
| Quarterly health check + tuning | $250/mo |
| Custom integrations (per integration) | $500–2,500 one-time, then $100/mo upkeep |
| New feature requests (priority queue) | $150/hr or fixed quote |

---

## 4. Feature flag reference

The API server reads `DISABLED_FEATURES` (comma-separated) on boot and exposes the resolved state at `GET /api/brand → features`. The admin portal and mobile app respect it automatically (hidden nav + 403 on disabled routes).

| Key | What it controls |
|---|---|
| `chat` | Team chat (web + mobile, WS broadcast) |
| `radio` | Push-to-talk radio |
| `incidents` | Incident reporting + client share links |
| `payroll` | Payroll Board, Pay Run, CSV/Stripe export, officer paystubs |
| `invoicing` | Invoice Board, auto-generated weekly invoices |
| `hr` | Public application form, onboarding, amendment workflow |
| `liveMap` | Live officer map (admin) + dispatch + location pings |
| `policies` | Policy publishing + acknowledgements |
| `swapRequests` | Officer-initiated shift swaps |
| `licenseRenewals` | License renewal request workflow |
| `dar` | Daily activity reports |
| `exports` | Bulk CSV/XLSX exports |
| `trainings` | Training certifications |
| `patrol` | Patrol checkpoint scans + missed-check alerts |
| `availability` | Officer weekly-availability self-service |
| `officerShares` | External officer profile share links |

Always-on (cannot be disabled): auth, users/employees, clients/sites/shifts, time entries, licenses, dashboard, admin CRUD, storage, system status, audit, 2FA.

### Example deployments

```bash
# Starter
DISABLED_FEATURES=chat,radio,invoicing,payroll,hr,policies,swapRequests,licenseRenewals,dar,exports,trainings,patrol,availability,officerShares,incidents

# Professional
DISABLED_FEATURES=radio,invoicing,payroll,hr,trainings,exports,officerShares

# Enterprise
DISABLED_FEATURES=
```

Toggling a flag requires an API server restart. The mobile app and admin portal pick up the change on the next page load (the `/api/brand` response is cached client-side for one session and edge-cached for 5 minutes).

---

## 5. Sales math

Assume 10 customers, mixed:
- 5 × Starter @ $349 = $1,745/mo recurring
- 4 × Pro @ $899 = $3,596/mo recurring
- 1 × Enterprise @ $1,995 + 80 officers extra @ $4 = $2,315/mo recurring
- **Total MRR: ~$7,656**

Plus one-time setup: 10 launches × $5,650 avg = **$56,500 one-time revenue**.

ARR at this base: ~$92K + $56K services = **~$148K Year 1**.

Add-on attach rate of ~30% on SMS/Stripe/subdomain adds another ~$200/mo per add-on customer.
