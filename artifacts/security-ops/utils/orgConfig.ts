import { storage } from "@/utils/storage";
import { DEFAULT_NATIVE_ORIGIN } from "@/utils/api";
import {
  normalizeOrgCode,
  isValidOrgCode,
  extractOrgCodeFromDeepLink,
  normalizeOrigin,
  decideOrgCodeAction,
  type OrgCodeAction,
} from "@/utils/orgCode";

// Re-export the pure code helpers (defined in orgCode.ts, which has no React
// Native imports so it stays unit-testable under plain Node) so existing
// importers of orgConfig keep working unchanged.
export {
  normalizeOrgCode,
  isValidOrgCode,
  extractOrgCodeFromDeepLink,
  normalizeOrigin,
  decideOrgCodeAction,
};
export type { OrgCodeAction };

/**
 * Multi-org client routing.
 *
 * ONE app-store build talks to MANY per-customer backends (each customer = own
 * API deployment + own DB). The user enters a short organization "code"; we
 * resolve it through a central directory to that customer's backend origin and
 * persist the choice. All backend traffic is then routed there.
 *
 * SECURITY: an org code is a routing convenience, NOT authentication. Anyone
 * who knows a code can point the app at that backend, but they still cannot do
 * anything without valid credentials for that backend. We keep codes private
 * by resolving a single code at a time (never listing all orgs) and we only
 * ever route to https origins in production.
 */

export const SELECTED_ORG_KEY = "selected_org";

export type SelectedOrg = {
  code: string;
  /** Display name shown on the connect / login screens. */
  name: string;
  /** Backend ORIGIN only (scheme + host, no trailing /api or path). */
  apiBaseUrl: string;
};

/**
 * The org every existing single-tenant user is silently migrated onto, so an
 * app update never strands a logged-in WCSG user on the /connect screen.
 */
export const LEGACY_DEFAULT_ORG: SelectedOrg = {
  code: "wcsg",
  name: "Williams Council Security Group",
  apiBaseUrl: DEFAULT_NATIVE_ORIGIN,
};

/**
 * Central directory base. Set EXPO_PUBLIC_ORG_DIRECTORY_URL to the master
 * control plane's public directory (e.g. https://<control-plane-host>/api/org-directory),
 * which resolves org codes from the live customer registry. When unset we fall
 * back to the canonical (first customer) deployment's own /api/org-directory so
 * existing builds keep working without an app rebuild. Either way the resolved
 * value is an ORIGIN only and the org code remains a routing convenience, not auth.
 */
export function directoryResolveUrl(code: string): string {
  const base =
    process.env.EXPO_PUBLIC_ORG_DIRECTORY_URL?.replace(/\/+$/, "") ||
    `${DEFAULT_NATIVE_ORIGIN}/api/org-directory`;
  return `${base}/resolve?code=${encodeURIComponent(code)}`;
}

export async function loadSelectedOrg(): Promise<SelectedOrg | null> {
  const raw = await storage.get(SELECTED_ORG_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<SelectedOrg>;
    if (!parsed || typeof parsed.apiBaseUrl !== "string") return null;
    const origin = normalizeOrigin(parsed.apiBaseUrl);
    if (!origin) return null;
    return {
      code: typeof parsed.code === "string" ? parsed.code : "",
      name:
        typeof parsed.name === "string" && parsed.name.trim() ? parsed.name : origin,
      apiBaseUrl: origin,
    };
  } catch {
    return null;
  }
}

export async function saveSelectedOrg(org: SelectedOrg): Promise<void> {
  await storage.set(SELECTED_ORG_KEY, JSON.stringify(org));
}

export async function clearSelectedOrg(): Promise<void> {
  await storage.remove(SELECTED_ORG_KEY);
}

/**
 * Resolve an org code to its backend via the central directory.
 * Returns the SelectedOrg on success, or throws a user-facing Error.
 */
export async function resolveOrgCode(rawCode: string): Promise<SelectedOrg> {
  const code = normalizeOrgCode(rawCode);
  if (!isValidOrgCode(code)) {
    throw new Error("Enter a valid organization code.");
  }
  let res: Response;
  try {
    res = await fetch(directoryResolveUrl(code), {
      headers: { Accept: "application/json" },
    });
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    throw new Error(
      `Can't reach the directory (${reason}). Check your connection and try again.`,
    );
  }
  if (res.status === 404) {
    throw new Error(
      "We couldn't find that organization code. Check it and try again.",
    );
  }
  if (!res.ok) {
    throw new Error(`Directory error (HTTP ${res.status}). Try again shortly.`);
  }
  const data = (await res.json().catch(() => null)) as
    | { code?: string; name?: string; apiBaseUrl?: string }
    | null;
  if (!data || typeof data.apiBaseUrl !== "string") {
    throw new Error("The directory returned an unexpected response.");
  }
  const origin = normalizeOrigin(data.apiBaseUrl);
  if (!origin) {
    throw new Error(
      "That organization is misconfigured (invalid backend URL). Contact support.",
    );
  }
  return {
    code: typeof data.code === "string" && data.code ? data.code : code,
    name: typeof data.name === "string" && data.name.trim() ? data.name : origin,
    apiBaseUrl: origin,
  };
}
