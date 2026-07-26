---
name: Web org-connect funnel (CORS + CSP + hard-navigate)
description: The web /connect org-code funnel — why CORS-open alone fails, the CSP connect-src coupling, and the same-origin hard-navigate design.
---

# Web org-connect funnel

The mobile app (expo-router) also builds to web served at `/app/`. The marketing
site (`/`) prod-redirects to `/app/connect` so web visitors (and App Store
reviewers using code `demo`) can enter an org code. Native reaches `/connect`
via the org gate; **web is exempt from that gate**, so RootLayoutNav's no-user
guard needs an explicit `Platform.OS === "web" && top === "connect"` exception
or it bounces `/connect` → `/login` and the code screen never shows.

## Web never switches API origin in place
Web `getApiBaseUrl()` ALWAYS returns same-origin (`window.location.origin/api`).
Do NOT re-point it at the resolved backend — CORS is a strict allow-list and the
generated Orval client would go cross-origin while other helpers stay
same-origin. Instead, web connect RESOLVES the code then HARD-NAVIGATES the
browser: same-origin → `router.replace("/login")`; cross-origin →
`window.location.assign(`${resolvedOrigin}/app/`)`. At the new origin the app is
same-origin again and the user signs in there.

## CORS-open is necessary but NOT sufficient — CSP connect-src is its twin
The org-code resolve (`/api/org-directory/resolve`) is made CORS-public
(`origin:"*"`, `credentials:false`, via a path-aware `cors` delegate; every
OTHER path keeps the strict `ALLOWED_ORIGINS` allow-list with credentials). But
the browser ALSO enforces the SERVING page's CSP `connect-src`. If connect-src
is only `'self'`, the cross-origin resolve fetch is BLOCKED even though the
server allows it. So the central directory origin MUST also be in the
api-server's CSP `connect-src` (prod-only; dev has CSP off).

**Why:** the resolve fetch target is the client's hardcoded
`DEFAULT_NATIVE_ORIGIN` (`https://secureops-command.replit.app`) unless
`EXPO_PUBLIC_ORG_DIRECTORY_URL` overrides it — it does NOT depend on which
domain serves the page. So EVERY web deployment (the master on its custom
domain, and every customer origin) fetches that same cross-origin directory and
needs it in connect-src.

**How to apply:** keep the server CSP connect-src baseline origin in sync with
the client `DEFAULT_NATIVE_ORIGIN` in `artifacts/security-ops/utils/api.ts`.
Operators who override `EXPO_PUBLIC_ORG_DIRECTORY_URL` add that origin via the
`ORG_DIRECTORY_ORIGINS` env (comma-separated). The security-headers gate asserts
connect-src contains the directory origin. Any change to the funnel's fetch
target must update BOTH the CORS delegate AND CSP connect-src in lockstep, or
the browser silently blocks resolve.

## Deploy note
Reviewers hit the master (`secureopscommand.com` / `secureops-command.replit.app`).
The master needs no CORS change for its own origin but DOES need this funnel code
+ the CSP directory origin. This repo is canonical/master and propagates via git
pull → the master must be republished after merge for the live web funnel to
take effect. Never point `demo` at the real WCSG customer origin.
