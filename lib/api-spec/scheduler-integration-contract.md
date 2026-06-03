# Event Staff Scheduler ↔ SecureOps Integration Contract

> **Audience:** The builder of the companion Event Staff Scheduler app.
> This document describes the exact API surface that the **scheduler must implement** so SecureOps can push changes to it, the surface that **SecureOps exposes** for the scheduler to push changes back, and the shared signing scheme.

---

## 1. Signing scheme (both directions)

Every cross-app HTTP request is authenticated with **HMAC-SHA256** over the raw JSON body.

| Detail | Value |
|---|---|
| Algorithm | HMAC-SHA256 |
| Key | The shared secret — stored in `SCHEDULER_SHARED_SECRET` on the SecureOps side |
| Input | The raw UTF-8 `Content-Type: application/json` request body (exactly as sent over the wire) |
| Output | Lowercase hex, 64 characters |
| Header name | `X-WCSG-Signature` |
| Source header | `X-WCSG-Source: secureops` (outbound from SecureOps) / `X-WCSG-Source: scheduler` (inbound from scheduler) |

Both sides must validate `X-WCSG-Signature` using `timingSafeEqual` (constant-time comparison) to prevent timing attacks.

**Signature construction (pseudo-code):**
```
signature = HMAC-SHA256(key=shared_secret, data=raw_body_utf8).hex()
```

Requests with a missing, malformed, or invalid signature **must** be rejected with `HTTP 401`.

---

## 2. Endpoints the Scheduler must implement

SecureOps calls these when shifts or clock events change on the SecureOps side.

### 2.1 `POST /api/secureops-webhook/shifts`

Called when a shift is created or updated in SecureOps.

**Request body:**
```json
{
  "secureopsId": "uuid",
  "externalId": "scheduler-id-or-null",
  "title": "Evening Patrol",
  "siteId": "uuid-or-null",
  "siteName": "City Hall",
  "startTime": "2026-06-10T18:00:00.000Z",
  "endTime": "2026-06-11T02:00:00.000Z",
  "payRate": "22.00",
  "billRate": "30.00",
  "requiredLicenseLevel": 2,
  "headcount": 3,
  "status": "upcoming",
  "notes": "Bring radio",
  "updatedAt": "2026-06-08T12:34:56.789Z"
}
```

**Expected response:** `HTTP 200` or `201` with any JSON body (SecureOps ignores the body).

**Idempotency:** The scheduler should upsert by `secureopsId`. If `externalId` is present, link the records bidirectionally.

---

### 2.2 `POST /api/secureops-webhook/shifts/delete`

Called when a shift is deleted in SecureOps.

**Request body:**
```json
{
  "secureopsId": "uuid",
  "externalId": "scheduler-id-or-null",
  "deletedAt": "2026-06-08T12:34:56.789Z"
}
```

**Expected response:** `HTTP 200`.

---

### 2.3 `POST /api/secureops-webhook/clock-events`

Called when a time entry (clock in, clock out, or approval-status change) is recorded in SecureOps.

**Request body:**
```json
{
  "secureopsId": "uuid",
  "externalId": "scheduler-event-id-or-null",
  "employeeEmail": "officer@example.com",
  "employeeName": "Jane Officer",
  "shiftSecureopsId": "uuid-or-null",
  "shiftExternalId": "scheduler-shift-id-or-null",
  "siteId": "uuid-or-null",
  "siteName": "City Hall",
  "clockInTime": "2026-06-10T18:03:00.000Z",
  "clockOutTime": "2026-06-11T02:01:00.000Z",
  "hoursWorked": "7.97",
  "approvalStatus": "approved",
  "updatedAt": "2026-06-11T09:00:00.000Z"
}
```

**Expected response:** `HTTP 200` or `201`.

**Idempotency:** The scheduler should upsert by `secureopsId`. Match to the employee by `employeeEmail`.

---

### 2.4 `POST /api/secureops-webhook/assignments`

Called when an officer is added to or removed from a shift in SecureOps. This keeps the scheduler's roster view in sync independent of shift-level changes. Triggered by:

- An admin/dispatcher forcing an assignment (`POST /shifts/:id/assignments`) → `action: "created"`.
- An officer self-claiming an open shift (`POST /shifts/:id/claim`) → `action: "created"`.
- An assignment being declined/removed (`PUT /shifts/:id/assignments/:assignmentId` with `{ "status": "declined" }`) → `action: "deleted"`.

