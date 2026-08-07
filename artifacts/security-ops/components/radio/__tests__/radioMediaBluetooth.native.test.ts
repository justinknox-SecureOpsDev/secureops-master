import Module from "node:module";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

/**
 * Coverage for the Bluetooth HFP headset monitoring added in the
 * 2026-08-xx feature (RADIO_NATIVE_RELEASE_RUNBOOK.md §1, runtime 1.0.2+).
 *
 * Design constraints verified here:
 *
 *  No-headset path byte-for-byte unchanged:
 *   - No setAppleAudioConfiguration, no selectAudioOutput, no configureAudio
 *     with preferredOutputList when no headset is present.
 *   - No background poll. A timer can never revert BT config.
 *   - No forceHandleAudioRouting, no voiceChat mode — ever.
 *
 *  Android availability-driven state machine:
 *   - `hasBluetoothHeadsetAvailable` false→true is the TRIGGER (physical device
 *     present in device list; permission-free).
 *   - `isBluetoothHFPActive` is CONFIRMATION (active communication device).
 *   - On trigger: lazy BLUETOOTH_CONNECT request (one OS prompt, never repeated),
 *     then selectAudioOutput("bluetooth") on the running AudioSwitch instance.
 *   - On headset disconnect: selectAudioOutput("speaker") explicitly restores
 *     the baseline (not relying on AudioSwitch auto-reroute).
 *   - configureAudio with preferredOutputList is NEVER called post-start — per
 *     AudioSwitchManager.java:135, preferredOutputList is passed only to the
 *     AudioSwitch constructor; there is no post-start setter.
 *
 *  Android permission lifecycle:
 *   - Android session start (no headset) → zero permission requests.
 *   - First headset availability event → exactly one permission request.
 *   - Denied → no BT config applied, no re-prompt on subsequent events.
 *
 *  iOS active-route-driven state machine:
 *   - `isBluetoothHFPActive` false→true is the TRIGGER (iOS auto-routes on
 *     connect, so availability and active route arrive together).
 *   - On trigger: setAppleAudioConfiguration with allowBluetooth + videoChat.
 *   - On disconnect: setAppleAudioConfiguration restoring baseline.
 *   - requestBluetoothPermission never called on iOS.
 *
 *  teardown():
 *   - Removes all BT listeners, resets all BT state.
 *   - Post-teardown events are ignored.
 *
 * Strategy: `audio-route` is injected via `__setNativeRequireForTest`; the
 * mock's `addRouteChangeListener` captures callbacks so tests emit synthetic
 * events via `emitRouteChange({ hasBluetoothHeadsetAvailable, isBluetoothHFPActive })`.
 * AudioSession.selectAudioOutput is asserted for Android routing calls.
 */

