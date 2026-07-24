/**
 * Native (iOS/Android) media plane: live, end-to-end-encrypted LiveKit audio.
 *
 * Our `/api/ws/radio` socket stays the control plane (membership, single-speaker
 * lock, presence, audit); live audio rides one E2EE LiveKit room per channel.
 *
 *  - Listening: a SUBSCRIBE-only room for the active channel. On native, remote
 *    audio plays automatically through the device once the AudioSession is up —
 *    there is no per-track `attach()` (that is the web path).
 *  - Talking: once the server grants the speaker lock (signalled over the WS),
 *    we mint a short-lived PUBLISH token (distinct `userId#pub` identity, so
 *    it never collides with the listen connection), connect a fresh room with
 *    it, and publish the mic. On release we tear the publish room down and
 *    resume listening.
 *
 * E2EE keys are derived per-channel server-side and delivered (base64) only to
 * authorised members; the SFU only ever relays ciphertext.
 *
 * BACKGROUND / LOCKED-SCREEN SURVIVAL: the UIBackgroundModes `audio`
 * entitlement only keeps iOS from suspending the app while the audio I/O unit
 * is ACTUALLY RENDERING. On a quiet PTT channel there are zero remote tracks
 * (each transmission is a short-lived publisher room), so WebRTC stops
 * playout, iOS suspends the app ~30s after lock, and the officer silently
 * misses every later transmission. The fix is a looping SILENT keep-alive
 * player (expo-audio) that runs exactly while there is REAL radio demand — a
 * listen room live or connecting, or a transmit in flight — keeping the audio
 * unit rendering so the app, its control WS, and the LiveKit listen room stay
 * alive when the phone locks mid-shift. `reconcileKeepAlive()` re-derives the
 * demand at every connect/drop boundary, so muting or leaving every channel
 * stops the silent loop. This scoping is DISCLOSED to App Review
 * (APP_REVIEW_NOTES.md §3) — keep code and disclosure in lockstep.
 *
 * This module is Metro-resolved ONLY on native (web gets `radioMedia.ts`), so
 * importing the native-only WebRTC stack and calling registerGlobals() here is
 * safe — it never reaches the web bundle.
 */
import {
  registerGlobals,
  AudioSession,
  RNE2EEManager,
  AndroidAudioTypePresets,
} from "@livekit/react-native";
import type { AudioPlayer } from "expo-audio";
import {
  Room,
  RoomEvent,
  DisconnectReason,
  createLocalAudioTrack,
  type LocalAudioTrack,
} from "livekit-client";

import { RadioKeyProvider } from "./radioKeyProvider";
import { type RadioMedia, type RadioToken } from "./radioTypes";

// Patches the global WebRTC + media primitives that livekit-client expects.
// Must run before any Room is created; importing this module does that once.
registerGlobals();

/**
 * OTA-COMPAT GUARD: expo-audio was added to the binary AFTER the 1.0.0 App
 * Store builds shipped (it arrived with the keep-alive work). runtimeVersion
 * policy is `appVersion`, so an OTA bundle published for runtime "1.0.0" CAN
 * land on binaries whose native image has no ExpoAudio module — a top-level
 * `import { … } from "expo-audio"` would then throw during module evaluation
 * and crash the whole app at launch. Load it lazily and tolerate absence:
 * on older binaries the silent keep-alive is simply disabled (the radio still
 * works in the foreground; locked-phone survival needs the newer binary).
 */
type ExpoAudioModule = typeof import("expo-audio");
let expoAudioModule: ExpoAudioModule | null | undefined;
function getExpoAudio(): ExpoAudioModule | null {
  if (expoAudioModule === undefined) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      expoAudioModule = require("expo-audio") as ExpoAudioModule;
    } catch (e) {
      console.warn(
        "[radio] expo-audio native module unavailable — silent keep-alive disabled",
        e,
      );
      expoAudioModule = null;
    }
  }
  return expoAudioModule;
}

