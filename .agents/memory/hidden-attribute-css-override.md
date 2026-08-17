---
name: hidden attribute silently overridden by author display CSS
description: Why an element with the HTML `hidden` attribute can still render, and the one-line fix.
---

An element toggled via the `hidden` DOM property/attribute can still render fully visible if any author stylesheet sets a `display` value on it (e.g. `.modal { display: flex; }`) — even though the user-agent stylesheet has `[hidden] { display: none; }`. CSS cascade origin priority puts author-normal rules above user-agent-normal rules regardless of specificity ties, so the author's `display: flex` wins and the `hidden` attribute is silently ignored.

**Symptom:** a dialog/modal/panel that JS opens and closes via `el.hidden = true/false` appears open immediately on page load, before any JS has run, often stacked on top of unrelated content (e.g. a login form) and blocking all interaction with whatever is behind it.

**Fix:** add an explicit override for that selector: `.modal[hidden] { display: none; }` (must match the specific selector that sets `display`, not just rely on `[hidden]` alone).

**How to apply:** when auditing or building any hand-rolled (non-framework) modal/dialog/dropdown CSS that mixes a `display` declaration with `hidden`-attribute-based visibility toggling in JS, check for this pattern — it can hide silently until someone actually looks at the rendered page.
