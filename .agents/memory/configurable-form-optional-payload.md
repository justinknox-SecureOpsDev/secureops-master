---
name: Configurable public-form optional payload
description: When public-application fields became admin-configurable (hide/optional), the submit payload must OMIT blank optional built-ins, not send ""/0/null.
---

Rule: A config-driven public form (Apply.tsx) that lets admins hide or make
built-in fields optional must OMIT blank optional fields from the POST body —
never send placeholder defaults like `""` (enum), `0`/`Number("")` (numeric
union), or `null` (file object).

**Why:** The generated Zod request schemas (`SubmitApplicationBody`) use
`.optional()` (undefined allowed) — NOT `.nullish()`. So a hidden/optional
`idDocType:""`, `siaLicenseLevel:0`, or `i9Doc:null` fails validation with a 400
*before* the server's hidden-field-nulling logic runs. The form 400s on flows the
admin explicitly made optional.

**How to apply:** Gate every non-locked built-in field on the effective field
config (`visibleField(key)` + non-empty) and only include it when present;
coerce numbers only when the raw value is non-empty. The 5 locked core fields
(firstName, lastName, email, phone, address) are always sent. The server still
nulls hidden fields defensively, but the client must not emit invalid shapes.
