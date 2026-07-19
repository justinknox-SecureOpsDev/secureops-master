import React, {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
  ReactNode,
} from "react";
import { Platform, View, ActivityIndicator, StyleSheet } from "react-native";
import { useQueryClient } from "@tanstack/react-query";
import { setBaseUrl } from "@workspace/api-client-react";

import { DEFAULT_NATIVE_ORIGIN, setRuntimeApiOrigin } from "@/utils/api";
import {
  LEGACY_DEFAULT_ORG,
  type SelectedOrg,
  loadSelectedOrg,
  saveSelectedOrg,
  clearSelectedOrg,
  resolveOrgCode,
} from "@/utils/orgConfig";
import { resetFeatureFlagsCache } from "@/hooks/useFeatures";
import { storage } from "@/utils/storage";
import { AUTH_TOKEN_KEY, AUTH_USER_KEY, runAuthLogout } from "@/contexts/AuthContext";
import { bootstrapOrg, performSwitchOrg, refreshSelectedOrg } from "@/utils/orgBootstrap";

/**
 * Multi-org routing context.
 *
 * ONE app-store build serves MANY customers, each with their own API
 * deployment + DB. This provider resolves the selected organization, applies
 * its backend everywhere, and acts as an INITIALIZATION BARRIER: it must sit
 * ABOVE AuthProvider/ChatProvider and must NOT render them until the backend
 * is applied — otherwise session restore, the chat socket, push registration,
 * and generated queries fire against the wrong (default) backend before the
 * navigation guard can redirect.
 *
 * Web is exempt: the web build always talks to its own same origin, so there
 * is no org selection and no gating.
 */

interface OrgContextType {
  org: SelectedOrg | null;
  isLoadingOrg: boolean;
  /** Resolve + persist + apply an org code. Throws a user-facing Error. */
  selectOrg: (code: string) => Promise<SelectedOrg>;
  /**
   * Select the built-in default backend WITHOUT going through the org
   * directory. This is the App Review / reviewer "Try Demo" path (Guideline
   * 2.1): a fresh install can reach the canonical backend that hosts the demo
   * account without knowing an organization code. Real users still connect by
   * code / QR via selectOrg.
   */
  selectDefaultOrg: () => Promise<SelectedOrg>;
  /**
   * Forget the current org and reset routing back to the default. This is
   * ATOMIC: it also clears the locally cached session (auth token + user) and
   * the React Query cache, so a caller can never switch backends while leaving
   * a stale session or another tenant's cached data behind.
   *
   * Callers should still call the auth logout() FIRST (to run any session
   * teardown against the CURRENT backend before we forget which backend it
   * was), then call this and route to /connect — but if a future caller
   * forgets, switchOrg still fails safe by wiping the local session + cache.
   */
  switchOrg: () => Promise<void>;
}

const OrgContext = createContext<OrgContextType | null>(null);

const IS_WEB = Platform.OS === "web";

/**
 * Apply an org's backend across every consumer: the hand-written fetch helper
 * (utils/api) and the Orval generated client (setBaseUrl), and drop any cached
 * feature flags so the next read comes from the new backend.
 *
 * setBaseUrl receives the ORIGIN (no /api) — the generated client prepends it
 * to paths that already include the "/api" segment.
 */
function applyOrgRouting(origin: string): void {
  setRuntimeApiOrigin(origin);
  setBaseUrl(origin);
  resetFeatureFlagsCache();
}

function resetOrgRouting(): void {
  setRuntimeApiOrigin(null);
  setBaseUrl(DEFAULT_NATIVE_ORIGIN);
  resetFeatureFlagsCache();
}