const h = vi.hoisted(() => {
  type Player = {
    loop: boolean;
    play: ReturnType<typeof vi.fn>;
    pause: ReturnType<typeof vi.fn>;
    remove: ReturnType<typeof vi.fn>;
  };
  const players: Player[] = [];
  const rooms: any[] = [];

  class MockRoom {
    handlers: Record<string, ((...a: any[]) => void)[]> = {};
    setE2EEEnabled = vi.fn(async () => {});
    on = vi.fn((event: string, cb: (...a: any[]) => void) => {
      (this.handlers[event] ??= []).push(cb);
      return this;
    });
    connect = vi.fn(async () => {});
    disconnect = vi.fn(async () => {});
    localParticipant = {
      publishTrack: vi.fn(async () => {}),
      unpublishTrack: vi.fn(async () => {}),
    };
    constructor() {
      rooms.push(this);
    }
  }

  class MockTrack {
    stop = vi.fn();
    mute = vi.fn(async () => {});
    unmute = vi.fn(async () => {});
  }

  /**
   * `audio-route` native module mock.
   *
   * `platform` defaults to `"ios"` — tests that exercise Android behaviour
   * override it in their own beforeEach or inline.
   *
   * `hasBluetoothHeadsetAvailable` defaults to false; set true to simulate a
   * headset physically present in the device list (Android availability trigger).
   *
   * `isBluetoothHFPActive` defaults to false; set true to simulate the headset
   * being the active communication device (iOS trigger / Android confirmation).
   *
   * `requestBluetoothPermission` defaults to resolving true (granted). Tests
   * that verify denial override it to resolve false.
   *
   * `addRouteChangeListener` stores every registered callback so tests can
   * emit synthetic events via `emitRouteChange(...)`.
   */
  const routeChangeListeners: Array<(e: {
    hasBluetoothHeadsetAvailable: boolean;
    isBluetoothHFPActive: boolean;
  }) => void> = [];
  const routeChangeRemoveMock = vi.fn();
  const audioRoute = {
    platform: vi.fn((): string => "ios"),
    hasBluetoothHeadsetAvailable: vi.fn((): boolean => false),
    isBluetoothHFPActive: vi.fn((): boolean => false),
    requestBluetoothPermission: vi.fn(async (): Promise<boolean> => true),
    addRouteChangeListener: vi.fn(
      (cb: (e: { hasBluetoothHeadsetAvailable: boolean; isBluetoothHFPActive: boolean }) => void) => {
        routeChangeListeners.push(cb);
        return { remove: routeChangeRemoveMock };
      },
    ),
  };

  /**
   * Emit a synthetic route-change event to all registered listeners.
   *
   * `hasBluetoothHeadsetAvailable` defaults to the same value as
   * `isBluetoothHFPActive` for iOS tests (on iOS they are equal).
   * Android tests that want to test availability-only (device present but
   * not yet selected) pass only `hasBluetoothHeadsetAvailable: true`.
   */
  function emitRouteChange(
    isBluetoothHFPActive: boolean,
    hasBluetoothHeadsetAvailable = isBluetoothHFPActive,
  ): void {
    for (const cb of [...routeChangeListeners])
      cb({ isBluetoothHFPActive, hasBluetoothHeadsetAvailable });
  }

  return {
    players,
    rooms,
    MockRoom,
    MockTrack,
    audioRoute,
    routeChangeListeners,
    routeChangeRemoveMock,
    emitRouteChange,
  };
});

vi.mock("@livekit/react-native", () => ({
  registerGlobals: vi.fn(),
  /**
   * Captures the onConfigureNativeAudio callback so tests can inspect the
   * config the engine handler would produce without a real WebRTC engine.
   * Returns a mock cleanup function (simulating the real cleanup returned by
   * the real setupIOSAudioManagement).
   * Source: @livekit/react-native@2.11.0 AudioManager.ts:31–36 and
   *   index.tsx:125 (export * from './audio/AudioManager').
   */
  setupIOSAudioManagement: vi.fn(() => vi.fn()),
  AudioSession: {
    configureAudio: vi.fn(async () => {}),
    startAudioSession: vi.fn(async () => {}),
    stopAudioSession: vi.fn(async () => {}),
    setAppleAudioConfiguration: vi.fn(async () => {}),
    selectAudioOutput: vi.fn(async () => {}),
  },
  RNKeyProvider: class {
    setSharedKey = vi.fn(async () => {});
    rtcKeyProvider = { dispose: vi.fn() };
  },
  RNE2EEManager: class {},
  AndroidAudioTypePresets: { communication: { preset: "communication" } },
}));

vi.mock("@livekit/react-native-webrtc", () => ({
  RTCFrameCryptorFactory: {
    createDefaultKeyProvider: vi.fn(() => ({ dispose: vi.fn() })),
  },
}));

vi.mock("expo-audio", () => ({
  setAudioModeAsync: vi.fn(async () => {}),
  createAudioPlayer: vi.fn(() => {
    const player = { loop: false, play: vi.fn(), pause: vi.fn(), remove: vi.fn() };
    h.players.push(player);
    return player;
  }),
}));

