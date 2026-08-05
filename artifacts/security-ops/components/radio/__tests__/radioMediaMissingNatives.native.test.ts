import { afterAll, describe, it, expect, vi } from "vitest";

/**
 * OTA-compat regression: App Store builds ≤ 9 of runtime 1.0.0 do NOT contain
 * the LiveKit native modules, yet (runtimeVersion policy `appVersion`) they
 * receive every 1.0.0 OTA bundle. A July 2026 OTA that statically imported
 * `@livekit/react-native` (and called registerGlobals() at module eval)
 * crashed those installs the moment the Radio screen — or the Chat screen
 * that embeds it — loaded.
 *
 * These tests pin the guard: with BOTH LiveKit native packages throwing at
 * require time (exactly what happens on a binary whose native image lacks
 * them), evaluating `radioMedia.native.ts` must not throw, and
 * `createRadioMedia()` must degrade to a presence-only media object
 * (`supportsAudio === false`, `degradedReason === "missing_natives"`) whose
 * methods are all safe no-ops.
 */

// Block the real react-native from loading (Flow `import typeof` syntax is
// unparseable by Rollup/vitest); radioMedia.native.ts imports Platform and
// PermissionsAndroid from it, so a minimal stub is enough for these tests.
vi.mock("react-native", () => ({
  Platform: { OS: "android", Version: 31 },
  PermissionsAndroid: {
    PERMISSIONS: { BLUETOOTH_CONNECT: "android.permission.BLUETOOTH_CONNECT" },
    RESULTS: { GRANTED: "granted" },
    request: vi.fn(async () => "granted"),
  },
}));

// expo-audio is ALSO absent on those binaries.
vi.mock("expo-audio", () => {
  throw new Error("Cannot find native module 'ExpoAudio' (simulated old binary)");
});

import { __setNativeRequireForTest } from "../nativeModules";
import { createRadioMedia } from "../radioMedia.native";

// Simulate the old binary: every LiveKit native require throws, exactly like
// a device whose native image lacks the modules. This exercises the real
// try/catch degrade path in nativeModules.ts.
__setNativeRequireForTest((name) => {
  throw new Error(`Cannot find native module '${name}' (simulated old binary)`);
});

afterAll(() => {
  // Reset the seam (and its module caches) so this suite can't leak the
  // "natives missing" state into any other test file in the same worker.
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

describe("radioMedia.native without LiveKit natives (builds ≤ 9)", () => {
  it("module evaluation + createRadioMedia() do not throw", () => {
    expect(() => createRadioMedia()).not.toThrow();
  });

  it("degrades to a presence-only media object", () => {
    const media = createRadioMedia();
    expect(media.supportsAudio).toBe(false);
    expect(media.degradedReason).toBe("missing_natives");
    expect(media.listenChannelIds()).toEqual([]);
    expect(media.isListening("c1")).toBe(false);
    expect(media.publishingChannelId()).toBeNull();
  });

  it("all async methods resolve as no-ops (nothing touches the natives)", async () => {
    const media = createRadioMedia();
    media.setOnListenLost(() => {});
    await expect(media.ensureListen("c1", TOKEN)).resolves.toBeUndefined();
    await expect(media.dropListen("c1")).resolves.toBeUndefined();
    await expect(media.startPublish("c1", TOKEN)).resolves.toBeUndefined();
    await expect(media.stopPublish()).resolves.toBeUndefined();
    await expect(media.teardown()).resolves.toBeUndefined();
    // Still no rooms or publish state after the calls.
    expect(media.listenChannelIds()).toEqual([]);
    expect(media.publishingChannelId()).toBeNull();
  });
});
