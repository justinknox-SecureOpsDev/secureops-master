import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Regression coverage for the release-during-connect safety of the admin-portal
 * radio media plane (`RadioMedia.startPublish` in `Radio.tsx`).
 *
 * Connecting a LiveKit room + creating a mic track is several awaits long. If
 * push-to-talk is released before that finishes, `startPublish` must poll its
 * `shouldAbort` callback after EVERY async step, tear down the in-flight
 * room/track it created locally, and NEVER assign the instance refs
 * (`publishRoom` / `publishTrack` / `publishChannelId`) — otherwise the room
 * would publish microphone audio AFTER the user let go.
 *
 * `livekit-client` is fully mocked so no real WebRTC / E2EE worker is needed.
 * The mocked `Room.connect` / `localParticipant.publishTrack` invoke injectable
 * hooks so a test can flip the abort flag true *during* that exact step.
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

vi.mock("livekit-client", () => {
  class ExternalE2EEKeyProvider {
    setKey = vi.fn(async () => {});
  }
  return {
    Room: h.MockRoom,
    ExternalE2EEKeyProvider,
    RoomEvent: { TrackSubscribed: "trackSubscribed", TrackUnsubscribed: "trackUnsubscribed" },
    Track: { Kind: { Audio: "audio" } },
    createLocalAudioTrack: vi.fn(async () => {
      const t = new h.MockTrack();
      h.created.tracks.push(t);
      return t;
    }),
  };
});

// makeRoom() builds an E2EE worker via `new Worker(new URL(...))`; jsdom has no
// real Worker, and we don't exercise audio, so a no-op global stub is enough.
class StubWorker {
  postMessage() {}
  terminate() {}
  addEventListener() {}
  removeEventListener() {}
}
(globalThis as unknown as { Worker: unknown }).Worker = StubWorker;

import { RadioMedia } from "../Radio";

const TOKEN = {
  token: "t",
  url: "wss://livekit.example",
  room: "room-1",
  identity: "admin-1",
  e2eeKey: "AAAA",
  e2eeKeyVersion: 1,
  canPublish: true,
  ttlSeconds: 60,
};

describe("RadioMedia.startPublish — release mid-connect", () => {
  beforeEach(() => {
    created.rooms = [];
    created.tracks = [];
    hooks.connect = undefined;
    hooks.publish = undefined;
  });

  it("tears down the in-flight room and never assigns refs when aborted during room.connect", async () => {
    const media = new RadioMedia();
    let aborted = false;
    // PTT released while room.connect() is still resolving.
    hooks.connect = () => {
      aborted = true;
    };

    await expect(
      media.startPublish("chan-1", TOKEN, () => aborted),
    ).rejects.toThrow("aborted");

    expect(created.rooms).toHaveLength(1);
    const room = created.rooms[0];
    // The room we connected must be disconnected; no track was created yet.
    expect(room.connect).toHaveBeenCalledTimes(1);
    expect(room.disconnect).toHaveBeenCalledTimes(1);
    expect(room.localParticipant.publishTrack).not.toHaveBeenCalled();
    expect(created.tracks).toHaveLength(0);
    // No publish refs were ever assigned -> nothing transmits after release.
    expect(media.publishingChannelId()).toBeNull();
  });

  it("stops the track and disconnects the room, leaving refs unassigned, when aborted during publishTrack", async () => {
    const media = new RadioMedia();
    let aborted = false;
    // PTT released while the mic track is being published.
    hooks.publish = () => {
      aborted = true;
    };

    await expect(
      media.startPublish("chan-1", TOKEN, () => aborted),
    ).rejects.toThrow("aborted");

    expect(created.rooms).toHaveLength(1);
    expect(created.tracks).toHaveLength(1);
    const room = created.rooms[0];
    const track = created.tracks[0];
    expect(room.connect).toHaveBeenCalledTimes(1);
    expect(room.localParticipant.publishTrack).toHaveBeenCalledTimes(1);
    // The in-flight mic track is stopped and the room disconnected.
    expect(track.stop).toHaveBeenCalledTimes(1);
    expect(room.disconnect).toHaveBeenCalledTimes(1);
    // publishChannelId was never assigned, so the radio is silent post-release.
    expect(media.publishingChannelId()).toBeNull();
  });

  it("positive control: a publish that is never aborted assigns the refs and stays connected", async () => {
    const media = new RadioMedia();

    await media.startPublish("chan-1", TOKEN, () => false);

    expect(created.rooms).toHaveLength(1);
    expect(created.tracks).toHaveLength(1);
    const room = created.rooms[0];
    const track = created.tracks[0];
    expect(room.localParticipant.publishTrack).toHaveBeenCalledTimes(1);
    // No teardown happened — we are live.
    expect(room.disconnect).not.toHaveBeenCalled();
    expect(track.stop).not.toHaveBeenCalled();
    expect(media.publishingChannelId()).toBe("chan-1");
  });
});
