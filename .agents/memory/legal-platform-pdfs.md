---
name: Legal platform PDFs
description: How the SOBBU platform legal PDFs/templates are produced and where they live
---

The two SOBBU-platform legal documents (Master Subscription Agreement, User Agreement) have human-editable markdown sources in `legal/*.md`. The committed `.pdf` files AND the embedded templates in `lib/legal-docs/src/templates.generated.ts` are GENERATED artifacts, not hand-authored.

**Rule:** after editing a markdown source, run `pnpm --filter @workspace/scripts run generate-legal-pdfs`. It regenerates in lockstep:
- `legal/<base>.pdf` — the downloadable deliverable copy
- `artifacts/admin-portal/public/legal/<base>.pdf` — the copy served by the admin portal (Settings → "Legal & Agreements", linked as `${import.meta.env.BASE_URL}legal/<base>.pdf`)
- `lib/legal-docs/src/templates.generated.ts` — embedded template strings used by the in-app fill/sign flow (server + portal)

A staleness-guard test (`scripts/src/legalTemplates.test.ts`) fails the test gate if templates.generated.ts drifts from `legal/*.md`.

**Why:** the portal page links directly to the served copy and the signing flow renders from the embedded template; updating only one copy makes the others silently stale.

**How to apply:** edit only `legal/*.md`, run the generator, commit all outputs together. These are SOBBU (vendor) docs, so the PDF header is neutral SOBBU branding, NOT the per-tenant customer brand/logo. Fillable tokens in the markdown are bracketed `[ALL-CAPS]` strings (e.g. `[CUSTOMER LEGAL NAME]`) declared in `lib/legal-docs/src/fields.ts`; adding a token requires a matching field definition or fill/sign validation fails. Also: any new api-server router must be registered on a featureGating.test.ts allow-list (core vs self-gated) or the ungated-router guard fails the test gate.
