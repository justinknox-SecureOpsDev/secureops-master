---
name: Unknown vs empty UI state
description: Why an admin surface must render "couldn't read status" differently from "nothing is stored", and how to classify a write whose outcome is unknown.
---

# "It didn't save" is usually the UI hiding a failed read

A page that renders **status-read failed**, **not loaded yet**, and **genuinely
empty** with the same markup turns every backend hiccup into a silent lie: the
user's upload/save succeeded, the follow-up refresh failed, the card fell back
to the empty/default look, and they report "it didn't take". The server logs
show nothing because nothing was wrong server-side — which sends you hunting in
the wrong layer for hours.

**Rules for any admin surface with a "current value / default fallback" card:**

1. A failed refresh must never overwrite known state. Keep the last value, set a
   separate `statusFailed` flag, and render a distinct badge ("Status
   unavailable") plus a retry — never the default/empty presentation.
2. The write response is authoritative. Apply it to local state *before* the
   confirmation refresh, so a failing refresh can't undo a successful save.
3. Errors belong on the row/card that failed, not only in a page-top banner.
   On a phone the cards stack and the banner is scrolled far off-screen, so a
   top-only error reads as "nothing happened at all".
4. Never invent the option set either. A hard-coded fallback list (roles,
   tiers, colours) rendered after a failed read looks exactly like a stored
   configuration; show the failure instead.
5. Fence in-flight reads behind a write generation counter. A GET issued before
   the write can resolve after it and re-commit pre-write data. Capture the
   generation when the read starts and discard the response if it changed.

**Classifying a failed write (never guess):**

- transport/library error before the request was sent (e.g. the storage PUT of
  a presigned upload) → definitely not saved; say so.
- HTTP 4xx → the route refused it; definitely not saved.
- HTTP 5xx or no response at all → **unknown**. A proxy 502/503 or a dropped
  connection can arrive after the server committed. Don't claim either
  outcome: re-read status and tell the user what is actually stored.

**Why:** a customer reported that replacing a platform agreement PDF "does
nothing". The upsert path was provably correct end-to-end; the request had
never reached any server, and the page rendered that failure identically to
"still on the bundled template", so there was no signal to act on.

**How to apply:** whenever a card shows "custom value or built-in default", or
whenever you add an upload/replace control to an admin page.
