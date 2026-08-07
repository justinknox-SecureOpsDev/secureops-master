import Module from "node:module";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Coverage for the two capabilities that make the radio usable off-screen:
 *
 *  1. the SILENT KEEP-ALIVE player — iOS only withholds suspension while the
 *     audio unit is actually rendering, and a quiet PTT channel renders
 *     nothing, so a looping silent wav runs for exactly as long as there is
 *     real radio demand. Both failure directions are regressions:
 *       - running with no demand  → orphaned background audio, battery drain,
 *         and a contradiction of the App Review disclosure (APP_REVIEW_NOTES
 *         §3 promises it stops when the officer leaves the channel);
 *       - stopping while a lost channel is still being recovered → iOS
 *         suspends the locked phone (~30s) before the retry lands, and a
 *         suspended app never retries, so the officer goes permanently deaf.
 *
 *  2. the BLUETOOTH audio-session contract — a paired headset must carry BOTH
 *     directions. These are plain config calls with no observable return, so
 *     nothing but an assertion on the arguments can stop a silent regression.
 *
 * The native modules are injected through `__setNativeRequireForTest` because
 * `nativeModules.ts` loads them with a bare CJS `require()` that vitest's
 * `vi.mock` registry does not intercept.
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
    /** Fire a LiveKit room event the way the SFU would. */
    emit(event: string, ...args: any[]): void {
      for (const cb of this.handlers[event] ?? []) cb(...args);
    }
  }

  class MockTrack {
    stop = vi.fn();
    mute = vi.fn(async () => {});
    unmute = vi.fn(async () => {});
  }

  /**
   * Mutable platform stub — tests can mutate .OS / .Version before calling
   * the code under test; the module sees the same object reference.
   */
  const platform: { OS: string; Version: number } = { OS: "android", Version: 31 };

  const permissionsAndroid = {
    PERMISSIONS: { BLUETOOTH_CONNECT: "android.permission.BLUETOOTH_CONNECT" },
    RESULTS: { GRANTED: "granted", DENIED: "denied" },
    request: vi.fn(async () => "granted"),
  };

  return { players, rooms, MockRoom, MockTrack, platform, permissionsAndroid };
});

vi.mock("react-native", () => ({
  Platform: h.platform,
  PermissionsAndroid: h.permissionsAndroid,
}));

vi.mock("@livekit/react-native", () => ({
  registerGlobals: vi.fn(),
  AudioSession: {
    configureAudio: vi.fn(async () => {}),
    startAudioSession: vi.fn(async () => {}),
    stopAudioSession: vi.fn(async () => {}),
    setAppleAudioConfiguration: vi.fn(async () => {}),
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
  throw new Error(`unexpected native require: ${name}`);
});

// `startKeepAlive()` pulls the wav through Metro's asset `require()`. Under
// vitest that reaches Node's real CJS loader, which has no `.wav` handler and
// tries to PARSE the binary as JavaScript; the production try/catch then
// swallows the SyntaxError and the player is never created, so every assertion
// below would vacuously pass. Teach the loader to return an opaque asset
// handle, exactly as Metro does on device.
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
  vi.clearAllMocks();
  // Reset platform to the most interesting default (Android 12+) so all
  // existing tests exercise the BLUETOOTH_CONNECT code path automatically.
  h.platform.OS = "android";
  h.platform.Version = 31;
  h.permissionsAndroid.request.mockResolvedValue("granted");
});