**Loop prevention:** SecureOps skips this push when the parent shift's `sync_source = "scheduler"` (the assignment change originated on the scheduler side).

**Request body:**
```json
{
  "action": "created",
  "assignmentSecureopsId": "uuid",
  "shiftSecureopsId": "uuid",
  "shiftExternalId": "scheduler-shift-id-or-null",
  "employeeEmail": "officer@example.com",
  "employeeName": "Jane Officer",
  "status": "accepted",
  "occurredAt": "2026-06-08T12:34:56.789Z"
}
```

- `action`: `"created"` (officer added) or `"deleted"` (officer removed / declined).
- `shiftExternalId`: present when the parent shift is linked to a scheduler shift; use it to locate the roster entry, falling back to `shiftSecureopsId`.
- `status`: the assignment's status — `"accepted"` on create, `"declined"` on delete.
- `occurredAt`: ISO-8601 timestamp of when the change happened in SecureOps.

**Expected response:** `HTTP 200` or `201` with any JSON body (SecureOps ignores the body).

**Idempotency:** The scheduler should upsert/remove the roster entry keyed by `assignmentSecureopsId`. Match the officer by `employeeEmail`.

---

### 2.5 `POST /api/secureops-ping`

SecureOps calls this to verify connectivity when an admin clicks "Test connection".

**Request body:**
```json
{ "ping": true, "ts": "2026-06-08T12:34:56.789Z" }
```

**Expected response:** `HTTP 200` with any JSON body.

---

### 2.6 `POST /api/secureops-delta`

Called by the SecureOps reconciliation job (every 15 minutes) to fetch any changes that were missed while SecureOps was restarting.

**Request body:**
```json
{ "since": "2026-06-08T00:00:00.000Z" }
```

**Expected response:**
```json
{
  "shifts": [
    {
      "id": "scheduler-shift-id",
      "title": "Morning Shift",
      "siteName": "City Hall",
      "startTime": "2026-06-09T08:00:00.000Z",
      "endTime": "2026-06-09T16:00:00.000Z",
      "payRate": "20.00",
      "billRate": "28.00",
      "requiredLicenseLevel": 2,
      "headcount": 2,
      "status": "upcoming",
      "notes": null,
      "updatedAt": "2026-06-08T10:00:00.000Z",
      "deleted": false
    }
  ],
  "clockEvents": [
    {
      "id": "scheduler-event-id",
      "employeeEmail": "officer@example.com",
      "shiftId": "scheduler-shift-id-or-null",
      "siteName": "City Hall",
      "clockInTime": "2026-06-09T08:05:00.000Z",
      "clockOutTime": "2026-06-09T16:02:00.000Z",
      "hoursWorked": "7.95",
      "updatedAt": "2026-06-09T17:00:00.000Z"
    }
  ],
  "nextCursor": "2026-06-09T17:00:00.000Z"
}
```

- `nextCursor` must be the ISO-8601 `updatedAt` of the **newest** item in this response. SecureOps advances its stored cursor to this value after processing.
- Return empty arrays when nothing changed; `nextCursor` may equal `since` in that case.
- `shifts[].deleted = true` signals the scheduler deleted this shift; SecureOps will delete it locally.

---

## 3. Endpoints SecureOps exposes (scheduler calls these)

### 3.1 `POST /api/scheduler-webhook/shifts`

The scheduler calls this when a shift is created, updated, or deleted on its side.

**Authentication:** `X-WCSG-Signature` HMAC-SHA256 header (see Section 1) + `X-WCSG-Source: scheduler`.

**Request body:**
```json
{
  "id": "scheduler-shift-id",
  "action": "upsert",
  "title": "Evening Patrol",
  "siteName": "City Hall",
  "startTime": "2026-06-10T18:00:00.000Z",
  "endTime": "2026-06-11T02:00:00.000Z",
  "payRate": "22.00",
  "billRate": "30.00",
  "requiredLicenseLevel": 2,
  "headcount": 3,
  "status": "upcoming",
  "notes": "Bring radio",
  "assignedOfficerEmails": ["officer@example.com"],
  "updatedAt": "2026-06-08T12:34:56.789Z"
}
```

- `action`: `"upsert"` (create or update) or `"delete"`.
- `siteName`: matched against SecureOps `sites.name` (case-insensitive); if no match, the shift is created without a siteId.
- `assignedOfficerEmails`: the scheduler may include a list of officer email addresses to auto-assign on upsert.
- `updatedAt`: ISO-8601; SecureOps applies **last-write-wins** conflict resolution — if the local SecureOps record has a newer `updatedAt`, the incoming update is silently skipped.

