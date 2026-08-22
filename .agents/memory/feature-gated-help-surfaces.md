---
name: Feature-gated help surfaces
description: Every surface that tells a user where to click must honour the tenant's feature flags, and each help article must map to at most one FeatureKey.
---

# Feature-gated help surfaces

Any surface that names a portal page must drop content whose feature the
company has not switched on: the sidebar (buildNavGroups), the assistant's
efficiency suggestions, and the assistant's how-to articles all gate on the
same FeatureKey set.

**Why:** the sidebar and the suggestion cards each filtered on their own, but
the assistant's article retrieval was pure keyword match. An admin on a plan
without payroll or invoicing got walked through Accounting tabs that are not in
their portal at all, went hunting for a page that does not exist, and concluded
the product was broken. A help surface that is not feature-aware is worse than
no help.

**How to apply:** when adding an article, suggestion, or nav item, declare the
feature it depends on. If a single article would need two keys, split it — an
article spanning a gated and an ungated subject either leaks a disabled page or
falsely reports an available one as switched off. Always-on parts of the portal
(shifts, sites, time entries, permissions, audit log) declare nothing.

Deciding to *announce* "that feature is not enabled" needs more than a keyword
hit: generic vocabulary ("shift", "officer", "client") is shared by half the
content, so a match on shared words must not trigger the notice, or every
answer sprouts an irrelevant upsell.

Sub-capabilities are separately sold even when they read as one subject: patrol
checkpoints are not part of daily activity reports, and officer availability is
not part of coverage requests. Prose that bundles them is the usual way a
"gated" article ends up explaining something the company cannot use.

Belt and braces: the standing system prompt also names every switched-off
capability, because an always-on article can reference a gated one in passing
(approving time entries feeds the draft invoice) and per-question retrieval
cannot catch that.