// How long a freshly-published (still muted) track waits before unmuting so
// listeners' receiver cryptors are created and keyed before the first audible
// frame. Bounded and abort-aware — PTT release mid-settle tears down cleanly.
const PUBLISH_SETTLE_MS = 300;

/**
 * Abort-aware bounded wait. Returns false (without waiting out the full
 * duration) as soon as `aborted()` reports true.
 */
async function settleDelay(ms: number, aborted: () => boolean): Promise<boolean> {
  const step = 50;
  for (let waited = 0; waited < ms; waited += step) {
    if (aborted()) return false;
    await new Promise((resolve) => setTimeout(resolve, step));
  }
  return !aborted();
}

class NativeRadioMedia implements RadioMedia {
  readonly supportsAudio = true;

  private listenRooms = new Map<string, Room>();
  private connecting = new Set<string>();
  private publishRoom: Room | null = null;
  private publishChannelId: string | null = null;
  private publishTrack: LocalAudioTrack | null = null;
  private sessionStarted = false;
  private keepAlive: AudioPlayer | null = null;
  private publishStarting = false;
  private onListenLost: ((channelId: string) => void) | null = null;

  listenChannelIds(): string[] {
    return [...this.listenRooms.keys()];
  }
  isListening(channelId: string): boolean {
    return this.listenRooms.has(channelId);
  }
  publishingChannelId(): string | null {
    return this.publishChannelId;
  }
  setOnListenLost(cb: ((channelId: string) => void) | null): void {
    this.onListenLost = cb;
  }

  private async ensureSession(): Promise<void> {
    if (this.sessionStarted) return;
    // expo-audio's mode FIRST, LiveKit's session config LAST so LiveKit's
    // playAndRecord/voice settings win the AVAudioSession category. The mode
    // grants background playback + silent-switch playback for the keep-alive
    // loop; allowsRecording keeps the category compatible with PTT capture.
    try {
      const expoAudio = getExpoAudio();
      if (expoAudio) {
        await expoAudio.setAudioModeAsync({
          playsInSilentMode: true,
          shouldPlayInBackground: true,
          interruptionMode: "mixWithOthers",
          allowsRecording: true,
        });
      }
    } catch (e) {
      // Keep-alive is best-effort; the radio itself must still work.
      console.warn("[radio] setAudioModeAsync failed", e);
    }
    await AudioSession.configureAudio({
      android: { audioTypeOptions: AndroidAudioTypePresets.communication },
      ios: { defaultOutput: "speaker" },
    });
    await AudioSession.startAudioSession();
    this.sessionStarted = true;
  }

  /**
   * True while the radio actually needs the audio unit kept awake: a listen
   * room is live or connecting, or a transmit is registered / being set up.
   */
  private hasKeepAliveDemand(): boolean {
    return (
      this.listenRooms.size > 0 ||
      this.connecting.size > 0 ||
      this.publishRoom !== null ||
      this.publishStarting
    );
  }

  /**
   * Start/stop the looping silent player so it runs EXACTLY while there is
   * real radio demand. Without it, an idle (nobody-transmitting) channel has
   * no audio to render, so iOS suspends the app shortly after the screen
   * locks and the officer misses every later transmission. Called at every
   * connect/drop boundary; both halves are idempotent. NOTE: App Review is
   * told the silent loop only plays while the user is actively on a channel
   * (APP_REVIEW_NOTES.md §3) — widening this scope needs a disclosure update.
   */
  private reconcileKeepAlive(): void {
    if (this.hasKeepAliveDemand()) this.startKeepAlive();
    else this.stopKeepAlive();
  }

