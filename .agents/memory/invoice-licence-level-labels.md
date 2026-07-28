---
name: Licence-level labels are duplicated client/server
description: Invoice licence-level names exist in both admin-portal and the api-server PDF builder; they must be changed together or the board and the client's PDF disagree.
---

Invoice line items carry an optional licence `level` alongside `hours`, and the
level name is rendered on four surfaces: the admin invoice board, the
send-review dialog, the client portal, and the invoice PDF.

The first three share one helper module in the admin portal. The PDF **cannot**
import it — it is generated in api-server — so the label map is deliberately
duplicated there.

**Why:** a rename applied to only one copy produces an invoice board that
disagrees with the PDF the client receives, which looks like a billing error to
the customer. This actually happened with level 4: the shared helper said
"L4/PPO" while a leftover inline map in the send dialog still said "L4".

**How to apply:**
- Changing or adding a licence-level name means editing **both** copies.
- A parity test reads the server map out of the PDF source and asserts it
  matches the client helper, so drift fails the admin-portal suite rather than
  reaching a client.
- Never re-introduce a local inline `{1: ..., 2: ...}` level map in an invoice
  surface; call the shared helper. Non-invoice surfaces (e.g. shift views) use
  their own, more verbose convention ("L2 Unarmed") on purpose — do not unify
  them without checking, as they are not covered by the parity test.
- Levels outside the map fall back to `L<n>` on both sides, so an unrecognised
  level degrades to something readable instead of blank.
