---
name: Signed object-storage URLs allow browser CORS
description: Whether admin-portal JS can fetch() GCS signed URLs cross-origin (blob downloads with filenames)
---

Replit object storage signed URLs respond with `Access-Control-Allow-Origin: *`, so browser-side `fetch()` of a signed GET URL works cross-origin.

**Why:** Signed URLs carry no `Content-Disposition`, so plain navigation (`window.open`/anchor href) opens PDFs inline and loses the original filename. A `fetch → blob → a.download=fileName` flow is the only way to force a download with the correct name — and it is safe because the bucket's CORS allows any origin on GET (verified with an `Origin`-header curl against a live signed URL).

**How to apply:** For "Download" buttons on privately stored files, fetch a fresh signed URL from an authed API endpoint, then blob-download it client-side with the server-provided filename. Keep `openSignedObject`-style navigation for "View" (opens inline in a new tab).