  private startKeepAlive(): void {
    if (this.keepAlive) return;
    const expoAudio = getExpoAudio();
    // Older 1.0.0 binaries have no ExpoAudio native module — skip silently.
    if (!expoAudio) return;
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const player = expoAudio.createAudioPlayer(require("../../assets/audio/silence.wav"));
      player.loop = true;
      player.play();
      this.keepAlive = player;
    } catch (e) {
      console.warn("[radio] keep-alive player failed to start", e);
    }
  }

  private stopKeepAlive(): void {
    const player = this.keepAlive;
    this.keepAlive = null;
    if (!player) return;
    try {
      player.pause();
      player.remove();
    } catch {
      /* ignore */
    }
  }

  /**
   * Recovery nudge from the screen's AppState "active" handler: an
   * AVAudioSession interruption (phone call, Siri) pauses the keep-alive
   * player and nothing resumes it automatically — replay it (play() on an
   * already-playing player is a no-op) or restart it if it died entirely.
   */
  resumeKeepAlive(): void {
    if (!this.hasKeepAliveDemand()) return;
    const player = this.keepAlive;
    if (!player) {
      this.startKeepAlive();
      return;
    }
    try {
      player.play();
    } catch {
      this.stopKeepAlive();
      this.startKeepAlive();
    }
  }

  private async makeRoom(token: RadioToken): Promise<Room> {
    // IMPORTANT: the E2EE key must be fed to LiveKit as a STRING passphrase on
    // every platform. A string routes through PBKDF2 on both web and native;
    // raw bytes route through HKDF on web but PBKDF2 on native, yielding
    // DIFFERENT AES keys from the same secret — cross-platform audio then
    // decrypts to garbled noise. RadioKeyProvider wraps RNKeyProvider with
    // discardFrameWhenCryptorNotReady=true so frames that arrive before a
    // fresh receiver cryptor is keyed are DROPPED (brief silence) instead of
    // being fed to Opus as ciphertext (loud static) — see radioKeyProvider.ts.
    const keyProvider = new RadioKeyProvider();
    await keyProvider.setSharedKey(token.e2eeKey);
    const e2eeManager = new RNE2EEManager(keyProvider, false);
    const room = new Room({ e2ee: { e2eeManager } });
    await room.setE2EEEnabled(true);
    return room;
  }

  async ensureListen(channelId: string, token: RadioToken): Promise<void> {
    if (this.publishChannelId === channelId) return;
    if (this.listenRooms.has(channelId) || this.connecting.has(channelId)) return;
    this.connecting.add(channelId);
    this.reconcileKeepAlive();
    try {
      await this.ensureSession();
      const room = await this.makeRoom(token);
      // Audio auto-plays on native; nothing to attach. We just keep the
      // connection so the speaker's track is subscribed and routed to output.
      room.on(RoomEvent.Disconnected, (reason?: DisconnectReason) => {
        // dropListen() removes the room from the map BEFORE disconnecting, so
        // if it's still registered here the disconnect was UNEXPECTED (server
        // eviction, network drop, SFU restart). Without a signal the screen's
        // reconcile effect never re-runs and the user is silently deaf on the
        // channel — notify so it can reconnect.
        if (this.listenRooms.get(channelId) !== room) return;
        this.listenRooms.delete(channelId);
        console.warn("[radio] listen room lost unexpectedly", channelId, reason);
        this.onListenLost?.(channelId);
      });
      await room.connect(token.url, token.token);
      this.listenRooms.set(channelId, room);
    } finally {
      this.connecting.delete(channelId);
      this.reconcileKeepAlive();
    }
  }

  async dropListen(channelId: string): Promise<void> {
    const room = this.listenRooms.get(channelId);
    this.listenRooms.delete(channelId);
    this.reconcileKeepAlive();
    if (room) {
      try {
        await room.disconnect();
      } catch {
        /* ignore */
      }
    }
  }

  async startPublish(
    channelId: string,
    token: RadioToken,
    shouldAbort?: () => boolean,
  ): Promise<void> {
    const aborted = (): boolean => shouldAbort?.() ?? false;
    // `publishStarting` holds keep-alive demand across the whole setup, so
    // dropping the listen room below can't briefly stop the silent loop.
    this.publishStarting = true;
    try {
      // The publish token uses a distinct `userId#pub` identity, so it can't
      // evict the listen connection — but we still drop the listen room first
      // so the speaker doesn't hear their own transmission echoed back.
      await this.dropListen(channelId);
      if (aborted()) return;
      await this.ensureSession();
      if (aborted()) return;
      const room = await this.makeRoom(token);
      if (aborted()) {
        // Released before we even connected — nothing to register or tear down
        // beyond the freshly-made (not-yet-connected) room.
        try { await room.disconnect(); } catch { /* ignore */ }
        return;
      }
      // Register the room BEFORE connecting so a concurrent stopPublish() (PTT
      // released mid-connect) can find and disconnect it instead of letting
      // this connection leak audio after release.
      this.publishRoom = room;
      this.publishChannelId = channelId;
      await this.connectAndPublish(room, token, aborted);
    } finally {
      this.publishStarting = false;
      this.reconcileKeepAlive();
    }
  }

  private async connectAndPublish(
    room: Room,
    token: RadioToken,
    aborted: () => boolean,
  ): Promise<void> {
    let track: LocalAudioTrack | null = null;
    try {
      await room.connect(token.url, token.token);
      if (aborted()) return await this.abortPublish(room, track);
      track = await createLocalAudioTrack({
        echoCancellation: true,
        noiseSuppression: true,
      });
      this.publishTrack = track;
      if (aborted()) return await this.abortPublish(room, track);
      // Publish MUTED, let the publication settle, then unmute. Every press
      // publishes a fresh track, so each listener builds a brand-new receiver
      // cryptor when it arrives (created + keyed asynchronously). Frames sent
      // in that window are undecryptable — audible as start-of-transmission
      // garble (static) or, with the discard flag, dropped words. Muting
      // until the publication has settled means the cryptors exist BEFORE the
      // first audible frame. There is no cross-platform "encryption ready"
      // event to await, so a short bounded delay is the pragmatic gate.
      await track.mute();
      if (aborted()) return await this.abortPublish(room, track);
      await room.localParticipant.publishTrack(track);
      if (aborted()) return await this.abortPublish(room, track);
      if (!(await settleDelay(PUBLISH_SETTLE_MS, aborted))) {
        return await this.abortPublish(room, track);
      }
      await track.unmute();
      if (aborted()) return await this.abortPublish(room, track);
    } catch (e) {
      await this.abortPublish(room, track);
      throw e;
    }
  }

  /**
   * Tear down a SPECIFIC publish attempt's local handles. Unlike stopPublish(),
   * this disconnects the `room`/`track` passed in even if a concurrent
   * stopPublish() already nulled the instance refs (e.g. PTT released while
   * room.connect() was still in flight, then connect resolved). It only clears
   * the instance refs if they still point at THIS attempt, so it never stomps a
   * newer transmit.
   */
  private async abortPublish(room: Room, track: LocalAudioTrack | null): Promise<void> {
    if (this.publishRoom === room) {
      this.publishRoom = null;
      this.publishChannelId = null;
    }
    if (track && this.publishTrack === track) this.publishTrack = null;
    if (track) {
      try {
        await room.localParticipant.unpublishTrack(track);
      } catch {
        /* ignore */
      }
      try {
        track.stop();
      } catch {
        /* ignore */
      }
    }
    try {
      await room.disconnect();
    } catch {
      /* ignore */
    }
  }

  async stopPublish(): Promise<void> {
    const room = this.publishRoom;
    const track = this.publishTrack;
    this.publishRoom = null;
    this.publishTrack = null;
    this.publishChannelId = null;
    if (room && track) {
      try {
        await room.localParticipant.unpublishTrack(track);
      } catch {
        /* ignore */
      }
    }
    if (track) {
      try {
        track.stop();
      } catch {
        /* ignore */
      }
    }
    if (room) {
      try {
        await room.disconnect();
      } catch {
        /* ignore */
      }
    }
    this.reconcileKeepAlive();
  }

  async teardown(): Promise<void> {
    this.stopKeepAlive();
    await this.stopPublish();
    for (const id of this.listenChannelIds()) await this.dropListen(id);
    if (this.sessionStarted) {
      try {
        await AudioSession.stopAudioSession();
      } catch {
        /* ignore */
      }
      this.sessionStarted = false;
    }
  }
}

export function createRadioMedia(): RadioMedia {
  return new NativeRadioMedia();
}