vi.mock("livekit-client", () => ({
  Room: h.MockRoom,
  RoomEvent: { Disconnected: "disconnected" },
  createLocalAudioTrack: vi.fn(async () => new h.MockTrack()),
}));

import * as liveKitMock from "@livekit/react-native";
import * as webRTCMock from "@livekit/react-native-webrtc";
import * as liveKitClientMock from "livekit-client";
import * as expoAudioMock from "expo-audio";

import { __setNativeRequireForTest } from "../nativeModules";
import { createRadioMedia } from "../radioMedia.native";

__setNativeRequireForTest((name) => {
  if (name === "@livekit/react-native") return liveKitMock;
  if (name === "@livekit/react-native-webrtc") return webRTCMock;
  if (name === "livekit-client") return liveKitClientMock;
  if (name === "expo-audio") return expoAudioMock;
  if (name === "audio-route") return h.audioRoute;
  throw new Error(`unexpected native require: ${name}`);
});

beforeAll(() => {
  (Module as any)._extensions[".wav"] = (mod: any) => {
    mod.exports = 1;
  };
});
afterAll(() => {
  delete (Module as any)._extensions[".wav"];
  __setNativeRequireForTest(null);
});

const TOKEN = {
  token: "t",
  url: "wss://livekit.example",
  room: "room-1",
  identity: "officer-1",
  e2eeKey: "AAAA",
  e2eeKeyVersion: 1,
  canPublish: true,
  ttlSeconds: 60,
};

const AudioSession = (liveKitMock as any).AudioSession;

