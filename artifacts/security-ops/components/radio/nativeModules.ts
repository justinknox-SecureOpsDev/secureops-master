/**
 * Guarded lazy loaders for the LiveKit NATIVE packages.
 *
 * OTA-COMPAT GUARD: App Store builds ≤ 9 of the 1.0.0 runtime do NOT contain
 * `@livekit/react-native` / `@livekit/react-native-webrtc` — only build 10
 * does. runtimeVersion policy is `appVersion`, so a 1.0.0 OTA bundle lands on
 * ALL of those binaries; a top-level import of either package would throw at
 * module evaluation and crash the app the moment the Radio screen (or the
 * Chat screen that embeds it) loads.
 *
 * On first successful load of `@livekit/react-native` this also runs
 * `registerGlobals()`, which patches in the WebRTC/media primitives that the
 * pure-JS `livekit-client` expects — it must run before any Room is created.
 *
 * `__setNativeRequireForTest` exists ONLY because vitest cannot intercept a
 * bare CJS `require()` with `vi.mock` (the real react-native chain would load
 * and fail to parse); production code never calls it.
 */

export type LiveKitNativeModule = typeof import("@livekit/react-native");
export type LiveKitWebRTCModule = typeof import("@livekit/react-native-webrtc");
export type LiveKitClientModule = typeof import("livekit-client");
export type ExpoAudioModule = typeof import("expo-audio");

/**
 * Native packages that are NOT present in every binary this runtime's OTA
 * bundles are served to (see RADIO_NATIVE_RELEASE_RUNBOOK.md — "Which binaries
 * have which natives"). Each may only be loaded through its guarded lazy
 * loader; a static value import anywhere else in app code would crash older
 * installs at module evaluation. Enforced by
 * `__tests__/binaryGatedNativeImports.test.ts`.
 *
 * When a NEW native dependency is added to the binary, either add it here
 * with a guarded loader, or bump the runtime version so old binaries never
 * receive bundles that reference it.
 */
export const BINARY_GATED_NATIVE_PACKAGES: ReadonlyArray<{
  /** npm package name (subpaths are gated too). */
  package: string;
  /** Files (relative to the app root) allowed to `require()` it. */
  allowedLoaderFiles: readonly string[];
}> = [
  {
    package: "@livekit/react-native",
    allowedLoaderFiles: ["components/radio/nativeModules.ts"],
  },
  {
    package: "@livekit/react-native-webrtc",
    allowedLoaderFiles: ["components/radio/nativeModules.ts"],
  },
  {
    // Powers the silent locked-screen keep-alive player (see
    // radioMedia.native.ts). Absent from ALL store builds ≤ 10 — only loaded
    // through getExpoAudio(); when unavailable the keep-alive is disabled and
    // the radio otherwise works (foreground/backgrounded-unlocked audio).
    package: "expo-audio",
    allowedLoaderFiles: ["components/radio/nativeModules.ts"],
  },
  {
    // livekit-client is pure JS, but its MODULE EVALUATION touches browser
    // globals (DOMException, …) that Hermes only has after
    // @livekit/react-native's registerGlobals() has run. A static value
    // import evaluates before any polyfill and throws
    // "ReferenceError: Property 'DOMException' doesn't exist" on EVERY
    // native binary (and Expo Go), killing module eval for every route that
    // transitively imports it — the Radio/Chat/Live-Map screens then fail to
    // register and the app crashes (release) or bounces home (dev).
    package: "livekit-client",
    allowedLoaderFiles: ["components/radio/nativeModules.ts"],
  },
];

/** Test-only require override; when null, the real (Metro) require is used. */
let overrideRequire: ((name: string) => unknown) | null = null;

let liveKitModule: LiveKitNativeModule | null | undefined;
let webRTCModule: LiveKitWebRTCModule | null | undefined;
let liveKitClientModule: LiveKitClientModule | null | undefined;
let expoAudioModule: ExpoAudioModule | null | undefined;

/** Test-only: replace the require used for native modules and reset caches. */
export function __setNativeRequireForTest(
  fn: ((name: string) => unknown) | null,
): void {
  overrideRequire = fn;
  liveKitModule = undefined;
  webRTCModule = undefined;
  liveKitClientModule = undefined;
  expoAudioModule = undefined;
}

/**
 * `@livekit/react-native`, or null on a binary without the natives.
 * Runs registerGlobals() once on first successful load.
 */
export function getLiveKitNative(): LiveKitNativeModule | null {
  if (liveKitModule === undefined) {
    try {
      const mod = (
        overrideRequire
          ? overrideRequire("@livekit/react-native")
          : // eslint-disable-next-line @typescript-eslint/no-require-imports
            require("@livekit/react-native")
      ) as LiveKitNativeModule;
      mod.registerGlobals();
      liveKitModule = mod;
    } catch (e) {
      console.warn(
        "[radio] LiveKit native modules unavailable — live audio disabled (update the app)",
        e,
      );
      liveKitModule = null;
    }
  }
  return liveKitModule;
}

/**
 * The pure-JS `livekit-client`, or null when it cannot be safely evaluated.
 *
 * Evaluating livekit-client on Hermes REQUIRES the polyfills that
 * `@livekit/react-native`'s registerGlobals() installs (DOMException et al.),
 * so this loader forces `getLiveKitNative()` first and refuses to load the
 * client when the natives are absent — on such binaries there is no WebRTC
 * anyway, so callers degrade to the presence-only stub exactly as they do
 * for missing natives.
 */
export function getLiveKitClient(): LiveKitClientModule | null {
  if (liveKitClientModule === undefined) {
    if (!getLiveKitNative()) {
      liveKitClientModule = null;
      return null;
    }
    try {
      liveKitClientModule = (
        overrideRequire
          ? overrideRequire("livekit-client")
          : // eslint-disable-next-line @typescript-eslint/no-require-imports
            require("livekit-client")
      ) as LiveKitClientModule;
    } catch (e) {
      console.warn(
        "[radio] livekit-client failed to load — live audio disabled",
        e,
      );
      liveKitClientModule = null;
    }
  }
  return liveKitClientModule;
}

/**
 * `expo-audio`, or null on a binary without it (ALL store builds ≤ 10).
 * Powers the silent keep-alive player that stops iOS suspending the app on a
 * quiet radio channel when the phone locks. When absent the keep-alive is
 * simply disabled — live radio still works while the app is awake.
 */
export function getExpoAudio(): ExpoAudioModule | null {
  if (expoAudioModule === undefined) {
    try {
      expoAudioModule = (
        overrideRequire
          ? overrideRequire("expo-audio")
          : // eslint-disable-next-line @typescript-eslint/no-require-imports
            require("expo-audio")
      ) as ExpoAudioModule;
    } catch (e) {
      console.warn(
        "[radio] expo-audio unavailable — locked-screen keep-alive disabled (update the app)",
        e,
      );
      expoAudioModule = null;
    }
  }
  return expoAudioModule;
}

/** `@livekit/react-native-webrtc`, or null on a binary without the natives. */
export function getLiveKitWebRTC(): LiveKitWebRTCModule | null {
  if (webRTCModule === undefined) {
    try {
      webRTCModule = (
        overrideRequire
          ? overrideRequire("@livekit/react-native-webrtc")
          : // eslint-disable-next-line @typescript-eslint/no-require-imports
            require("@livekit/react-native-webrtc")
      ) as LiveKitWebRTCModule;
    } catch (e) {
      console.warn(
        "[radio] LiveKit WebRTC native module unavailable — live audio disabled (update the app)",
        e,
      );
      webRTCModule = null;
    }
  }
  return webRTCModule;
}
