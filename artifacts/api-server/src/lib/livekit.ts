import { AccessToken, RoomServiceClient } from "livekit-server-sdk";
import { hkdfSync } from "node:crypto";
import { logger } from "./logger";

/**
 * LiveKit media transport for the push-to-talk radio.
 *
 * The radio's control plane (channel membership, single-speaker lock,
 * presence, audit) stays on our own `/api/ws/radio` WebSocket. LiveKit
 * carries ONLY the live audio: one LiveKit room per radio channel.
 *
 * Token model:
 *   - Every authorised member gets a SUBSCRIBE-only token (listen).
 *   - A short-lived PUBLISH token is minted only once the caller has won
 *     the server-side speaker lock, so the "single speaker" guarantee is
 *     never delegated to the client.
 *
 * End-to-end encryption:
 *   - Each channel has a 256-bit key derived from SESSION_SECRET via HKDF.
 *     Clients that pass `canAccessChannel` receive the key alongside the
 *     token and feed it to LiveKit's external E2EE key provider, so audio
 *     is encrypted client-to-client and the SFU only relays ciphertext.
 *   - The key is never stored or transmitted to anyone who isn't already
 *     authorised for the channel, and it is deployment-specific because it
 *     is derived from this deployment's SESSION_SECRET.
 */

// Read at call time (not module load) so tests can stub env and so the
// config status reflects the live environment.
const livekitUrl = (): string => process.env.LIVEKIT_URL ?? "";
const livekitApiKey = (): string => process.env.LIVEKIT_API_KEY ?? "";
const livekitApiSecret = (): string => process.env.LIVEKIT_API_SECRET ?? "";

// Listen tokens live for a shift-length session; clients refresh on reconnect.
const SUBSCRIBE_TTL_SECONDS = 60 * 60;
// Publish tokens are intentionally short — one transmission. The speaker lock
// auto-releases after MAX_TRANSMISSION_MS (60s); this leaves a little headroom
// for clock skew / connection setup without granting a long publish window.
// Defence in depth: even within this window, releaseLock() force-removes the
// ex-speaker from the LiveKit room so a stale publish token cannot keep the
// floor after the lock is gone.
const PUBLISH_TTL_SECONDS = 90;

// Bump if the key-derivation scheme ever changes so old/new clients can detect
// a mismatch instead of silently failing to decrypt.
export const RADIO_E2EE_KEY_VERSION = 1;

const E2EE_HKDF_SALT = "secureops-radio-e2ee/v1";

export class LiveKitNotConfiguredError extends Error {
  constructor() {
    super("LiveKit is not configured (LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET)");
    this.name = "LiveKitNotConfiguredError";
  }
}

/** True only when all three LiveKit env values are present. */
export function isLiveKitConfigured(): boolean {
  return Boolean(livekitUrl() && livekitApiKey() && livekitApiSecret());
}

/** The LiveKit server origin clients should connect to (wss://…). */
export function getLiveKitUrl(): string {
  return livekitUrl();
}

// RoomServiceClient speaks HTTPS to the LiveKit API; the public connect URL
// is wss://. Translate the scheme so admin calls hit the right endpoint.
function livekitHttpUrl(): string {
  return livekitUrl().replace(/^ws:/i, "http:").replace(/^wss:/i, "https:");
}

/**
 * Force-remove a participant from a channel's LiveKit room. Called by the
 * radio gateway when a speaker's lock is released, times out, disconnects,
 * or is preempted — so a still-valid (but now stale) publish token cannot
 * keep transmitting after the floor has moved on. Best-effort: failures are
 * logged, never thrown, and it no-ops when LiveKit isn't configured.
 */
export async function removeRadioParticipant(channelId: string, userId: string): Promise<void> {
  if (!isLiveKitConfigured()) return;
  try {
    const svc = new RoomServiceClient(livekitHttpUrl(), livekitApiKey(), livekitApiSecret());
    await svc.removeParticipant(radioRoomName(channelId), userId);
  } catch (err) {
    // A 404 (participant already gone) is the common, harmless case.
    logger.debug({ err, channelId, userId }, "[radio] removeRadioParticipant failed (likely already disconnected)");
  }
}

