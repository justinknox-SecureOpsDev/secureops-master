---
name: One replay-protection mechanism
description: Money-touching / non-idempotent writes must use the shared idempotency middleware — never a bespoke in-route cache.
---

# One replay-protection mechanism for non-idempotent writes

Any route that commits money or otherwise cannot be safely re-sent uses the
shared idempotency middleware in the api-server lib. Do NOT add a per-route
`Map<key, promise>` cache, even a small one.

**Why:** the payroll mark-paid and PNC-export routes each grew their own
in-route cache with their own TTL, eviction and scoping rules, in parallel with
the shared middleware used by shift/roster/approve. Two implementations of the
same idea meant a fix to one (in-flight wait, capacity ceiling, "no recorded
outcome" handling, audit-metadata marking) silently missed the other. They are
now consolidated on the middleware.

**How to apply:**
- Mount the middleware AFTER the route's auth/permission guards (keys are
  scoped by actor + method + path) and before the handler.
- The key arrives as the `Idempotency-Key` header OR an `idempotencyKey` JSON
  body field — both already supported, so a body-field caller needs no change.
- The standard replay signal is the response header. A route that predates the
  middleware and promised its callers a body flag keeps it via the middleware's
  `replayBodyFlag` option rather than by reimplementing the cache.
- Keep the route's "do the work" helper returning `{ status, body }` and let the
  handler simply respond; the middleware records whatever goes through
  `res.json`.
