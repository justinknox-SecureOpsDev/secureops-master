---
name: Site/client hard-delete data loss
description: Why deleting a site or client silently destroys operational data, and the guard that prevents it
---

# Site / client hard-delete causes silent operational-data loss

Hard-deleting a `sites` row (or a `clients` row, since `sites.client_id` is `ON DELETE CASCADE`) splits its dependent data two ways because the FKs disagree on `onDelete`:

- **SET NULL (rows survive, link lost):** `shifts.site_id`, `patrol_scans.site_id`, `daily_activity_reports.site_id`, `invoices.site_id`, `payroll_entries.site_id`, `shifts.site_rate_id`.
- **CASCADE (rows permanently deleted):** `subcontractor_qr_tokens`, `subcontractor_time_entries`, `patrol_checkpoints`, `shift_requests`.

**Why this matters:** a real incident — an admin deleting what looked like duplicate sites via the generic admin CRUD wiped a live site's QR code + all its scan entries (CASCADE, unrecoverable) and orphaned 59 shifts (SET NULL). Production `executeSql` is read-only to the agent and prod is NOT captured by Replit dev checkpoints, so there is no easy in-place repair — only app-level recreation or a full prod PITR (which loses all newer data).

**The guard (lib/siteDeletion.ts):** every delete path — `DELETE /sites/:id`, `DELETE /clients/:id`, and the generic `DELETE /admin/tables/{sites,clients}/:id` — must call the shared blocker check and refuse with 409 + a `blockers` count map while any dependent rows exist. Keep all four wired to the single shared helper; do not re-add a delete path that bypasses it.

**How to apply:** if you add a new table that references `sites.id` or `clients.id`, decide its `onDelete` deliberately (prefer RESTRICT/guard over silent CASCADE/SET NULL for operational data) and add it to the blocker query so the guard stays complete.
