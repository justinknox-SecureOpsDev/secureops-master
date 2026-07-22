/**
 * Web (Expo-web) media plane: a presence-only stub.
 *
 * Live radio audio for browsers lives in the React/Vite ADMIN PORTAL, which
 * has a full LiveKit + E2EE-worker implementation. The Expo-web build is a
 * dev/preview convenience and intentionally does NOT carry audio:
 *
 *   - importing `@livekit/react-native` on web would pull native-only WebRTC, and
 *   - the binary-over-WS audio relay this screen used to use was removed
 *     server-side when the media plane moved to LiveKit, so the old
 *     MediaRecorder path is already dead.
 *
 * So on web we keep the control plane (presence, who's transmitting) and
 * advertise `supportsAudio === false`; RadioScreen then skips token fetches and
 * disables push-to-talk, pointing the user at the native app / admin portal.
 *
 * The full media plane is in `radioMedia.native.ts` (Metro picks that on
 * native; this file on web).
 */
import type { RadioMedia, RadioToken } from "./radioTypes";

class WebRadioMediaStub implements RadioMedia {
  readonly supportsAudio = false;
  listenChannelIds(): string[] {
    return [];
  }
  isListening(): boolean {
    return false;
  }
  publishingChannelId(): string | null {
    return null;
  }
  setOnListenLost(_cb: ((channelId: string) => void) | null): void {
    /* no audio on Expo web — listen rooms never exist, so never lost */
  }
  async ensureListen(_channelId: string, _token: RadioToken): Promise<void> {
    /* no audio on Expo web */
  }
  async dropListen(_channelId: string): Promise<void> {
    /* no audio on Expo web */
  }
  async startPublish(
    _channelId: string,
    _token: RadioToken,
    _shouldAbort?: () => boolean,
  ): Promise<void> {
    /* no audio on Expo web */
  }
  async stopPublish(): Promise<void> {
    /* no audio on Expo web */
  }
  async teardown(): Promise<void> {
    /* no audio on Expo web */
  }
}

export function createRadioMedia(): RadioMedia {
  return new WebRadioMediaStub();
}