describe("NativeRadioMedia — silent keep-alive lifecycle", () => {
  it("runs the looping silent player while a channel is joined and stops it on leave", async () => {
    const media = createRadioMedia();

    await media.ensureListen("chan-1", TOKEN);
    expect(h.players).toHaveLength(1);
    const player = h.players[0];
    expect(player.loop).toBe(true);
    expect(player.play).toHaveBeenCalled();

    await media.dropListen("chan-1");
    expect(player.pause).toHaveBeenCalled();
    expect(player.remove).toHaveBeenCalled();
  });

  it("keeps the player running when the only listen room drops unexpectedly, so a locked phone survives long enough to reconnect", async () => {
    const media = createRadioMedia();
    const onLost = vi.fn();
    media.setOnListenLost(onLost);
    await media.ensureListen("chan-1", TOKEN);
    const player = h.players[0];

    h.rooms[0].emit("disconnected", "signal_error");

    expect(media.isListening("chan-1")).toBe(false);
    expect(onLost).toHaveBeenCalledWith("chan-1");
    // Recovery is pending — killing the audio unit here would let iOS suspend
    // the app before the retry, and a suspended app never retries.
    expect(player.pause).not.toHaveBeenCalled();
  });

  it("stops the player once a re-listen brings the lost channel back and it is then dropped", async () => {
    const media = createRadioMedia();
    media.setOnListenLost(vi.fn());
    await media.ensureListen("chan-1", TOKEN);
    const player = h.players[0];

    h.rooms[0].emit("disconnected", "signal_error");
    await media.ensureListen("chan-1", TOKEN); // the screen's self-heal
    expect(player.pause).not.toHaveBeenCalled();

    await media.dropListen("chan-1");
    expect(player.pause).toHaveBeenCalled();
    expect(player.remove).toHaveBeenCalled();
  });

  it("does not leave the player looping forever when the lost channel is dropped instead of recovered", async () => {
    const media = createRadioMedia();
    media.setOnListenLost(vi.fn());
    await media.ensureListen("chan-1", TOKEN);
    const player = h.players[0];

    h.rooms[0].emit("disconnected", "signal_error");
    // The screen gives up on the channel rather than re-listening.
    await media.dropListen("chan-1");

    expect(player.pause).toHaveBeenCalled();
    expect(player.remove).toHaveBeenCalled();
  });

  it("stops the player when the officer mutes or switches channel during a reconnect", async () => {
    const media = createRadioMedia();
    media.setOnListenLost(vi.fn());
    await media.ensureListen("chan-1", TOKEN);
    const player = h.players[0];

    h.rooms[0].emit("disconnected", "signal_error");

    // RadioScreen releases demand by dropping every id in listenChannelIds()
    // that it no longer wants. A channel that is only recovering has no room
    // left, so if it were missing here nothing would ever release its
    // keep-alive demand and the silent player would loop forever.
    expect(media.listenChannelIds()).toContain("chan-1");
    expect(media.isListening("chan-1")).toBe(false); // audio is NOT flowing

    const desired = new Set<string>(); // muted / switched away — nothing wanted
    for (const id of media.listenChannelIds()) {
      if (!desired.has(id)) await media.dropListen(id);
    }

    expect(player.pause).toHaveBeenCalled();
    expect(player.remove).toHaveBeenCalled();
    expect(media.listenChannelIds()).toHaveLength(0);
  });

  it("does not report a recovering channel twice once it is re-listened", async () => {
    const media = createRadioMedia();
    media.setOnListenLost(vi.fn());
    await media.ensureListen("chan-1", TOKEN);

    h.rooms[0].emit("disconnected", "signal_error");
    await media.ensureListen("chan-1", TOKEN);

    expect(media.listenChannelIds()).toEqual(["chan-1"]);
    expect(media.isListening("chan-1")).toBe(true);
  });

  it("stops the player when the recovery listener is deregistered (screen unmount)", async () => {
    const media = createRadioMedia();
    media.setOnListenLost(vi.fn());
    await media.ensureListen("chan-1", TOKEN);
    const player = h.players[0];

    h.rooms[0].emit("disconnected", "signal_error");
    expect(player.pause).not.toHaveBeenCalled();

    media.setOnListenLost(null); // nothing left to retry the channel
    expect(player.pause).toHaveBeenCalled();
  });

  it("stops the player immediately on an unexpected drop when nothing is registered to recover", async () => {
    const media = createRadioMedia();
    await media.ensureListen("chan-1", TOKEN);
    const player = h.players[0];

    h.rooms[0].emit("disconnected", "signal_error");

    expect(player.pause).toHaveBeenCalled();
  });

  it("keeps a single player across two joined channels and only stops it when the last one leaves", async () => {
    const media = createRadioMedia();

    await media.ensureListen("chan-1", TOKEN);
    await media.ensureListen("chan-2", TOKEN);
    expect(h.players).toHaveLength(1);
    const player = h.players[0];

    await media.dropListen("chan-1");
    expect(player.pause).not.toHaveBeenCalled();

    await media.dropListen("chan-2");
    expect(player.pause).toHaveBeenCalled();
  });

  it("stops the player on teardown and never restarts it", async () => {
    const media = createRadioMedia();
    media.setOnListenLost(vi.fn());
    await media.ensureListen("chan-1", TOKEN);
    const player = h.players[0];

    await media.teardown();
    expect(player.pause).toHaveBeenCalled();

    // A late reconcile after sign-out must not bring the audio unit back.
    await media.ensureListen("chan-2", TOKEN);
    expect(h.players).toHaveLength(1);
  });

  it("resumeKeepAlive replays the player after an interruption, and is a no-op with no demand", async () => {
    const media = createRadioMedia();
    await media.ensureListen("chan-1", TOKEN);
    const player = h.players[0];
    player.play.mockClear();

    media.resumeKeepAlive?.();
    expect(player.play).toHaveBeenCalled();

    await media.dropListen("chan-1");
    player.play.mockClear();
    media.resumeKeepAlive?.();
    expect(player.play).not.toHaveBeenCalled();
    expect(h.players).toHaveLength(1);
  });
});

