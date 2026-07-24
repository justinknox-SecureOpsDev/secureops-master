/**
 * Shared contract for the radio media plane, kept platform-agnostic so the
 * native and web implementations can be Metro-resolved interchangeably from
 * `./radioMedia` while RadioScreen stays unaware of which one it got.
 *
 * Our `/api/ws/radio` socket remains the CONTROL plane (membership, the
 * single-speaker lock, presence and audit). Live audio rides one
 * end-to-end-encrypted LiveKit room per channel — never this app's servers,
 * never recorded.
 */

/** Token payload from the radio LiveKit endpoints (subscribe or publish). */
export type RadioToken = {
  token: string;
  url: string;
  room: string;
  identity: string;
  e2eeKey: string;
  e2eeKeyVersion: number;
  canPublish: boolean;
  ttlSeconds: number;
};

export interface RadioMedia {
  /**
   * Whether this build can actually carry live audio. Native (LiveKit) = true.
   * The Expo-web stub = false (the real web radio client is the admin portal),
   * so the screen degrades to presence-only without trying to fetch tokens.
   */
  readonly supportsAudio: boolean;
  /**
   * WHY audio is unsupported, when it is. `"missing_natives"` = a native
   * binary that predates the LiveKit native modules (App Store builds ≤ 9)
   * received this JS bundle over OTA — the screen tells the user to update
   * the app from the App Store. Absent/undefined on the Expo-web stub (which
   * points at the native app / admin portal instead) and on full native.
   */
  readonly degradedReason?: "missing_natives";
  listenChannelIds(): string[];
  isListening(channelId: string): boolean;
  publishingChannelId(): string | null;
  /**
   * Register a callback fired when a LISTEN room disconnects UNEXPECTEDLY
   * (server eviction, network drop, SFU restart) — i.e. not via dropListen/
   * teardown. The screen uses it to re-run its listen-reconcile effect, which
   * otherwise has no dependency that changes when a room silently dies (the
   * user would stay deaf on the channel until they switch channels or PTT).
   */
  setOnListenLost(cb: ((channelId: string) => void) | null): void;
  ensureListen(channelId: string, token: RadioToken): Promise<void>;
  dropListen(channelId: string): Promise<void>;
  /**
   * Connect a publish room and start sending the mic. `shouldAbort` is polled
   * across every async step (token already fetched, room connected, mic track
   * created) so a release/disconnect mid-connect tears the room down instead of
   * transmitting after the user let go of push-to-talk.
   */
  startPublish(
    channelId: string,
    token: RadioToken,
    shouldAbort?: () => boolean,
  ): Promise<void>;
  stopPublish(): Promise<void>;
  /**
   * Optional (native-only) recovery nudge, called from the screen's AppState
   * "active" handler. Native keeps a looping silent keep-alive player running
   * while there is radio demand so iOS doesn't suspend the app on a quiet
   * channel; an AVAudioSession interruption (phone call, Siri) pauses that
   * player and nothing resumes it automatically — this replays/restarts it.
   * No-op (absent) on the web stub.
   */
  resumeKeepAlive?(): void;
  teardown(): Promise<void>;
}
