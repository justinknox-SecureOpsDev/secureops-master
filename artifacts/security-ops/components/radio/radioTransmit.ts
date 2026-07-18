/**
 * Synchronous push-to-talk (PTT) transmit-intent state machine.
 *
 * The authoritative "am I still transmitting?" signal MUST be synchronous — set
 * the instant PTT is pressed and cleared the instant it's released — never React
 * state or a `useEffect`-mirrored ref, both of which lag by at least a tick. A
 * WebSocket `speaking` lock-grant echo can arrive inside that gap, so gating on
 * stale state would start publishing AFTER the user let go (leaking microphone
 * audio). A fast press/release can even run the stop handler from a render where
 * state is still "idle", skipping cleanup entirely.
 *
 * This controller owns the generation counter + intent so those invariants live
 * in one place that can be unit-tested without rendering the screen. The screen
 * keeps its React state, media plane, and WebSocket; it only delegates the
 * synchronous ref bookkeeping and the start/end signalling + echo gate here.
 *
 * See `.agents/memory/ptt-transmit-intent-sync-ref.md`.
 */

/** The channel + generation that currently owns the transmit intent. */
export type TransmitIntent = { channelId: string; gen: number };

export type TransmitControllerDeps = {
  /**
   * Send a control-plane WS message. Returns false if the socket isn't open
   * (the caller already guards this, but the controller stays honest about it).
   */
  send: (msg: { type: "start" | "end"; channelId: string }) => boolean;
  /** Current authenticated user id, for matching `speaking` echoes to us. */
  getUserId: () => string | undefined;
};

export type TransmitController = {
  /**
   * Press: bump the generation and record intent SYNCHRONOUSLY *before* sending
   * the WS `start`, so a `speaking` echo that races the send still finds the
   * intent and goes live. Returns whether the `start` was sent.
   */
  start: (channelId: string) => boolean;
  /**
   * Release: bump the generation and clear intent FIRST (so any in-flight
   * publish aborts and a late echo is ignored), then send WS `end`. Runs even
   * when React state never settled — it gates on the synchronous intent, not
   * state, so a fast press/release still cleans up. The `end` channel is
   * `preferredChannelId` (the channel actually publishing) ?? the intent's
   * channel ?? `fallbackChannelId` (the active channel). Returns true if there
   * was a live intent to release.
   */
  stop: (preferredChannelId?: string | null, fallbackChannelId?: string | null) => boolean;
  /**
   * Abort WITHOUT sending `end` (WS dropped / denied / publish error): bump the
   * generation and clear intent so any in-flight publish aborts and a late echo
   * is ignored. No WS send — the socket may be gone.
   */
  cancel: () => void;
  /**
   * Handle a server `speaking` echo. Returns the intent to publish ONLY if the
   * grant is OUR own and for the channel we still intend to transmit on;
   * otherwise null (a late echo after release is ignored). The caller passes the
   * returned `gen` into its publish path so it can abort if we release again.
   */
  handleSpeaking: (channelId: string, speakerUserId: string) => TransmitIntent | null;
  /** The generation that currently owns intent (for publish-abort checks). */
  currentGen: () => number;
  /** The live transmit intent, or null. */
  intent: () => TransmitIntent | null;
};

export function createTransmitController(deps: TransmitControllerDeps): TransmitController {
  let gen = 0;
  let intent: TransmitIntent | null = null;

  return {
    start(channelId) {
      gen += 1;
      // Record intent BEFORE the send so a racing `speaking` echo sees it.
      intent = { channelId, gen };
      return deps.send({ type: "start", channelId });
    },
    stop(preferredChannelId, fallbackChannelId) {
      const current = intent;
      if (!current) return false;
      // Bump + clear intent FIRST so any in-flight publish aborts itself and a
      // late `speaking` echo can't start a new publish.
      gen += 1;
      intent = null;
      const channelId = preferredChannelId ?? current.channelId ?? fallbackChannelId ?? null;
      if (channelId) deps.send({ type: "end", channelId });
      return true;
    },
    cancel() {
      gen += 1;
      intent = null;
    },
    handleSpeaking(channelId, speakerUserId) {
      const current = intent;
      if (speakerUserId === deps.getUserId() && current && channelId === current.channelId) {
        return current;
      }
      return null;
    },
    currentGen() {
      return gen;
    },
    intent() {
      return intent;
    },
  };
}
