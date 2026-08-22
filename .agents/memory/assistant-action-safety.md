---
name: AI assistant action safety
description: Invariants for any agent/assistant surface that performs writes on the user's behalf — no privileged path, card data scoped to the caller, and honesty about unverifiable outcomes.
---

# Assistant action safety

Three rules for any surface where a model performs actions for a signed-in user.

## 1. No privileged path

Actions re-enter the SAME Express app over a loopback HTTP request carrying the
caller's own `Authorization` header. The assistant never mints a token, never
elevates a role, never queries around a middleware.

**Why:** authz, the permission matrix, per-site scoping, notifications and audit
logging are all enforced in the routes. Anything that bypasses them has to
re-implement them, and re-implementations drift.

**How to apply:** if a tool needs a new capability, add/permit the route — never
a direct privileged DB write.

## 2. Confirmation cards must be built from reads made AS the caller

An approval card is model- and user-visible output. Loading a record by
arbitrary id with a direct DB query leaks it *before* the real route gets a
chance to refuse — a site manager who guesses a uuid gets a foreign officer's
name, clock times and hours rendered for them.

Card values must come from a response the caller could have fetched themselves
(their own GET route). Where no by-id route exists, a minimal internal probe may
be used ONLY to build a narrow scoped query — nothing from the probe may reach
the card.

Two further traps:

- **Do not fence out roles that have no site scope.** Dispatchers legitimately
  operate company-wide; a site-scope resolver written for *findings* returns no
  sites for them and will silently break every lookup if reused for authz.
- **Missing vs not-yours must be one indistinguishable error.** Different
  messages turn guessed uuids into an existence oracle.

When a display-only read is refused (e.g. a site manager cannot `GET
/sites/:id`), degrade the card — never block an action the route would allow.

## 3. "No explicit rate" is not "no money"

Autonomy is an allowlist, and in this codebase it is empty: creating a shift,
rostering an officer and approving a time entry all wait for a human click.

**Why:** a shift created without explicit pay/bill rates is not free — it
inherits the site defaults, and its hours reach payroll and a client invoice
regardless. Rostering a named person onto an already-priced post is the moment
the company commits to paying for it. Gating only on "did the model pass a rate
argument" lets a financial commitment through unattended.

**How to apply:** when judging whether a tool may run unattended, ask what the
action eventually costs someone, not what arguments it carried.

## 4. Lookup tools are an enumeration surface too

Every read an assistant tool performs must go through the caller's own HTTP
route, not a direct `db.select()` — even for something as dull as resolving a
name to an id.

**Why:** the assistant is gated on `requireStaff`, which admits ordinary
officers, while the staff directory route is `requireSchedulingStaff`. A direct
query inside a "find person" tool therefore hands every officer a searchable
copy of the roster that the portal itself would refuse them. Prompt rules
cannot enforce this; only the route can. Going through the route also inherits
the PII-stripped projection dispatchers and site managers already get.

**How to apply:** when auditing an assistant tool, check the middleware on the
assistant entry point against the middleware on the data it touches. A gap
between the two is the exposure.

## 5. Only a proven pre-send failure may claim "nothing was changed"

These writes are not idempotent. Once the request has left, a timeout, an abort,
a generic network error, or a failed response-body read all leave a
possibly-committed change behind.

**Why:** "it failed, try again" after a committed write is how you double-book a
shift or double-approve payroll. The house convention is 5xx/no-answer =
unconfirmed.

**How to apply:** reserve "nothing was changed" for errors proven pre-send
(ECONNREFUSED/ENOTFOUND/EAI_AGAIN, walking the `cause` chain). Everything else
is unconfirmed: tell the person to go and look, tell the model not to retry, and
keep the pending action consumed so a second click cannot re-fire it.
