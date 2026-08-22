---
name: supertest lazy request send
description: supertest/superagent requests don't hit the server until awaited/then-ed; matters for any concurrency test.
---

Constructing a supertest request (`request(app).post(...).send(...)`) does NOT put it on
the wire. superagent's `Test` is lazy — it only fires when you `await` it, call
`.then()`, or `.end()`. Storing the unresolved `Test` in a variable to "send it now, read
the response later" does nothing; the request never starts until something consumes it.

**Why:** any test that needs two requests in flight at once (e.g. proving a concurrent
duplicate is refused while the first is still running) will hang forever waiting on a
"start" signal from a handler that was never invoked, with no obvious error — it just
times out at the test's timeout limit.

**How to apply:** to fire a request without blocking on its response, immediately chain
`const pending = req.then((r) => r);` (or `.end(cb)`) right after building it, then
`await` a separate signal (e.g. a promise the handler resolves on entry) before doing
anything that assumes the first request has reached the server.
