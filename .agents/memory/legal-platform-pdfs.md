---
name: Legal platform PDFs
description: How the SOBBU platform legal PDFs are produced and where they live
---

The two SOBBU-platform legal documents (Master Subscription Agreement, User Agreement) have human-editable markdown sources in `legal/*.md`. The committed `.pdf` files are GENERATED artifacts, not hand-authored.

**Rule:** there is no committed generator script. The PDFs are rendered from the markdown via `pdfkit` + `markdown-it` (a custom markdown-token → pdfkit renderer). After editing a markdown source, regenerate the PDF and write it to BOTH locations in lockstep:
- `legal/<base>.pdf` — the downloadable deliverable copy
- `artifacts/admin-portal/public/legal/<base>.pdf` — the copy served by the admin portal (Settings → "Legal & Agreements", linked as `${import.meta.env.BASE_URL}legal/<base>.pdf`)

**Why:** the portal page links directly to the served copy; updating only the deliverable copy makes the admin portal silently serve a stale PDF.

**How to apply:** in the code_execution sandbox, import pdfkit via its explicit store entry (`node_modules/.pnpm/pdfkit@<v>/node_modules/pdfkit/js/pdfkit.js`) and markdown-it via `node_modules/.pnpm/markdown-it@<v>/node_modules/markdown-it/index.mjs` — bare specifiers / directory imports fail in that sandbox. These are SOBBU (vendor) docs, so the PDF header is neutral SOBBU branding, NOT the per-tenant customer brand/logo.
