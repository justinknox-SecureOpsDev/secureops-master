# PNC Bank Multipayments API Setup Guide

This guide walks through registering on the PNC API Hub, enabling the Multipayments product, and configuring the environment variables required for the "Send via PNC" payroll feature.

---

## 1. Register on PNC API Hub

1. Go to [developer.pnc.com](https://developer.pnc.com) and sign in with your PNC business online banking credentials.
2. Navigate to **My Applications** → **Create Application**.
3. Give the application a name (e.g. "WCSG Payroll Integration") and note the **Client ID** and **Client Secret** shown after creation — you will not be able to retrieve the secret again, so save it immediately in your secrets manager.

---

## 2. Enable the Multipayments Product

1. In your application's settings, click **Add Products**.
2. Find **Multipayments (MLP)** and click **Subscribe**.
3. PNC may require a brief review period before access is granted. Once approved, the status column shows **Active**.

---

## 3. Obtain Your Instructor Account Details

The "instructor" is WCSG as the originating company sending payments. You will need:

| Detail | Where to find it |
|---|---|
| Company / Instructor ID | Provided by PNC during onboarding or visible in the API Hub company profile |
| Source account number | Your WCSG operating / payroll bank account number |
| Source routing number | The ABA routing number for that account |
| Company name | Legal name as registered with PNC |
| Company address | Street, city, state, ZIP as registered with PNC |

---

## 4. Environment Variables

Set these on your deployment (Replit Reserved VM → Secrets tab):

| Variable | Required | Description |
|---|---|---|
| `PNC_CLIENT_ID` | ✅ | OAuth2 Client ID from PNC API Hub |
| `PNC_CLIENT_SECRET` | ✅ | OAuth2 Client Secret from PNC API Hub |
| `PNC_INSTRUCTOR_ACCOUNT_NUMBER` | ✅ | WCSG source (payroll) bank account number |
| `PNC_INSTRUCTOR_ROUTING_NUMBER` | ✅ | ABA routing number for the source account |
| `PNC_COMPANY_ID` | Recommended | Company/instructor ID issued by PNC |
| `PNC_INSTRUCTOR_NAME` | Recommended | Company name as registered with PNC |
| `PNC_INSTRUCTOR_ADDRESS_STREET` | Recommended | Street address |
| `PNC_INSTRUCTOR_ADDRESS_CITY` | Recommended | City |
| `PNC_INSTRUCTOR_ADDRESS_STATE` | Recommended | State (two-letter code, e.g. `TX`) |
| `PNC_INSTRUCTOR_ADDRESS_ZIP` | Recommended | ZIP code |
| `PNC_API_BASE_URL` | Optional | Override for sandbox testing (see below) |

The first four variables are required before the "Send via PNC" button is enabled. The address/name fields are included in the API request to PNC and should match your PNC account profile exactly.

---

## 5. Sandbox vs Production

| Environment | Base URL |
|---|---|
| **Production** | `https://api.pnc.com` (default) |
| **Sandbox** | `https://api-sandbox.pnc.com` (check PNC API Hub for the exact URL) |

To use the sandbox during integration testing, set:

```
PNC_API_BASE_URL=https://api-sandbox.pnc.com
```

Leave `PNC_API_BASE_URL` unset (or remove it) to use the production endpoint.

---

## 6. Verifying the Configuration

Once all required secrets are set and the app is restarted:

1. Open the admin portal and navigate to **System → Status** (or the amber degraded-config banner will disappear).
2. The **PNC API** row should show a green check.
3. On the **Pay Run** page, the **Send via PNC** button will become active for pending rows that have complete bank information.

---

## 7. OAuth2 Token Details

The integration uses the **OAuth2 client-credentials** flow:

- Endpoint: `POST {PNC_API_BASE_URL}/secoauth2/token`
- Body: `grant_type=client_credentials&client_id=…&client_secret=…`
- Tokens are cached in-process and refreshed 60 seconds before expiry.
- No token storage in the database — tokens are short-lived and re-fetched as needed.

---

## 8. Payment Flow

1. Admin selects pending payroll rows on the Pay Run page.
2. Clicks **Send via PNC** → the server validates bank data and maps each row to a PNC payment instruction.
3. A `multipaymentId` UUID (batch identifier) and a per-row `customerReference` (`WCSG-{employeeId}-{entryId}-{periodStart}`) are generated before any DB or API call.
4. Each row is atomically claimed from `pending` → `processing` in a transaction, with its unique `customerReference` stored as `paymentReference` in the DB. Concurrent requests that race the same rows see them as non-pending and get a 409.
5. The batch is submitted to `POST /api/mlp/v1/payments` in `sync` mode. The `multipaymentId` is the batch identifier; it appears only in audit log metadata.
6. On PNC success: rows advance `processing` → `processed` with `paidMethod = 'pnc_api'`. The `paymentReference` column already holds the per-row `customerReference`.
7. On PNC rejection or transport error: rows are rolled back to `pending` (paymentReference cleared) so the admin can correct and retry.
8. Live status for processed rows is shown as an inline color-coded settlement badge (gray = pending, yellow = accepted, green = settled, red = rejected) on the Pay Run page. Statuses are fetched once per page load (and on manual Refresh) via `GET /api/mlp/v1/payments?customerReference=…` using each row's stored `customerReference`; clicking a badge opens the full raw PNC response.

---

## 9. ACH CSV Fallback

The existing **Export ACH CSV** button is unaffected. Both methods are available on the Pay Run page simultaneously — admins choose whichever suits the current run.
