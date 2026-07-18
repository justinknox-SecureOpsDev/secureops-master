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
  listenChannelIds(): string[];
  isListening(channelId: string): boolean;
  publishingChannelId(): string | null;
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
  teardown(): Promise<void>;
}