/**
 * REGRESSION GUARD — radio audio quality.
 *
 * A Bluetooth headset-mic attempt shipped 2026-07-30 and made every
 * transmission sound robotic/underwater to every listener, with no headset
 * involved: iOS `voiceChat` mode is Apple's handset-tuned voice-processing
 * path (it fights WebRTC's own AEC/AGC/noise suppression) and Android's
 * bluetooth-first forced routing pushes capture onto narrowband voice-call
 * paths. The session config must stay minimal until headset support can be
 * gated on a headset actually being the selected route AND verified on real
 * hardware.
 */
describe("NativeRadioMedia — audio session stays minimal", () => {
  it("configures only the communication preset and speaker output", async () => {
    const media = createRadioMedia();

    await media.ensureListen("chan-1", TOKEN);

    expect(AudioSession.configureAudio).toHaveBeenCalledWith({
      android: { audioTypeOptions: { preset: "communication" } },
      ios: { defaultOutput: "speaker" },
    });
    expect(AudioSession.startAudioSession).toHaveBeenCalled();
  });

  it("never overrides the iOS category/mode (no voiceChat, no HFP Bluetooth)", async () => {
    const media = createRadioMedia();

    await media.ensureListen("chan-1", TOKEN);

    expect(AudioSession.setAppleAudioConfiguration).not.toHaveBeenCalled();
  });

  it("never forces Android audio routing or a Bluetooth-first output list", async () => {
    const media = createRadioMedia();

    await media.ensureListen("chan-1", TOKEN);

    const [config] = AudioSession.configureAudio.mock.calls[0];
    expect(config.android).not.toHaveProperty("preferredOutputList");
    expect(config.android.audioTypeOptions).not.toHaveProperty("forceHandleAudioRouting");
  });
});

describe("NativeRadioMedia — no Bluetooth permission prompt", () => {
  it("never asks for BLUETOOTH_CONNECT on Android 12+", async () => {
    // h.platform defaults to { OS: 'android', Version: 31 } via beforeEach.
    const media = createRadioMedia();
    await media.ensureListen("chan-1", TOKEN);

    // The radio no longer routes to headsets, so prompting for Bluetooth
    // access would be an unexplained dialog on first channel join.
    expect(h.permissionsAndroid.request).not.toHaveBeenCalled();
  });

  it("never asks for BLUETOOTH_CONNECT on iOS", async () => {
    h.platform.OS = "ios";
    h.platform.Version = 17;
    const media = createRadioMedia();
    await media.ensureListen("chan-1", TOKEN);

    expect(h.permissionsAndroid.request).not.toHaveBeenCalled();
  });
});
