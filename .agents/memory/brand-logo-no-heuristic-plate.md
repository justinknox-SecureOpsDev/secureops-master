---
name: Brand logo — no heuristic backing plate
description: Why uploaded tenant logos must render as-is, and how to solve dark-logo-on-dark-background legibility if it ever comes up for real.
---

# Brand logo — no heuristic backing plate

Uploaded tenant logos (`logoDataUrl` from `GET /api/brand`) must render **as-is** — never wrap them in a light backing plate based on a background-color heuristic.

**Why:** A merged change once added a white plate behind any uploaded logo whenever the tenant background was dark (`contrastRatio("#ffffff", bg) >= 3`). The flagship WCSG deployment's uploaded eagle logo has its own dark background baked in, so the plate showed as ugly white edges poking out behind the logo (amplified by the login screen's 3D tilt). The background color says nothing about whether the *logo pixels* need help. Reverted on user complaint.

**How to apply:** If a tenant ever uploads a dark-on-transparent logo that's genuinely illegible on a dark background, decide legibility from the actual image pixels at **upload time** (server- or portal-side analysis: has-alpha + opaque-pixel luminance), store a flag in the brand payload (must be `.optional()` — see brand schema version skew), and let the client obey the flag. Never guess client-side from colors.

Also note: the dev web preview can't reproduce uploaded-logo rendering — dev DB has `logoDataUrl: null` (emblem path), while native/Expo Go connected to the prod org fetches prod's brand with the uploaded logo.