/** Deterministic LiveKit room name for a radio channel. */
export function radioRoomName(channelId: string): string {
  return `radio-${channelId}`;
}

/**
 * Derive the per-channel E2EE key. Deterministic for a given
 * (SESSION_SECRET, channelId, version) so every authorised client on this
 * deployment derives the same key without it ever crossing the wire from
 * another participant. Returned base64-encoded, and clients MUST feed this
 * string to LiveKit as a passphrase (string → PBKDF2 on every SDK). Never
 * decode it to raw bytes first: the raw-bytes path uses HKDF on web but
 * PBKDF2 on native, deriving different AES keys — cross-platform audio then
 * plays as garbled noise.
 */
export function deriveChannelE2eeKey(channelId: string, version: number = RADIO_E2EE_KEY_VERSION): string {
  const secret = process.env.SESSION_SECRET ?? "";
  if (!secret) {
    throw new Error("SESSION_SECRET is required to derive the radio E2EE key");
  }
  const info = `secureops-radio-e2ee|channel=${channelId}|v=${version}`;
  const keyBytes = hkdfSync("sha256", secret, E2EE_HKDF_SALT, info, 32);
  return Buffer.from(keyBytes).toString("base64");
}

export interface RadioTokenResult {
  /** Signed LiveKit access token (JWT). */
  token: string;
  /** LiveKit server URL the client must connect to. */
  url: string;
  /** Room name for this channel. */
  room: string;
  /** Participant identity baked into the token. */
  identity: string;
  /** Base64 per-channel E2EE key. */
  e2eeKey: string;
  /** Version of the key-derivation scheme. */
  e2eeKeyVersion: number;
  /** Whether this token grants microphone publish. */
  canPublish: boolean;
  /** Token lifetime in seconds (client refreshes before expiry). */
  ttlSeconds: number;
}

interface MintParams {
  channelId: string;
  userId: string;
  displayName: string;
  canPublish: boolean;
  ttlSeconds: number;
}

async function mintToken(params: MintParams): Promise<RadioTokenResult> {
  if (!isLiveKitConfigured()) throw new LiveKitNotConfiguredError();
  const room = radioRoomName(params.channelId);
  const at = new AccessToken(livekitApiKey(), livekitApiSecret(), {
    identity: params.userId,
    name: params.displayName,
    ttl: params.ttlSeconds,
  });
  at.addGrant({
    roomJoin: true,
    room,
    canSubscribe: true,
    canPublish: params.canPublish,
    // No data channel — control/presence rides our own WS, not LiveKit.
    canPublishData: false,
    canUpdateOwnMetadata: false,
  });
  const token = await at.toJwt();
  return {
    token,
    url: livekitUrl(),
    room,
    identity: params.userId,
    e2eeKey: deriveChannelE2eeKey(params.channelId),
    e2eeKeyVersion: RADIO_E2EE_KEY_VERSION,
    canPublish: params.canPublish,
    ttlSeconds: params.ttlSeconds,
  };
}

/** Listen-only token for an authorised channel member. */
export function mintSubscribeToken(params: {
  channelId: string;
  userId: string;
  displayName: string;
}): Promise<RadioTokenResult> {
  return mintToken({ ...params, canPublish: false, ttlSeconds: SUBSCRIBE_TTL_SECONDS });
}

/**
 * Short-lived publish token. Callers MUST verify the speaker lock is held
 * by this user before minting one — this function does not check the lock.
 */
export function mintPublishToken(params: {
  channelId: string;
  userId: string;
  displayName: string;
}): Promise<RadioTokenResult> {
  return mintToken({ ...params, canPublish: true, ttlSeconds: PUBLISH_TTL_SECONDS });
}
