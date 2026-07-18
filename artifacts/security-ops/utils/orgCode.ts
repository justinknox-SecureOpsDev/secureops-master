/**
 * Pure organization-code helpers.
 *
 * These functions are intentionally free of any React Native / Expo imports so
 * they can be unit-tested under plain Node (and reused by both the connect
 * screen and the QR scanner). The stateful, storage- and network-backed parts
 * of multi-org routing live in `orgConfig.ts`, which re-exports everything here.
 */

// Short, human-typeable codes only. Bounds the lookup and keeps junk out; NOT
// a security control (codes are not secrets).
const ORG_CODE_RE = /^[a-z0-9][a-z0-9-]{1,30}$/;

export function normalizeOrgCode(raw: string): string {
  return raw.trim().toLowerCase();
}

export function isValidOrgCode(raw: string): boolean {
  return ORG_CODE_RE.test(normalizeOrgCode(raw));
}

/**
 * Extract an organization code from an invite link, a scanned QR-code payload,
 * or a bare code string.
 *
 * Invite links / QR codes encode the org code as a `?code=<code>` query on a
 * deep link — either the app's custom scheme
 * (`secureopscommand://connect?code=acme`) or the https origin
 * (`https://.../connect?code=acme`). Both the "tap an invite link" and "scan a
 * QR code" flows funnel through here so the connect screen can prefill + resolve
 * without the user typing anything.
 *
 * Accepts (in priority order):
 *   1. anything containing a `?code=`/`&code=` query parameter,
 *   2. a bare code with no URL punctuation (e.g. "acme"),
 *   3. a URL whose final path segment is the code (e.g. ".../connect/acme").
 *
 * Returns the normalized code, or null if nothing valid is found. This never
 * trusts the payload as authentication — it is only a routing convenience and
 * the extracted code is still validated against the directory before use.
 */
export function extractOrgCodeFromDeepLink(input: string): string | null {
  if (!input) return null;
  const raw = input.trim();
  if (!raw) return null;

  let candidate: string | null = null;

  const queryMatch = raw.match(/[?&]code=([^&#\s]+)/i);
  if (queryMatch) {
    try {
      candidate = decodeURIComponent(queryMatch[1]);
    } catch {
      candidate = queryMatch[1];
    }
  } else if (!/[:/?#]/.test(raw)) {
    // No URL punctuation at all → treat the whole string as a raw code.
    candidate = raw;
  } else {
    // A URL/path with no code param → fall back to the last path segment,
    // ignoring the "connect" route segment itself.
    const path = raw.split(/[?#]/)[0];
    const seg = path.split("/").filter(Boolean).pop();
    if (seg && normalizeOrgCode(seg) !== "connect") candidate = seg;
  }

  if (!candidate) return null;
  const code = normalizeOrgCode(candidate);
  return isValidOrgCode(code) ? code : null;
}

/**
 * What the connect screen should do with an org code that arrives while the app
 * is in a given state. Kept pure (no React / RN) so the branch selection — the
 * security-critical "never re-point an already-connected backend without a
 * teardown-first switch" rule — is unit-testable.
 */
export type OrgCodeAction =
  | { kind: "connect"; code: string }
  | { kind: "switch"; code: string }
  | { kind: "same" }
  | { kind: "invalid" };

/**
 * Decide how to handle an incoming org code given the currently-connected org
 * code (or null when none is selected yet).
 *
 *   - no current org           → "connect" (ordinary first-run; the connect
 *                                 flow itself validates the code + errors inline)
 *   - current org, junk code   → "invalid" (NEVER tear down the live session for
 *                                 a bad/crafted code)
 *   - current org, same code   → "same" (already here, nothing to switch)
 *   - current org, other code  → "switch" (must go through the teardown-first
 *                                 switch flow)
 *
 * The returned `code` for "switch" is normalized; for "connect" the raw code is
 * passed through unchanged so the first-run flow can validate + surface its own
 * error message.
 */
export function decideOrgCodeAction(
  rawCode: string,
  currentOrgCode: string | null | undefined,
): OrgCodeAction {
  if (!currentOrgCode) return { kind: "connect", code: rawCode };
  const incoming = normalizeOrgCode(rawCode);
  if (!isValidOrgCode(incoming)) return { kind: "invalid" };
  if (incoming === currentOrgCode) return { kind: "same" };
  return { kind: "switch", code: incoming };
}

/**
 * Normalize a backend URL to an ORIGIN ONLY (scheme + host[:port]).
 * Rejects anything with a path/query/fragment, and anything that isn't https.
 * In production EVERY http: origin is rejected (including localhost/127.0.0.1)
 * so the app never routes credentials over plaintext; http: is permitted only
 * in dev builds (__DEV__) for local testing. Returns null if invalid.
 */
export function normalizeOrigin(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  const httpsOk = u.protocol === "https:";
  const httpDevOk =
    u.protocol === "http:" && typeof __DEV__ !== "undefined" && __DEV__;
  if (!httpsOk && !httpDevOk) return null;
  if (u.pathname !== "/" && u.pathname !== "") return null;
  if (u.search || u.hash) return null;
  return u.origin;
}
