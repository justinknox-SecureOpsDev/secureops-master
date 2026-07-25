import { afterAll, describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Regression coverage for the release-during-connect safety of the NATIVE radio
 * media plane (`NativeRadioMedia.startPublish` in `radioMedia.native.ts`).
 *
 * Mirrors the admin-portal test: connecting a LiveKit room + creating a mic
 * track spans several awaits, so if push-to-talk is released mid-connect the
 * abort poll must tear down the in-flight room/track and leave the instance
 * refs (`publishRoom` / `publishTrack` / `publishChannelId`) unassigned, or the
 * mic would keep transmitting after the user let go.
 *
 * Native diverges from web in one way worth pinning: it registers `publishRoom`
 * BEFORE `room.connect()` resolves (so a concurrent stopPublish can find it),
 * then `abortPublish` clears those refs back to null on abort. We assert the
 * post-release observable is the same: `publishingChannelId() === null` and the
 * created room/track are disconnected/stopped.
 *
 * `@livekit/react-native` and `livekit-client` are fully mocked so no native
 * WebRTC / audio session is needed under Node.
 */

const h = vi.hoisted(() => {
  const created: { rooms: any[]; tracks: any[] } = { rooms: [], tracks: [] };
  const hooks: { connect?: () => void; publish?: () => void } = {};

  class MockTrack {
    stop = vi.fn();
    mute = vi.fn(async () => {});
    unmute = vi.fn(async () => {});
  }

  class MockRoom {
    setE2EEEnabled = vi.fn(async () => {});
    on = vi.fn();
    connect = vi.fn(async () => {
      hooks.connect?.();
    });
    disconnect = vi.fn(async () => {});
    localParticipant = {
      publishTrack: vi.fn(async () => {
        hooks.publish?.();
      }),
      unpublishTrack: vi.fn(async () => {}),
    };
    constructor() {
      created.rooms.push(this);
    }
  }

  return { created, hooks, MockTrack, MockRoom };
});

const { created, hooks } = h;

vi.mock("@livekit/react-native", () => ({
  registerGlobals: vi.fn(),
  AudioSession: {
    configureAudio: vi.fn(async () => {}),
    startAudioSession: vi.fn(async () => {}),
    stopAudioSession: vi.fn(async () => {}),
  },
  RNKeyProvider: class {
    setSharedKey = vi.fn(async () => {});
    // RadioKeyProvider disposes the base provider and swaps in its own.
    rtcKeyProvider = { dispose: vi.fn() };
  },
  RNE2EEManager: class {},
  AndroidAudioTypePresets: { communication: {} },
}));

// Mocked so radioKeyProvider.ts (vendored RadioKeyProvider) never pulls the
// real react-native module chain (Flow syntax vitest cannot parse).
vi.mock("@livekit/react-native-webrtc", () => ({
  RTCFrameCryptorFactory: {
    createDefaultKeyProvider: vi.fn(() => ({ dispose: vi.fn() })),
  },
}));

// Silent keep-alive player (background-survival) — mocked so ensureSession's
// setAudioModeAsync/createAudioPlayer calls are inert under Node. The wav
// asset require() inside startKeepAlive still throws under vitest (no metro
// asset transform), which the production try/catch swallows by design.
vi.mock("expo-audio", () => ({
  setAudioModeAsync: vi.fn(async () => {}),
  createAudioPlayer: vi.fn(() => ({
    loop: false,
    play: vi.fn(),
    pause: vi.fn(),
    remove: vi.fn(),
  })),
}));

vi.mock("livekit-client", () => ({
  Room: h.MockRoom,
  RoomEvent: { Disconnected: "disconnected" },
  createLocalAudioTrack: vi.fn(async () => {
    const t = new h.MockTrack();
    h.created.tracks.push(t);
    return t;
  }),
}));

// The native modules are loaded through nativeModules.ts with a bare CJS
// `require()`, which vitest's vi.mock registry does NOT intercept — inject the
// mock modules via the test seam so the loader returns them instead of trying
// (and failing) to parse the real react-native chain under Node.
import * as liveKitMock from "@livekit/react-native";
import * as webRTCMock from "@livekit/react-native-webrtc";
// livekit-client is also loaded through the guarded seam now — its module
// evaluation needs registerGlobals()' polyfills (DOMException, …) on Hermes,
// so production code may only require it via getLiveKitClient().
import * as liveKitClientMock from "livekit-client";

import { __setNativeRequireForTest } from "../nativeModules";
import { createRadioMedia } from "../radioMedia.native";

__setNativeRequireForTest((name) => {
  if (name === "@livekit/react-native") return liveKitMock;
  if (name === "@livekit/react-native-webrtc") return webRTCMock;
  if (name === "livekit-client") return liveKitClientMock;
  throw new Error(`unexpected native require: ${name}`);
});

afterAll(() => {
  // Reset the seam (and its module caches) so this suite can't leak mocked
  // natives into any other test file in the same worker.
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

describe("NativeRadioMedia.startPublish — release mid-connect", () => {
  beforeEach(() => {
    created.rooms = [];
    created.tracks = [];
    hooks.connect = undefined;
    hooks.publish = undefined;
  });

  it("tears down the in-flight room and leaves refs unassigned when aborted during room.connect", async () => {
    const media = createRadioMedia();
    let aborted = false;
    // PTT released while room.connect() is still resolving.
    hooks.connect = () => {
      aborted = true;
    };

    await media.startPublish("chan-1", TOKEN, () => aborted);

    expect(created.rooms).toHaveLength(1);
    const room = created.rooms[0];
    expect(room.connect).toHaveBeenCalledTimes(1);
    expect(room.disconnect).toHaveBeenCalledTimes(1);
    expect(room.localParticipant.publishTrack).not.toHaveBeenCalled();
    expect(created.tracks).toHaveLength(0);
    // abortPublish nulled the refs registered before connect.
    expect(media.publishingChannelId()).toBeNull();
  });

  it("stops the track and disconnects the room, leaving refs unassigned, when aborted during publishTrack", async () => {
    const media = createRadioMedia();
    let aborted = false;
    // PTT released while the mic track is being published.
    hooks.publish = () => {
      aborted = true;
    };

    await media.startPublish("chan-1", TOKEN, () => aborted);

    expect(created.rooms).toHaveLength(1);
    expect(created.tracks).toHaveLength(1);
    const room = created.rooms[0];
    const track = created.tracks[0];
    expect(room.connect).toHaveBeenCalledTimes(1);
    expect(room.localParticipant.publishTrack).toHaveBeenCalledTimes(1);
    expect(track.stop).toHaveBeenCalledTimes(1);
    expect(room.disconnect).toHaveBeenCalledTimes(1);
    expect(media.publishingChannelId()).toBeNull();
  });

  it("aborts before connecting at all when released right after the room is made", async () => {
    const media = createRadioMedia();
    let calls = 0;
    // shouldAbort is polled several times before connect; flip true on the
    // poll that follows makeRoom() (after dropListen + ensureSession + makeRoom).
    const shouldAbort = (): boolean => {
      calls += 1;
      return calls >= 3;
    };

    await media.startPublish("chan-1", TOKEN, shouldAbort);

    expect(created.rooms).toHaveLength(1);
    const room = created.rooms[0];
    // Released before connect — the freshly-made room is torn down, never connected.
    expect(room.connect).not.toHaveBeenCalled();
    expect(room.disconnect).toHaveBeenCalledTimes(1);
    expect(media.publishingChannelId()).toBeNull();
  });

  it("positive control: a publish that is never aborted assigns the refs and stays connected", async () => {
    const media = createRadioMedia();

    await media.startPublish("chan-1", TOKEN, () => false);

    expect(created.rooms).toHaveLength(1);
    expect(created.tracks).toHaveLength(1);
    const room = created.rooms[0];
    const track = created.tracks[0];
    expect(room.localParticipant.publishTrack).toHaveBeenCalledTimes(1);
    expect(room.disconnect).not.toHaveBeenCalled();
    expect(track.stop).not.toHaveBeenCalled();
    expect(media.publishingChannelId()).toBe("chan-1");
  });
});
