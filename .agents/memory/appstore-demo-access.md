---
name: App Store demo-account access (Guideline 2.1)
description: Why the reviewer's demo sign-in can fail and how to actually fix it
---

When Apple rejects under **Guideline 2.1 — "could not sign in with the demo account"** (guest@secureops.com / Demo123!), the fix is almost always **server-side, not a new iOS build**.

**Why:**
- The iOS binary only needs to (a) reach the right backend and (b) show a working sign-in. The reviewer path is one tap: Connect screen → "No code? Try the demo" (`handleTryDemo`, `app/connect.tsx`) → `/login?demo=1` which auto-signs-in. Manual entry of the demo creds also works. The backend it hits is `DEFAULT_NATIVE_ORIGIN` = this project's live deployment (see production-domain.md), where demo login returns 200.
- The demo accounts are re-seeded/self-healed on every boot (`seedDemoUsers` resets password + reactivates), so they work "now" even if they broke earlier.
- The real trap: **the reviewer tests "Delete Account" (Guideline 5.1.1(v)) on the shared demo account.** `POST /auth/delete-account` DEACTIVATES normal users but must skip that for demo emails (the `isDemo` branch only revokes the session, never sets `status:'inactive'`). If the **live deployment predates that guard**, a reviewer's own deletion test switches the demo account off and it stays off until the next boot → the very 2.1 rejection.

**How to apply:** Verify demo login against the live backend with curl. If it works, the fix for a 2.1 rejection is: **republish the backend** (guarantees the `isDemo` delete-guard is live and re-seeds the demo account fresh), wait until healthy, THEN reply in Resolution Center with the one-tap steps + creds and let the SAME build be re-reviewed. Only build a new binary if the submitted build's baked `DEFAULT_NATIVE_ORIGIN` points at the wrong/old backend (check the build's commit vs the 2026-06-24 domain change).
