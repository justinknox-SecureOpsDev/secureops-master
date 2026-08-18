---
name: Driving the admin portal in a headless browser
description: Two environment facts that block headless UI verification of the admin portal, and the shape of the workaround.
---

# Driving the admin portal in a headless browser

Two non-obvious blockers, both environment facts rather than app bugs:

1. **The admin-portal dev server has no `/api` proxy.** The app fetches relative
   `/api/...`, which works through the Replit preview but not against the raw
   vite port. Rewriting the URL with puppeteer request interception does *not*
   work around it — Chrome answers `ERR_BLOCKED_BY_CLIENT`.
2. **The API rejects unrecognized `Origin` headers** (CORS allowlist), and the
   browser stamps one on POSTs even when the page looks same-origin.

**Fix:** proxy `/api/*` to the api-server port and everything else to the vite
port, and strip the `origin`/`referer` headers before forwarding. Run the proxy
in-process with the browser script — a backgrounded shell process dies when the
bash call returns.

**Why it matters:** without this, "does the field actually save?" can only be
checked through the API, which skips the form wiring entirely.
