---
name: PDF brand header & embedded assets
description: All api-server PDFs share one branded header; binary assets must be base64-embedded, not fs-read.
---

# PDF brand header & embedded assets

All four api-server PDF generators (incident, invoice, profile, DAR) render an identical
branded header via a single shared helper. The header draws a navy band with the gold eagle
logo badge above the gold company name, a cream subtitle, and a gold rule, then returns the Y
coordinate just below the rule. Every PDF positions its first content block relative to that
returned Y.

**Why a shared helper:** before this, each PDF duplicated an inline 80pt header block; they
drifted independently. Centralizing means brand/logo changes happen once.

**How to apply:**
- Any new PDF generator must call the shared header helper and anchor its top content off the
  returned Y — never hard-code absolute Y for the first block.
- When the band height changes, audit EVERY PDF for stale hard-coded Y constants. The invoice
  right-side meta box is the classic trap: it had a hard-coded `boxY` that overlapped the
  taller band until re-anchored to the header's returned Y. typecheck/tests will NOT catch a
  visual overlap — render a PDF and rasterize (pdftoppm, since ghostscript/magick-PDF is
  absent in this env) to verify.

**Embedded binary assets:** the api-server is esbuild-bundled to `dist/index.mjs`, so
`fs.readFileSync` against a source-tree asset path does NOT survive bundling. Logo/image bytes
the server needs at runtime must be embedded as a base64 string compiled into a `.ts` module
(Buffer.from(base64)). Wrap `doc.image(...)` in try/catch so a bad/missing asset degrades
gracefully and never breaks PDF generation.
