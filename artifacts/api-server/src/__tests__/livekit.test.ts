import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { TokenVerifier } from "livekit-server-sdk";
import {
  isLiveKitConfigured,
  getLiveKitUrl,
  radioRoomName,
  deriveChannelE2eeKey,
  mintSubscribeToken,
  mintPublishToken,
  LiveKitNotConfiguredError,
  RADIO_E2EE_KEY_VERSION,
} from "../lib/livekit";

// Dummy LiveKit credentials — never hit a real server. The token helpers
// only sign locally; TokenVerifier validates with the same secret.
const URL = "wss://test.livekit.cloud";
const KEY = "APItestkey";
const SECRET = "test-livekit-secret-at-least-32-characters-long";

function setLiveKit(): void {
  process.env.LIVEKIT_URL = URL;
  process.env.LIVEKIT_API_KEY = KEY;
  process.env.LIVEKIT_API_SECRET = SECRET;
}
function clearLiveKit(): void {
  delete process.env.LIVEKIT_URL;
  delete process.env.LIVEKIT_API_KEY;
  delete process.env.LIVEKIT_API_SECRET;
}

afterAll(clearLiveKit);

describe("deriveChannelE2eeKey", () => {
  it("is deterministic for the same channel + version", () => {
    expect(deriveChannelE2eeKey("chan-a")).toBe(deriveChannelE2eeKey("chan-a"));
  });

  it("differs per channel and per version", () => {
    expect(deriveChannelE2eeKey("chan-a")).not.toBe(deriveChannelE2eeKey("chan-b"));
    expect(deriveChannelE2eeKey("chan-a", 1)).not.toBe(deriveChannelE2eeKey("chan-a", 2));
  });

  it("derives a 256-bit (32-byte) key", () => {
    expect(Buffer.from(deriveChannelE2eeKey("chan-a"), "base64")).toHaveLength(32);
  });

  it("requires SESSION_SECRET", () => {
    const orig = process.env.SESSION_SECRET;
    delete process.env.SESSION_SECRET;
    try {
      expect(() => deriveChannelE2eeKey("chan-a")).toThrow(/SESSION_SECRET/);
    } finally {
      process.env.SESSION_SECRET = orig;
    }
  });
});

describe("isLiveKitConfigured / getLiveKitUrl", () => {
  afterEach(clearLiveKit);

  it("is false when any credential is missing", () => {
    clearLiveKit();
    expect(isLiveKitConfigured()).toBe(false);
    process.env.LIVEKIT_URL = URL;
    process.env.LIVEKIT_API_KEY = KEY;
    // secret still missing
    expect(isLiveKitConfigured()).toBe(false);
  });

  it("is true once all three are set, and exposes the url", () => {
    setLiveKit();
    expect(isLiveKitConfigured()).toBe(true);
    expect(getLiveKitUrl()).toBe(URL);
  });
});

describe("token minting", () => {
  const verifier = new TokenVerifier(KEY, SECRET);

  beforeEach(setLiveKit);
  afterEach(clearLiveKit);

  it("mints a subscribe-only token (canPublish false)", async () => {
    const result = await mintSubscribeToken({ channelId: "c1", userId: "u1", displayName: "Jane Doe" });

    expect(result.url).toBe(URL);
    expect(result.room).toBe(radioRoomName("c1"));
    expect(result.identity).toBe("u1");
    expect(result.canPublish).toBe(false);
    expect(result.e2eeKeyVersion).toBe(RADIO_E2EE_KEY_VERSION);
    expect(result.e2eeKey).toBe(deriveChannelE2eeKey("c1"));

    const claims = await verifier.verify(result.token);
    expect(claims.sub).toBe("u1");
    expect(claims.video?.roomJoin).toBe(true);
    expect(claims.video?.room).toBe("radio-c1");
    expect(claims.video?.canSubscribe).toBe(true);
    expect(claims.video?.canPublish).toBe(false);
  });

  it("mints a short-lived publish token (canPublish true) under the #pub identity", async () => {
    const result = await mintPublishToken({ channelId: "c1", userId: "u1", displayName: "Jane Doe" });

    expect(result.canPublish).toBe(true);
    expect(result.ttlSeconds).toBe(90);
    // Publish connections use a distinct identity so post-release eviction
    // can never kick the same user's listen room (same-identity race).
    expect(result.identity).toBe("u1#pub");

    const claims = await verifier.verify(result.token);
    expect(claims.sub).toBe("u1#pub");
    expect(claims.video?.canPublish).toBe(true);
    expect(claims.video?.room).toBe("radio-c1");
  });

  it("rejects when LiveKit is not configured", async () => {
    clearLiveKit();
    await expect(mintSubscribeToken({ channelId: "c1", userId: "u1", displayName: "Jane" })).rejects.toBeInstanceOf(
      LiveKitNotConfiguredError,
    );
  });
});
