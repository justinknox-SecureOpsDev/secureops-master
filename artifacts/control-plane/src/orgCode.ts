/**
 * Org-code + backend-origin validation.
 *
 * The public /api/org-directory/resolve maps a short org code to a customer's
 * backend ORIGIN. A bad registry entry must never be able to point the mobile
 * app at an unsafe URL, so we normalise + validate aggressively:
 *   - codes are lowercase [a-z0-9] with internal hyphens, 2–31 chars;
 *   - the stored backend URL is reduced to its ORIGIN (scheme + host + port),
 *     dropping any path/query/fragment;
 *   - in production only https origins are accepted.
 */

export const ORG_CODE_RE = /^[a-z0-9][a-z0-9-]{1,30}$/;

export function normalizeOrgCode(input: string): string {
  return (input ?? "").trim().toLowerCase();
}

export function isValidOrgCode(input: string): boolean {
  return ORG_CODE_RE.test(normalizeOrgCode(input));
}

/**
 * Reduce an arbitrary URL to its origin. Returns null when it cannot be parsed
 * or (in prod) is not https.
 */
export function toSafeOrigin(input: string, requireHttps: boolean): string | null {
  const raw = (input ?? "").trim();
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (requireHttps && url.protocol !== "https:") return null;
  // Origin strips path/query/fragment and any userinfo.
  return url.origin;
}