**Response `HTTP 200`:**
```json
{
  "ok": true,
  "action": "created",
  "secureopsId": "uuid",
  "skipped": false,
  "skipReason": null
}
```

- `action`: `"created"` | `"updated"` | `"deleted"` | `"skipped"`.
- `skipped`: true when the incoming `updatedAt` is older than the stored record.

---

### 3.2 `POST /api/scheduler-webhook/clock-events`

The scheduler calls this when a clock-in or clock-out happens on its side.

**Authentication:** same as 3.1.

**Request body:**
```json
{
  "id": "scheduler-event-id",
  "action": "upsert",
  "employeeEmail": "officer@example.com",
  "shiftId": "scheduler-shift-id-or-null",
  "siteName": "City Hall",
  "clockInTime": "2026-06-10T18:03:00.000Z",
  "clockOutTime": "2026-06-11T02:01:00.000Z",
  "hoursWorked": "7.97",
  "updatedAt": "2026-06-11T09:00:00.000Z"
}
```

- `action`: `"upsert"` or `"delete"`.
- `shiftId`: the scheduler's own shift ID; SecureOps looks up the linked SecureOps shift via the stored `externalId` mapping.
- `siteName`: same fuzzy match as shifts.
- SecureOps deduplicates against existing time entries by:
  1. `externalId` match first (exact).
  2. Officer + site + clock-in within a 5-minute tolerance window (prevents double-counting when both systems record the same physical clock-in).

**Response `HTTP 200`:**
```json
{
  "ok": true,
  "action": "created",
  "secureopsId": "uuid",
  "skipped": false,
  "skipReason": null,
  "mergedExisting": false
}
```

- `mergedExisting`: true when the request was deduplicated against an existing SecureOps entry.

---

## 4. Identity mapping

| SecureOps field | Purpose |
|---|---|
| `shifts.external_id` | The scheduler's own shift ID |
| `shifts.external_source` | Always `"scheduler"` for entries originating there |
| `shifts.external_updated_at` | Scheduler's `updatedAt` — used for last-write-wins |
| `shifts.sync_source` | `"local"` or `"scheduler"` — `"scheduler"` suppresses outbound echo |
| `time_entries.external_id` | The scheduler's own clock-event ID |
| `time_entries.external_source` | Always `"scheduler"` |
| `time_entries.external_updated_at` | Scheduler's `updatedAt` |
| `time_entries.sync_source` | `"local"` or `"scheduler"` |

---

## 5. Conflict resolution

- **Last-write-wins by `updatedAt`**: when both systems have an update for the same record, the one with the newer `updatedAt` wins.
- **Source tiebreaker**: if `updatedAt` values are within 1 second, the change from **SecureOps** (local source) takes precedence over the scheduler's version.

---

## 6. Clock-in deduplication / reconciliation

When a clock event arrives for officer O at site S and time T, SecureOps:
1. Checks `time_entries.external_id = incomingId` — if found, update in place.
2. Checks for an existing entry where `employee_id = O's user id` AND `site_id = S's id` AND `|clockInTime - T| ≤ 5 minutes` — if found, merge (update with scheduler's externalId; keep local hoursWorked if it's already present).
3. Otherwise: create a new time entry with `sync_source = 'scheduler'` and `approval_status = 'pending'`.

This guarantees one authoritative time entry per clock event regardless of which system recorded it first.

---

## 7. Reconciliation safety net

SecureOps runs a scheduled reconciliation job every **15 minutes**. It:
1. POSTs to `/api/secureops-delta?since=<cursor>` on the scheduler.
2. Re-applies any shifts or clock events it missed (same upsert/dedup logic as the webhook path).
3. Advances the stored cursor to `nextCursor` on success.

The cursor is stored in `scheduler_sync_cursors` (keyed `"shifts"` and `"clock_events"`).

---

## 8. Environment variables (SecureOps side)

| Variable | Required | Description |
|---|---|---|
| `SCHEDULER_BASE_URL` | Yes | Base URL of the scheduler app (e.g. `https://eventstaffscheduler.net`) |
| `SCHEDULER_SHARED_SECRET` | Yes | Shared HMAC secret — must be the same on both sides; generate with `openssl rand -hex 32` |

Both must be set for the integration to activate. SecureOps operates in read/write-only mode for local data when the integration is inactive (no sync, no outbound calls).