export function OrgProvider({ children }: { children: ReactNode }) {
  const [org, setOrg] = useState<SelectedOrg | null>(null);
  // Web never gates; native blocks until the stored org is loaded + applied.
  const [isLoadingOrg, setIsLoadingOrg] = useState(!IS_WEB);
  // QueryClientProvider sits ABOVE OrgProvider, so this is safe here; we use it
  // to purge cross-tenant cached data on an org switch.
  const queryClient = useQueryClient();

  useEffect(() => {
    if (IS_WEB) return;
    let cancelled = false;
    (async () => {
      try {
        // Legacy migration + routing application live in bootstrapOrg; it must
        // run BEFORE AuthProvider (our child) restores any session so the
        // backend is already applied. See utils/orgBootstrap.
        const selected = await bootstrapOrg({
          loadSelectedOrg,
          saveSelectedOrg,
          getAuthToken: () => storage.get(AUTH_TOKEN_KEY),
          legacyDefaultOrg: LEGACY_DEFAULT_ORG,
          applyOrgRouting,
        });
        if (!cancelled) {
          setOrg(selected);
          setIsLoadingOrg(false);
          // Fire-and-forget self-heal: re-resolve the STORED org code against
          // the directory so devices pinned to a retired backend origin (old
          // domain) quietly migrate to the current one. Never gates the UI;
          // directory failures keep the stored org untouched. See
          // refreshSelectedOrg in utils/orgBootstrap.
          if (selected) {
            void refreshSelectedOrg(selected, {
              resolveOrgCode,
              loadSelectedOrg,
              saveSelectedOrg,
              applyOrgRouting,
              onUpdated: (updated) => {
                if (!cancelled) setOrg(updated);
              },
            }).catch(() => {});
          }
        }
      } catch {
        if (!cancelled) setIsLoadingOrg(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const selectOrg = useCallback(async (code: string) => {
    const resolved = await resolveOrgCode(code);
    await saveSelectedOrg(resolved);
    applyOrgRouting(resolved.apiBaseUrl);
    setOrg(resolved);
    return resolved;
  }, []);

  const selectDefaultOrg = useCallback(async () => {
    // Bypass the directory entirely: LEGACY_DEFAULT_ORG points at the canonical
    // backend (DEFAULT_NATIVE_ORIGIN) that hosts the demo account, so an App
    // Review tester on a fresh install reaches a working demo without a code.
    await saveSelectedOrg(LEGACY_DEFAULT_ORG);
    applyOrgRouting(LEGACY_DEFAULT_ORG.apiBaseUrl);
    setOrg(LEGACY_DEFAULT_ORG);
    return LEGACY_DEFAULT_ORG;
  }, []);

  const switchOrg = useCallback(async () => {
    // Atomic teardown. Run the auth logout bridge first so AuthContext clears
    // its in-memory session (user/token/awaitingBiometric) too — switchOrg
    // can't reach that state directly because OrgProvider wraps AuthProvider.
    // Then defensively wipe the persisted session + query cache (covers the
    // case where no AuthProvider is mounted / the bridge is a no-op) before
    // performSwitchOrg forgets the org + resets routing. The result: a switch
    // can never leave a stale token, in-memory user, or another tenant's
    // cached data routed at the new backend.
    await runAuthLogout();
    await storage.remove(AUTH_TOKEN_KEY);
    await storage.remove(AUTH_USER_KEY);
    queryClient.clear();
    await performSwitchOrg({ clearSelectedOrg, resetOrgRouting });
    setOrg(null);
  }, [queryClient]);

  // INITIALIZATION BARRIER (native only): hold rendering until the backend is
  // applied. The platform palette is hardcoded here (navy/gold) because this
  // renders before the per-tenant brand and outside the themed shells.
  if (!IS_WEB && isLoadingOrg) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color="#c9a04a" />
      </View>
    );
  }

  return (
    <OrgContext.Provider value={{ org, isLoadingOrg, selectOrg, selectDefaultOrg, switchOrg }}>
      {children}
    </OrgContext.Provider>
  );
}

export function useOrg(): OrgContextType {
  const ctx = useContext(OrgContext);
  if (!ctx) throw new Error("useOrg must be used within an OrgProvider");
  return ctx;
}

const styles = StyleSheet.create({
  center: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: "#0c0a08",
  },
});
