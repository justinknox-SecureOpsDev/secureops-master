---
name: Headless test login rate limit
description: Repeated logins during headless browser checks trip the per-email login limiter; how to recognize and clear it.
---

Repeated admin logins (curl + headless browser runs) trip the login rate limiter (10 / 15 min per IP AND per email). Symptom is confusing: the portal silently shows the login page again (or the form shows "Too many attempts"), making it look like a rendering/auth bug in your feature.

**Why:** the limiter counts every login attempt, and iterative test-debug loops easily exceed 10 in 15 minutes.

**How to apply:** if a previously working headless flow suddenly can't get past login, check for a 429 on `/api/auth/login` before debugging the UI. The limiter store is in-process memory — restarting the api-server workflow clears it instantly. Prefer one API login per test run and reuse the token.