beforeEach(() => {
  h.players.length = 0;
  h.rooms.length = 0;
  h.routeChangeListeners.length = 0;
  vi.clearAllMocks();
  h.routeChangeRemoveMock.mockReset();
  // Default: iOS, no BT device, permission irrelevant on iOS.
  h.audioRoute.platform.mockReturnValue("ios");
  h.audioRoute.hasBluetoothHeadsetAvailable.mockReturnValue(false);
  h.audioRoute.isBluetoothHFPActive.mockReturnValue(false);
  h.audioRoute.requestBluetoothPermission.mockResolvedValue(true);
  // Re-wire addRouteChangeListener after clearAllMocks() to keep capturing.
  h.audioRoute.addRouteChangeListener.mockImplementation(
    (cb: (e: { hasBluetoothHeadsetAvailable: boolean; isBluetoothHFPActive: boolean }) => void) => {
      h.routeChangeListeners.push(cb);
      return { remove: h.routeChangeRemoveMock };
    },
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// No-headset baseline (session config must be byte-for-byte unchanged)
// ─────────────────────────────────────────────────────────────────────────────

describe("NativeRadioMedia — no-headset baseline", () => {
  it("does not call setAppleAudioConfiguration when no iOS headset is detected", async () => {
    h.audioRoute.platform.mockReturnValue("ios");
    h.audioRoute.isBluetoothHFPActive.mockReturnValue(false);
    h.audioRoute.hasBluetoothHeadsetAvailable.mockReturnValue(false);

    const media = createRadioMedia();
    await media.ensureListen("chan-1", TOKEN);
    await Promise.resolve();
    await Promise.resolve();

    expect(AudioSession.setAppleAudioConfiguration).not.toHaveBeenCalled();

    await media.teardown();
  });

  it("does not call selectAudioOutput when no Android headset is available", async () => {
    h.audioRoute.platform.mockReturnValue("android");
    h.audioRoute.hasBluetoothHeadsetAvailable.mockReturnValue(false);
    h.audioRoute.isBluetoothHFPActive.mockReturnValue(false);

    const media = createRadioMedia();
    await media.ensureListen("chan-1", TOKEN);
    await Promise.resolve();
    await Promise.resolve();

    // No selectAudioOutput call — no headset means no routing change.
    expect(AudioSession.selectAudioOutput).not.toHaveBeenCalled();
    // No BT permission requested — no headset means no trigger.
    expect(h.audioRoute.requestBluetoothPermission).not.toHaveBeenCalled();

    await media.teardown();
  });

  it("does not add preferredOutputList to Android configureAudio — preferredOutputList is constructor-only", async () => {
    // Verify: configureAudio is called only for the baseline (no BT fields),
    // never with preferredOutputList. Per AudioSwitchManager.java:135, the
    // preferredOutputList is passed to the AudioSwitch constructor at start()
    // time; there is no post-start setter, so passing it via configureAudio
    // after startAudioSession() has no effect on the running instance.
    h.audioRoute.platform.mockReturnValue("android");
    h.audioRoute.hasBluetoothHeadsetAvailable.mockReturnValue(false);
    h.audioRoute.isBluetoothHFPActive.mockReturnValue(false);

    const media = createRadioMedia();
    await media.ensureListen("chan-1", TOKEN);
    await Promise.resolve();
    await Promise.resolve();

    for (const [config] of AudioSession.configureAudio.mock.calls) {
      expect(config.android).not.toHaveProperty("preferredOutputList");
    }

    await media.teardown();
  });

  it("no setInterval is ever registered — the poll architecture has been removed entirely", async () => {
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");

    h.audioRoute.platform.mockReturnValue("ios");
    const media = createRadioMedia();
    await media.ensureListen("chan-1", TOKEN);
    await Promise.resolve();

    expect(setIntervalSpy).not.toHaveBeenCalled();

    await media.teardown();
    setIntervalSpy.mockRestore();
  });
});

// Helper: after a session starts, retrieves the onConfigureNativeAudio callback
// captured by the setupIOSAudioManagement mock, or throws if it wasn't installed.
function getCapturedEngineCallback(): (state: {
  isPlayoutEnabled: boolean;
  isRecordingEnabled: boolean;
  preferSpeakerOutput: boolean;
}) => unknown {
  const mock = (liveKitMock as any).setupIOSAudioManagement;
  const calls = mock.mock.calls;
  if (!calls.length) throw new Error("setupIOSAudioManagement was not called");
  const cb = calls[0][1];
  if (typeof cb !== "function")
    throw new Error("setupIOSAudioManagement was called without a callback");
  return cb;
}

// ─────────────────────────────────────────────────────────────────────────────
// iOS: engine-config handler (prevents LiveKit default from overwriting BT state)
// ─────────────────────────────────────────────────────────────────────────────

describe("NativeRadioMedia — iOS engine-config handler via setupIOSAudioManagement", () => {
  /**
   * After session start the handler must be installed exactly once.
   * Without it, registerGlobals()'s default applies a static config on every
   * engine enable — overwriting our BT state machine's applied config.
   */
  it("installs a setupIOSAudioManagement handler on iOS session start", async () => {
    h.audioRoute.platform.mockReturnValue("ios");

    const media = createRadioMedia();
    await media.ensureListen("chan-1", TOKEN);

    expect((liveKitMock as any).setupIOSAudioManagement).toHaveBeenCalledOnce();
    // preferSpeakerOutput=true (first arg)
    expect((liveKitMock as any).setupIOSAudioManagement.mock.calls[0][0]).toBe(true);
    // callback provided (second arg)
    expect(
      typeof (liveKitMock as any).setupIOSAudioManagement.mock.calls[0][1],
    ).toBe("function");

    await media.teardown();
  });

  it("does NOT install setupIOSAudioManagement on Android — handler is iOS-only", async () => {
    h.audioRoute.platform.mockReturnValue("android");

    const media = createRadioMedia();
    await media.ensureListen("chan-1", TOKEN);

    expect((liveKitMock as any).setupIOSAudioManagement).not.toHaveBeenCalled();

    await media.teardown();
  });

  it("handler returns BT config when btActive — engine cannot overwrite BT state mid-transmission", async () => {
    h.audioRoute.platform.mockReturnValue("ios");

    const media = createRadioMedia();
    await media.ensureListen("chan-1", TOKEN);

    // Connect BT headset → btActive=true
    h.emitRouteChange(true);
    await Promise.resolve();
    await Promise.resolve();

    const callback = getCapturedEngineCallback();
    const config = callback({ isPlayoutEnabled: true, isRecordingEnabled: true, preferSpeakerOutput: true });

    expect(config).toMatchObject({
      audioCategory: "playAndRecord",
      audioMode: "videoChat",
    });
    // Must include allowBluetooth AND allowBluetoothA2DP for HFP mic capture
    const opts = (config as any).audioCategoryOptions as string[];
    expect(opts).toContain("allowBluetooth");
    expect(opts).toContain("allowBluetoothA2DP");
    // Must NOT use voiceChat — it fights WebRTC AEC fleet-wide
    expect((config as any).audioMode).not.toBe("voiceChat");

    await media.teardown();
  });

  it("handler returns baseline (no-BT) config after disconnect — engine cannot re-apply BT options", async () => {
    h.audioRoute.platform.mockReturnValue("ios");

    const media = createRadioMedia();
    await media.ensureListen("chan-1", TOKEN);

    // Connect then disconnect
    h.emitRouteChange(true);
    await Promise.resolve();
    await Promise.resolve();
    h.emitRouteChange(false);
    await Promise.resolve();
    await Promise.resolve();

    const callback = getCapturedEngineCallback();
    // Simulate engine enabling recording after disconnect
    const config = callback({ isPlayoutEnabled: false, isRecordingEnabled: true, preferSpeakerOutput: true });

    // Must match LiveKit's default baseline exactly (AudioManager.ts:122–146,
    // preferSpeakerOutput=true, isRecordingEnabled=true).
    expect(config).toEqual({
      audioCategory: "playAndRecord",
      audioCategoryOptions: ["allowBluetooth", "mixWithOthers"],
      audioMode: "videoChat",
    });

    await media.teardown();
  });

  it("handler returns playout-only baseline when only playout is enabled (no recording)", async () => {
    h.audioRoute.platform.mockReturnValue("ios");

    const media = createRadioMedia();
    await media.ensureListen("chan-1", TOKEN);

    const callback = getCapturedEngineCallback();
    const config = callback({ isPlayoutEnabled: true, isRecordingEnabled: false, preferSpeakerOutput: true });

    // Matches LiveKit default: AudioManager.ts:133–138, isPlayoutEnabled only.
    expect(config).toEqual({
      audioCategory: "playback",
      audioCategoryOptions: ["mixWithOthers"],
      audioMode: "spokenAudio",
    });

    await media.teardown();
  });

  it("handler cleanup is called on teardown", async () => {
    h.audioRoute.platform.mockReturnValue("ios");

    const media = createRadioMedia();
    await media.ensureListen("chan-1", TOKEN);

    const cleanupFn = (liveKitMock as any).setupIOSAudioManagement.mock.results[0].value;
    expect(cleanupFn).not.toHaveBeenCalled();

    await media.teardown();

    expect(cleanupFn).toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// addRouteChangeListener subscription lifecycle (both platforms)
// ─────────────────────────────────────────────────────────────────────────────

describe("NativeRadioMedia — addRouteChangeListener subscription lifecycle", () => {
  it("registers a route-change listener when the session starts", async () => {
    h.audioRoute.platform.mockReturnValue("ios");

    const media = createRadioMedia();
    await media.ensureListen("chan-1", TOKEN);
    await Promise.resolve();

    expect(h.audioRoute.addRouteChangeListener).toHaveBeenCalled();
    await media.teardown();
  });

  it("removes the subscription on teardown", async () => {
    h.audioRoute.platform.mockReturnValue("ios");

    const media = createRadioMedia();
    await media.ensureListen("chan-1", TOKEN);
    await Promise.resolve();
    expect(h.routeChangeRemoveMock).not.toHaveBeenCalled();

    await media.teardown();
    expect(h.routeChangeRemoveMock).toHaveBeenCalled();
  });

  it("ignores route-change events after teardown", async () => {
    h.audioRoute.platform.mockReturnValue("ios");
    const media = createRadioMedia();
    await media.ensureListen("chan-1", TOKEN);
    await media.teardown();
    AudioSession.setAppleAudioConfiguration.mockClear();

    h.emitRouteChange(true);
    await Promise.resolve();
    await Promise.resolve();

    expect(AudioSession.setAppleAudioConfiguration).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// iOS: active-route-driven state machine
// ─────────────────────────────────────────────────────────────────────────────

describe("NativeRadioMedia — iOS BT: active-route trigger", () => {
  it("applies setAppleAudioConfiguration with allowBluetooth+videoChat when isBluetoothHFPActive fires true", async () => {
    h.audioRoute.platform.mockReturnValue("ios");

    const media = createRadioMedia();
    await media.ensureListen("chan-1", TOKEN);
    expect(AudioSession.setAppleAudioConfiguration).not.toHaveBeenCalled();

    h.emitRouteChange(true); // isBluetoothHFPActive=true, hasBluetoothHeadsetAvailable=true
    await Promise.resolve();
    await Promise.resolve();

    expect(AudioSession.setAppleAudioConfiguration).toHaveBeenCalledWith(
      expect.objectContaining({
        audioCategory: "playAndRecord",
        audioMode: "videoChat",
        audioCategoryOptions: expect.arrayContaining(["allowBluetooth"]),
      }),
    );
    const [config] = AudioSession.setAppleAudioConfiguration.mock.calls[0];
    expect(config.audioMode).not.toBe("voiceChat");

    await media.teardown();
  });

  it("reverts setAppleAudioConfiguration when isBluetoothHFPActive fires false after connect", async () => {
    h.audioRoute.platform.mockReturnValue("ios");

    const media = createRadioMedia();
    await media.ensureListen("chan-1", TOKEN);
    h.emitRouteChange(true);
    await Promise.resolve();
    await Promise.resolve();
    const callsAfterConnect = AudioSession.setAppleAudioConfiguration.mock.calls.length;

    h.emitRouteChange(false);
    await Promise.resolve();
    await Promise.resolve();

    expect(AudioSession.setAppleAudioConfiguration.mock.calls.length).toBeGreaterThan(callsAfterConnect);
    const [revertConfig] = AudioSession.setAppleAudioConfiguration.mock.calls[callsAfterConnect];
    expect(revertConfig.audioMode).toBe("videoChat");
    expect(revertConfig.audioCategoryOptions).toContain("allowAirPlay");

    await media.teardown();
  });

  it("never calls requestBluetoothPermission on iOS — no runtime BT permission needed", async () => {
    h.audioRoute.platform.mockReturnValue("ios");

    const media = createRadioMedia();
    await media.ensureListen("chan-1", TOKEN);
    await Promise.resolve();

    // No headset: never called.
    expect(h.audioRoute.requestBluetoothPermission).not.toHaveBeenCalled();

    // Headset connects: also never called (iOS doesn't need the permission).
    h.emitRouteChange(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(h.audioRoute.requestBluetoothPermission).not.toHaveBeenCalled();

    await media.teardown();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// iOS invariant: no timer can revert BT config
// ─────────────────────────────────────────────────────────────────────────────

describe("NativeRadioMedia — iOS: BT config immune to background timers", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("advancing 10 minutes of fake time does not revert BT config applied by a route-change event", async () => {
    vi.useFakeTimers();
    h.audioRoute.platform.mockReturnValue("ios");

    const media = createRadioMedia();
    await media.ensureListen("chan-1", TOKEN);
    await Promise.resolve();

    h.emitRouteChange(true);
    await Promise.resolve();
    await Promise.resolve();

    const callsAfterApply = AudioSession.setAppleAudioConfiguration.mock.calls.length;
    expect(callsAfterApply).toBeGreaterThan(0);

    vi.advanceTimersByTime(10 * 60 * 1000);
    await Promise.resolve();

    expect(AudioSession.setAppleAudioConfiguration.mock.calls.length).toBe(callsAfterApply);

    await media.teardown();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Android: availability-driven state machine + selectAudioOutput routing
// ─────────────────────────────────────────────────────────────────────────────

describe("NativeRadioMedia — Android BT: availability trigger + selectAudioOutput routing", () => {
  it("calls selectAudioOutput('bluetooth') when a BT headset becomes available", async () => {
    h.audioRoute.platform.mockReturnValue("android");
    h.audioRoute.hasBluetoothHeadsetAvailable.mockReturnValue(false);
    h.audioRoute.isBluetoothHFPActive.mockReturnValue(false);
    h.audioRoute.requestBluetoothPermission.mockResolvedValue(true);

    const media = createRadioMedia();
    await media.ensureListen("chan-1", TOKEN);
    await Promise.resolve();

    // Headset appears in device list (availability event, not yet active route).
    h.emitRouteChange(false, true); // isBluetoothHFPActive=false, hasBluetoothHeadsetAvailable=true
    await Promise.resolve(); // permission promise
    await Promise.resolve(); // applyBtConfig
    await Promise.resolve();

    expect(AudioSession.selectAudioOutput).toHaveBeenCalledWith("bluetooth");
    // forceHandleAudioRouting must never appear.
    for (const [cfg] of AudioSession.configureAudio.mock.calls) {
      expect(cfg.android?.audioTypeOptions).not.toHaveProperty("forceHandleAudioRouting");
    }

    await media.teardown();
  });

  it("calls selectAudioOutput('speaker') when the BT headset disconnects", async () => {
    h.audioRoute.platform.mockReturnValue("android");
    h.audioRoute.hasBluetoothHeadsetAvailable.mockReturnValue(false);
    h.audioRoute.requestBluetoothPermission.mockResolvedValue(true);

    const media = createRadioMedia();
    await media.ensureListen("chan-1", TOKEN);
    await Promise.resolve();

    // Connect.
    h.emitRouteChange(false, true);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(AudioSession.selectAudioOutput).toHaveBeenCalledWith("bluetooth");

    AudioSession.selectAudioOutput.mockClear();

    // Disconnect.
    h.emitRouteChange(false, false);
    await Promise.resolve();
    await Promise.resolve();

    expect(AudioSession.selectAudioOutput).toHaveBeenCalledWith("speaker");

    await media.teardown();
  });

  it("does NOT call configureAudio with preferredOutputList post-start — selectAudioOutput is used instead", async () => {
    // Per AudioSwitchManager.java:135, preferredDeviceList is passed to the
    // AudioSwitch constructor ONLY; there is no post-start setter.  Calling
    // configureAudio with preferredOutputList after startAudioSession() is a
    // no-op on the running AudioSwitch.  selectAudioOutput is the correct call.
    h.audioRoute.platform.mockReturnValue("android");
    h.audioRoute.hasBluetoothHeadsetAvailable.mockReturnValue(false);
    h.audioRoute.requestBluetoothPermission.mockResolvedValue(true);

    const media = createRadioMedia();
    await media.ensureListen("chan-1", TOKEN);
    AudioSession.configureAudio.mockClear();

    h.emitRouteChange(false, true); // headset available
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    for (const [cfg] of AudioSession.configureAudio.mock.calls) {
      expect(cfg.android ?? {}).not.toHaveProperty("preferredOutputList");
    }

    await media.teardown();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Android BLUETOOTH_CONNECT permission gating (lazy — on first availability)
// ─────────────────────────────────────────────────────────────────────────────

describe("NativeRadioMedia — Android BLUETOOTH_CONNECT permission gating (lazy)", () => {
  it("Android session start with no headset — listener registered, permission never requested", async () => {
    // CORE CONTRACT: no-headset Android officer must never see a prompt.
    h.audioRoute.platform.mockReturnValue("android");
    h.audioRoute.hasBluetoothHeadsetAvailable.mockReturnValue(false);
    h.audioRoute.isBluetoothHFPActive.mockReturnValue(false);

    const media = createRadioMedia();
    await media.ensureListen("chan-1", TOKEN);
    await Promise.resolve();
    await Promise.resolve();

    // Listener IS registered (detection is permission-free).
    expect(h.audioRoute.addRouteChangeListener).toHaveBeenCalled();
    // Permission must NOT have been requested — no headset was detected.
    expect(h.audioRoute.requestBluetoothPermission).not.toHaveBeenCalled();
    // No routing change.
    expect(AudioSession.selectAudioOutput).not.toHaveBeenCalled();

    await media.teardown();
  });

  it("headset becomes available — permission requested exactly once, selectAudioOutput('bluetooth') called", async () => {
    h.audioRoute.platform.mockReturnValue("android");
    h.audioRoute.hasBluetoothHeadsetAvailable.mockReturnValue(false);
    h.audioRoute.requestBluetoothPermission.mockResolvedValue(true);

    const media = createRadioMedia();
    await media.ensureListen("chan-1", TOKEN);
    await Promise.resolve();

    // No request before headset appears.
    expect(h.audioRoute.requestBluetoothPermission).not.toHaveBeenCalled();

    h.emitRouteChange(false, true); // availability trigger
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // Exactly one request.
    expect(h.audioRoute.requestBluetoothPermission).toHaveBeenCalledOnce();
    expect(AudioSession.selectAudioOutput).toHaveBeenCalledWith("bluetooth");

    // Disconnect → reconnect must NOT re-prompt.
    h.emitRouteChange(false, false);
    await Promise.resolve();
    h.emitRouteChange(false, true);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(h.audioRoute.requestBluetoothPermission).toHaveBeenCalledOnce(); // still 1

    await media.teardown();
  });

  it("permission denied — no BT config applied, second availability event does not re-prompt", async () => {
    h.audioRoute.platform.mockReturnValue("android");
    h.audioRoute.hasBluetoothHeadsetAvailable.mockReturnValue(false);
    h.audioRoute.requestBluetoothPermission.mockResolvedValue(false);

    const media = createRadioMedia();
    await media.ensureListen("chan-1", TOKEN);
    await Promise.resolve();

    expect(h.audioRoute.requestBluetoothPermission).not.toHaveBeenCalled();

    // First availability trigger → permission requested → denied.
    h.emitRouteChange(false, true);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(h.audioRoute.requestBluetoothPermission).toHaveBeenCalledOnce();
    expect(AudioSession.selectAudioOutput).not.toHaveBeenCalled();

    // Subsequent events must NOT re-prompt.
    h.emitRouteChange(false, false); // disconnect
    await Promise.resolve();
    h.emitRouteChange(false, true); // reconnect
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(h.audioRoute.requestBluetoothPermission).toHaveBeenCalledOnce(); // still 1
    expect(AudioSession.selectAudioOutput).not.toHaveBeenCalled();

    await media.teardown();
  });

  it("iOS never calls requestBluetoothPermission — permission not required", async () => {
    h.audioRoute.platform.mockReturnValue("ios");

    const media = createRadioMedia();
    await media.ensureListen("chan-1", TOKEN);
    await Promise.resolve();

    expect(h.audioRoute.addRouteChangeListener).toHaveBeenCalled();
    expect(h.audioRoute.requestBluetoothPermission).not.toHaveBeenCalled();

    h.emitRouteChange(true); // headset connects
    await Promise.resolve();
    await Promise.resolve();
    expect(h.audioRoute.requestBluetoothPermission).not.toHaveBeenCalled();

    await media.teardown();
  });
});
