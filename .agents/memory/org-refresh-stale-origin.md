---
name: Org origin self-heal refresh
description: Launch-time refresh of the persisted org origin — failure policy and the mid-flight switch-org race guard.
---

# Org origin self-heal refresh

Mobile devices persist the backend ORIGIN at org-connect time. When a tenant moves domains (e.g. replit.app → custom domain), pinned devices keep posting to the retired origin — symptoms look like "password reset emails not delivered" even though the prod email pipeline is healthy.

**Rule 1 — heal, don't gate:** the launch-time refresh re-resolves the STORED org code against the directory fire-and-forget. It must no-op on null org, blank code, same origin, or ANY directory failure — a flaky network must never disconnect a working app. The directory URL is env/hardcoded default, never the stale persisted origin (or a dead domain could never heal).

**Rule 2 — race guard before persisting:** any async "refresh persisted state" flow must re-read storage just before writing and abort unless it still equals the snapshot it started from. Without it, a slow directory round-trip that overlaps switchOrg/selectOrg re-persists and re-routes to the PREVIOUS tenant's backend (cross-tenant invariant violation). React `cancelled` flags in a root-level provider never flip, so they don't cover this.

**Rule 3 — save first:** persist the new org before applying live routing, so storage and routing can never disagree (a failed save leaves both on the old origin; next launch retries).

**How to apply:** `refreshSelectedOrg` in security-ops `utils/orgBootstrap.ts` is the canonical pattern; ship-to-device requires an OTA/app update, and the org code must be registered in `ORG_DIRECTORY` on the directory deployment or the refresh is a permanent no-op.
