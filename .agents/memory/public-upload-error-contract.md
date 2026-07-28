---
name: Public upload error contract
description: Why anonymous application uploads must return a JSON `message` on EVERY failure path, and which paths bypass the route handler.
---

# Anonymous application upload — every failure needs a `message`

The public upload client (Apply / Onboard / Amend document fields) renders the
server's `message` field when a response is not ok, and falls back to the bare
string `Upload failed (<status>)` when the body has no `message` (or isn't JSON
at all).

**Rule:** every failure path on a public upload endpoint must return JSON
carrying a human-actionable `message`.

**Why:** a bare `Upload failed (500)` is what an applicant reports as "I can't
upload a picture." It is indistinguishable from the app being broken, gives
them nothing to act on, and gives us nothing to debug — the same opaque string
covers an oversized file, a storage outage, and a redeploy restart. This
surface has now produced repeat "can't upload my licence/SSN card" reports.

**How to apply:**

- The body-size limit is enforced by `express.raw()`, which rejects **before
  the route handler runs**. Left alone it falls through to Express's default
  error handler, which returns an HTML stack trace — so the friendly 413 must
  be produced by wrapping the parser and intercepting `err.type ===
  "entity.too.large"`. A `message` added inside the route handler will never be
  reached for this case.
- The parser's HTML fallback also leaks an internal stack trace to an
  unauthenticated caller.
- Storage writes go through the Replit object-storage sidecar over the local
  network, so they fail transiently. Retry before surfacing an error; each
  attempt mints a fresh object name, so retries can't duplicate or overwrite.
- The client retries 5xx and network errors too: a backend redeploy 5xxs every
  in-flight request for a few seconds, and an applicant mid-form has no account
  and no way to come back later. Never retry 4xx — the file is wrong and
  resending cannot change that.
- Input size cap is deliberately larger than what we store: images are
  downscaled and re-encoded server-side, so a generous input bound costs
  nothing on disk, and applicants have no way to resize a photo themselves.
