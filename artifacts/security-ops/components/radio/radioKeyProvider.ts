/**
 * Radio E2EE key provider — a vendored subclass of RNKeyProvider that flips
 * `discardFrameWhenCryptorNotReady` to TRUE.
 *
 * WHY: `@livekit/react-native`'s RNKeyProvider HARDCODES
 * `discardFrameWhenCryptorNotReady: false` when it creates the native
 * RTCKeyProvider. Every PTT press publishes a brand-new track, so each
 * listener's receiver FrameCryptor is created (and keyed/enabled, both
 * async) at the moment the track arrives — with `false`, any encrypted
 * frames that land before the cryptor is ready are passed to the Opus
 * decoder UNDECRYPTED and play as loud static. That is the start-of-
 * transmission garble users hear on the radio. With `true`, the native
 * cryptor drops those frames instead: worst case is a beat of silence,
 * which the mute-until-settled publish path (radioMedia.native.ts) already
 * papers over.
 *
 * HOW: RNKeyProvider builds its native provider in its constructor and
 * RNE2EEManager only ever reads it through the `rtcKeyProvider` getter, so
 * we can construct normally, dispose the original native provider (each PTT
 * press creates one — leaking them would pile up native objects), and swap
 * in a replacement created with the identical option set except the discard
 * flag. JS-only, so it ships over OTA and survives library patch bumps; if
 * a future `@livekit/react-native` upgrade renames the private field or
 * starts honouring a discard option, revisit this file.
 *
 * OTA-COMPAT GUARD: this module must be safe to EVALUATE on App Store
 * binaries that do NOT contain the LiveKit native modules (builds ≤ 9 of the
 * 1.0.0 runtime — only build 10 has them). runtimeVersion policy is
 * `appVersion`, so a 1.0.0 OTA bundle lands on ALL of those binaries; a
 * top-level `import { RNKeyProvider } from "@livekit/react-native"` (or the
 * `class … extends RNKeyProvider` that needs it at module-eval time) would
 * throw and crash the app the moment the Radio/Chat screen loads. So the
 * native packages are required lazily and the subclass is DEFINED lazily via
 * `createRadioKeyProvider()`, mirroring the `getLiveKitNative()` pattern in
 * nativeModules.ts. Callers (radioMedia.native.ts) only invoke the
 * factory after `getLiveKitNative()` confirmed the natives are present.
 *
 * The option values below MUST mirror what RNKeyProvider's constructor
 * computes for `{ ratchetWindowSize: 0, failureTolerance: -1 }` (the radio's
 * settings — see makeRoom): same salt, magic bytes, key size and ring size,
 * or sender and receiver would derive different cryptor configs.
 */
import type { RNKeyProvider } from "@livekit/react-native";
import type {
  RTCKeyProvider,
  RTCKeyProviderOptions,
} from "@livekit/react-native-webrtc";
import type { KeyProviderOptions } from "livekit-client";

import { getLiveKitNative, getLiveKitWebRTC } from "./nativeModules";

/** The exact options the radio passes to RNKeyProvider. */
const RADIO_KEY_PROVIDER_OPTIONS = {
  // Static shared passphrase per channel — mirror the web
  // ExternalE2EEKeyProvider defaults for a non-ratcheting shared key.
  ratchetWindowSize: 0,
  failureTolerance: -1,
} as const;

type RadioKeyProviderClass = new () => RNKeyProvider;

let radioKeyProviderClass: RadioKeyProviderClass | undefined;

/**
 * Lazily build (and memoize) the RadioKeyProvider subclass, then construct an
 * instance. Requires the LiveKit native packages at call time — callers must
 * only invoke this once the natives are confirmed present (see
 * `getLiveKitNative()` in radioMedia.native.ts); if they are missing this
 * THROWS, it does not degrade.
 */
export function createRadioKeyProvider(): RNKeyProvider {
  if (!radioKeyProviderClass) {
    const lk = getLiveKitNative();
    const webrtc = getLiveKitWebRTC();
    if (!lk || !webrtc) {
      throw new Error(
        "LiveKit native modules unavailable — update the app to use live radio",
      );
    }
    const { RNKeyProvider: BaseKeyProvider } = lk;
    const { RTCFrameCryptorFactory } = webrtc;

    radioKeyProviderClass = class RadioKeyProvider extends BaseKeyProvider {
      constructor() {
        super({ ...RADIO_KEY_PROVIDER_OPTIONS });

        // Rebuild the SAME merged option object RNKeyProvider's constructor
        // produced (its defaults, our overrides), flipping only the discard flag.
        const opts: RTCKeyProviderOptions & KeyProviderOptions = {
          sharedKey: true,
          ratchetSalt: "LKFrameEncryptionKey",
          ratchetWindowSize: RADIO_KEY_PROVIDER_OPTIONS.ratchetWindowSize,
          failureTolerance: RADIO_KEY_PROVIDER_OPTIONS.failureTolerance,
          keyRingSize: 16,
          keyringSize: 16,
          discardFrameWhenCryptorNotReady: true,
          keySize: 128,
          uncryptedMagicBytes: new TextEncoder().encode("LK-ROCKS"),
        };

        // Dispose the provider the base constructor created, then swap in ours.
        // `rtcKeyProvider` is the getter RNE2EEManager reads; it returns the
        // private `nativeKeyProvider` field we replace here.
        try {
          this.rtcKeyProvider.dispose();
        } catch {
          /* best-effort — never block construction on native cleanup */
        }
        (this as unknown as { nativeKeyProvider: RTCKeyProvider }).nativeKeyProvider =
          RTCFrameCryptorFactory.createDefaultKeyProvider(opts);
      }
    };
  }
  return new radioKeyProviderClass();
}
