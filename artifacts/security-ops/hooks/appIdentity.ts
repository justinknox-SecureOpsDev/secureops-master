// Pure builder for the app-identity self-report the mobile app POSTs to the
// backend on every launch (and alongside push-token registration). Kept free
// of any react-native / expo imports so vitest can test it without dragging
// the native module chain (RN's `import typeof` syntax breaks vitest parsing).

export type AppIdentityInput = {
  projectId: string | undefined;
  version: string | undefined;
  iosBuildNumber: string | undefined;
  androidVersionCode: number | string | undefined;
  platformOS: string;
};

export type AppIdentityPayload = {
  projectId: string;
  appVersion: string | null;
  buildNumber: string | null;
  platform: string;
};

/**
 * Assemble the identity payload for POST /auth/app-identity. Returns null
 * when no EAS project id is resolvable (e.g. Expo Go dev sessions) — the
 * project id is the authoritative "which app is this" signal, so a report
 * without one is useless to the server.
 */
export function buildAppIdentity(input: AppIdentityInput): AppIdentityPayload | null {
  if (!input.projectId) return null;
  const build =
    input.platformOS === "android"
      ? input.androidVersionCode != null
        ? String(input.androidVersionCode)
        : null
      : (input.iosBuildNumber ?? null);
  return {
    projectId: input.projectId,
    appVersion: input.version ?? null,
    buildNumber: build,
    platform: input.platformOS,
  };
}
