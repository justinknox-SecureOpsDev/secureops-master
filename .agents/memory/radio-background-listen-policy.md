---
name: Radio background listen policy
description: When an officer's phone may hold a LiveKit radio connection open — duty-gated, one designated always-on channel — and how the reconcile must release them.
---

# Rule

A phone may hold a live LiveKit **listen** connection only when:

- it is in the **foreground** (the selected channel), or
- the officer is **clocked in** AND the channel is the single admin-designated
  always-on channel (in practice Dispatch).

Off duty + backgrounded ⇒ **zero** connections. Off duty in the foreground the
radio still fully works (listen + talk) while the screen is open.

Designation is a per-channel flag set from the admin portal, exclusive on write
(setting it moves it rather than erroring), so the client can treat "first
channel with the flag" as authoritative.

**Why:** standing LiveKit subscriptions bill and drain battery around the clock;
they are only justified while someone is actually on shift, and only for the
channel an officer must not miss. The user asked for exactly this after seeing
LiveKit usage with nobody on duty.

# How to apply

- Keep the decision in the **pure, RN-free** listen-policy helper and reconcile
  to it; never scatter the conditions across effects (vitest cannot parse
  react-native's `import typeof`, so the helper must stay import-clean).
- The reconcile's **drop** phase must run unconditionally — before any
  "control WS ready / audio available" early return. Otherwise a clock-out or
  backgrounding during a WS blip strands rooms *and* the native silent
  keep-alive loop (keep-alive demand is derived from listen rooms).
- Leaving the foreground must also release an in-flight **publish** (PTT), or
  the publish room keeps the keep-alive alive outside the policy.
- The screen must react to the gateway's roster broadcast; a long-mounted phone
  otherwise keeps a stale roster and can hold open a channel that is no longer
  the designated one.
- Boot-time adoption of a default designated channel must be *decision-aware*
  (a stamp written on every explicit admin choice, on or off) — a plain
  "adopt when none is flagged" backfill re-adopts on every deploy after an
  admin deliberately clears it.
