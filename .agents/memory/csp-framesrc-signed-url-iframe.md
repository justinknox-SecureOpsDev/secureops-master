---
name: CSP frame-src vs direct signed-URL iframes
description: Why a document preview iframe renders blank in production but fine in dev
---

The production Content-Security-Policy (`artifacts/api-server/src/app.ts`, disabled entirely in dev/test) governs `<iframe>` loading via the `frame-src` directive, separately from `img-src`/`connect-src`.

Two different patterns exist in this codebase for previewing a privately-stored PDF in an iframe:
1. **Fetch + blob** (e.g. `AgreementSign.tsx`): authenticated `fetch()` of a same-origin API route → `Blob` → `URL.createObjectURL()` → `<iframe src={blobUrl}>`. Only needs `frame-src: blob:`.
2. **Direct signed URL** (e.g. onboarding's `PolicyAck` in `Onboard.tsx`): `<iframe src={policy.viewUrl}>` where `viewUrl` is a GCS signed download URL (cross-origin https, no auth header available/needed). This needs `frame-src` to include `https:`, not just `'self'`/`blob:`.

**Why:** `frame-src` was written assuming every iframe used pattern 1, but the public onboarding page (no bearer token to attach) uses pattern 2. The mismatch made the SOP/employee-agreement document preview silently render blank in production only — checkbox/signing still worked, so users could sign without ever seeing the rendered document. `img-src` already allows `https:` for the same signed downloads (see its comment), so widening `frame-src` the same way is consistent with existing intent.

**How to apply:** Before adding any new direct-signed-URL `<iframe src=...>`, check `frame-src` in `app.ts` allows the URL's scheme. If it's the fetch+blob pattern instead, `blob:` alone suffices — no CSP change needed. Either way, verify with the `security-headers` workflow (`check-security-headers.ts`) which only asserts presence of specific expected substrings, so it won't catch a policy that's *too narrow* — visual/functional testing in a prod-like environment (or code review) is the real check for that.
