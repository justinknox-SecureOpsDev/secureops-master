---
name: Upload MIME octet-stream fallback
description: Why HR Apply file uploads failed with 415 and how the MIME fallback works on client + server
---

# Upload MIME allow-list vs browser octet-stream

The HR Apply / Onboard / Amend file uploads (and the authenticated presigned path)
validate against a strict server MIME allow-list (`ALLOWED_CONTENT_TYPES` in
api-server storage routes). Browsers frequently report an **empty** `file.type`
(which becomes `application/octet-stream`) for Word `.doc`/`.docx` resumes and any
file whose extension the OS hasn't registered. That type is NOT in the allow-list,
so legitimate uploads were rejected with **415 "File type not permitted"** — this
was the "file upload is not working" report.

**Fix (two layers, keep them in sync):**
- Client `lib/upload.ts` `resolveContentType(file)`: if `file.type` is empty or
  `application/octet-stream`, derive MIME from the filename extension before sending.
- Server storage routes `resolveContentType(declaredType, fileName)`: same fallback,
  using the `name` field (presigned path) or `X-File-Name` header (raw application-file
  path). Mirrors the client so the server is robust to stale/older deployed clients.

**Why:** the admin-portal is a static build in production — a client-only fix won't
reach already-deployed users until republish, so the server fallback is the real
safety net.

**Gotcha:** the raw body parser for `/storage/uploads/application-file` must use
`express.raw({ type: () => true })`, NOT `type: "*/*"`. `"*/*"` skips parsing when
there is no Content-Type header at all, leaving `req.body` unparsed → 400.

**How to apply:** if you add an accepted file type, update BOTH the allow-list and
BOTH `EXT*_CONTENT_TYPES` maps (client + server) together, or extension fallback
will silently reject the new type.
