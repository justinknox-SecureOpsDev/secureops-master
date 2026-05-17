/**
 * Phone number normalization to E.164.
 *
 * The SMS pipeline (sendSmsToPhoneNumber, Twilio fallback on application
 * approve) only fires when the stored phone is valid E.164 — i.e. "+"
 * followed by 8–15 digits. Public applicants type free-text like
 * "(214) 555-1234" or "214-555-1234", so without normalization the SMS
 * silently skips.
 *
 * Strategy: strip non-digit characters, then:
 *   - if input started with "+", keep the digits as-is
 *   - if input has 10 digits, assume US/+1
 *   - if input has 11 digits starting with "1", treat as US/+1
 *   - otherwise reject
 */

const E164_RE = /^\+\d{8,15}$/;

export function normalizePhoneToE164(input: string): string | null {
  if (typeof input !== "string") return null;
  const trimmed = input.trim();
  if (!trimmed) return null;
  const hadPlus = trimmed.startsWith("+");
  const digits = trimmed.replace(/\D/g, "");
  if (!digits) return null;

  let candidate: string;
  if (hadPlus) {
    candidate = `+${digits}`;
  } else if (digits.length === 10) {
    // US local: assume +1.
    candidate = `+1${digits}`;
  } else if (digits.length === 11 && digits.startsWith("1")) {
    candidate = `+${digits}`;
  } else {
    return null;
  }
  return E164_RE.test(candidate) ? candidate : null;
}

export function isE164(input: string): boolean {
  return typeof input === "string" && E164_RE.test(input);
}
