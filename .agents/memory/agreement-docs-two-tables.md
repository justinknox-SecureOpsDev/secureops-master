---
name: Agreement documents — two tables, one validator
description: Signed-status vs uploaded-PDF live in different tables; remote + in-app upload must share one validate/store path.
---

Platform agreement documents involve TWO distinct concerns that live in TWO tables:

- **Signatures table** (`platformAgreementSignaturesTable`) — records that a slot was *signed* (signer name/title/email, consent, document SHA of the signed copy). This is what the read-only Control Plane `/control-plane/agreements` returns.
- **Docs table** (`platformAgreementDocsTable`) — the actual uploaded PDF *file* for a slot (fileKey, fileName, uploadedBy/At, and its `documentSha256`). Uploading/replacing the PDF writes HERE, not the signatures table.

**Rule:** any path that uploads/replaces an agreement PDF (in-app super-admin page AND the Control Plane remote path) must go through the single shared helper in `artifacts/api-server/src/lib/agreementDocs.ts` (`registerAgreementDoc`), which re-downloads the object, validates PDF magic bytes + size (15 MB cap), computes the SHA-256, and upserts. Don't re-implement validation per route or the two paths drift.

**Why:** the remote-replace feature had to be indistinguishable from an in-app upload (same validation, same SHA recorded, same history). Slots come from `@workspace/legal-docs` `AGREEMENT_SLOTS` = `["msa","user_agreement"]`.

**Presigned upload flow (browser → GCS):** POST `{name,size,contentType}` → `{uploadURL, objectPath}`; PUT bytes straight to `uploadURL` (cross-origin browser→GCS PUT is fine); then register `{fileKey: objectPath, fileName}`. The Control Plane proxies the mint + register over the HMAC channel; the browser does the GCS PUT itself.
