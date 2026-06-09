---
name: Notification routing policy
description: Which admin-notification events go to ALL admins vs the single dedicated admin inbox, and on which channels.
---

# Notification routing policy

WCSG splits admin-facing notifications into two audiences by event type:

- **Safety / operational events → ALL admins.**
  - SOS / emergency panic (`liveOps.ts` POST `/emergency`): in-app push **+ SMS + email**, all three to every admin.
  - Incident reports (`incidents.ts` POST `/incidents`): in-app push to every admin (plus the existing WS pulse to connected admins/dispatchers).
- **HR / administrative events → ONE dedicated inbox** (`brand.adminNotifyEmail`, env `ADMIN_NOTIFY_EMAIL`, default `admin@williamscouncil.com`):
  - Officer self-edit / high-risk profile-change digest (`scheduledJobs.ts`): EMAIL goes only to the dedicated inbox; in-app push still fans out to all admins.
  - New application submission (`applications.ts` POST `/applications`): email to dedicated inbox.
  - Onboarding completion (`applications.ts` `/onboarding/:token`): email to dedicated inbox (replaced the old all-admin push).

**Why:** safety events need maximum reach/redundancy across channels; HR events are routed to one mailbox so they don't spam every admin. The dedicated inbox is a distinct address from the seeded demo admin (`admin@secureops.com`).

**How to apply:** when adding a new admin notification, decide audience by event class (safety→all admins; HR/admin→`brand.adminNotifyEmail`). Admin-notify dispatch must stay fire-and-forget (`.catch`, never block the request/response path). `sendPushToUsers` also writes an in-app `notifications` row per user, so push == in-app feed + OS push. The amendment-submitted ("missing details provided") push intentionally still goes to all admins.
