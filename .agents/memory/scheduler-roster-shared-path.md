---
name: Scheduler roster sync — two ingest paths
description: Inbound scheduler shift data arrives via TWO paths; roster/side-effect logic must be shared by both.
---

Inbound Event-Staff-Scheduler shift data reaches SecureOps through TWO paths that
must stay behavior-identical:

1. **Webhook** — `POST /scheduler-webhook/shifts` (real-time push).
2. **Periodic delta pull** — `runSchedulerReconciliation` (safety-net for
   missed/failed webhooks) → `reconcileSchedulerDelta` → `processInboundShift`.

**Rule:** any field the webhook acts on (e.g. `assignedOfficerEmails` roster
reconciliation) must be (a) declared on `SchedulerShiftPayload` so the delta pull
carries it, and (b) handled inside the shared `processInboundShift`, NOT inline in
the webhook route handler.

**Why:** roster reconciliation originally lived only in the webhook handler, so a
roster change that arrived only via the periodic pull never synced. Putting
side-effects in the shared path keeps the webhook, the reconcile job, AND the
admin `/admin/scheduler/resync` route consistent for free.

**How to apply:** when adding a new scheduler-driven shift behavior, add the field
to `SchedulerShiftPayload` (lib/schedulerSync.ts) and act on it in
`processInboundShift` (routes/schedulerWebhook.ts). The webhook just maps its
Zod-parsed body into the canonical payload — it should not carry standalone
side-effect logic.
