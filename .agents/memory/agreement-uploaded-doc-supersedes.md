---
name: Uploaded agreement doc supersedes the template
description: Why an uploaded platform-agreement PDF replaces the bundled markdown everywhere, and why replacement after signing is recorded rather than blocked.
---

An uploaded PDF for a platform agreement slot (MSA / User Agreement) is the
whole agreement, not a download link next to the bundled markdown. Every
surface — review, signing digest, archived signed PDF — must resolve the slot's
active document through the one shared resolver, and a slot whose uploaded
document cannot be read is reported as unavailable (signing blocked) rather
than falling back to the template.

**Why:** the failure this prevents is a customer being shown, and signing, the
bundled wording after the platform owner replaced it. A silent template
fallback is that exact bug. An uploaded document also has fixed wording, so it
has no fill fields, no provider-value resolution and no bundled Exhibit C
guaranty — offering any of those against it would attach terms the document
does not contain.

Replacing a document after it was signed is **allowed and recorded**, not
blocked: each signature row pins the exact stored object key plus its SHA-256,
and a replacement upload lands at a NEW object path (the old object is never
deleted), so a past signature still resolves to the version it was taken
against. The signed-PDF route re-verifies the hash before assembling the copy.

**How to apply:** when adding any new agreement surface (a second portal, an
email copy, an export), resolve the active document first and branch on the
source; when touching the signature schema, keep the file key + hash together
so old signatures stay resolvable.
