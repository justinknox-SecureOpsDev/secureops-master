import { describe, it, expect, beforeEach, vi } from "vitest";
import { createTransmitController, type TransmitController } from "../radioTransmit";

/**
 * Regression coverage for the admin-portal radio CONTROL plane — the
 * push-to-talk transmit-intent state machine that `Radio.tsx` delegates its
 * `startTalking` / `stopTalking` / `cancelTransmit` handlers (and the WS
 * `speaking` echo gate) to.
 *
 * Task #53 covered the media layer (LiveKit room/track teardown on release).
 * This covers the complementary control-plane invariant from
 * `.agents/memory/ptt-transmit-intent-sync-ref.md`:
 *
 *  - intent is recorded SYNCHRONOUSLY *before* the WS `start` is sent, so a
 *    `speaking` echo that races the send still goes live;
 *  - release bumps the generation, nulls the intent, and sends WS `end` — even
 *    on a fast press/release where React state never left "idle";
 *  - a late lock-grant arriving AFTER release does NOT start a publish (the echo
 *    gate returns null because intent was cleared).
 */

describe("radio transmit controller (admin portal)", () => {
  let sent: Array<{ type: "start" | "end"; channelId: string }>;
  let sendOpen: boolean;
  let userId: string | undefined;
  let send: ReturnType<typeof vi.fn>;
  let ctrl: TransmitController;

  beforeEach(() => {
    sent = [];
    sendOpen = true;
    userId = "u1";
    send = vi.fn((msg: { type: "start" | "end"; channelId: string }) => {
      if (!sendOpen) return false;
      sent.push(msg);
      return true;
    });
    ctrl = createTransmitController({ send, getUserId: () => userId });
  });

  describe("startTalking", () => {
    it("records intent SYNCHRONOUSLY before sending WS 'start'", () => {
      // Capture the intent state at the exact moment `send` is invoked.
      let intentAtSend: ReturnType<TransmitController["intent"]> = null;
      send.mockImplementationOnce((msg: { type: "start" | "end"; channelId: string }) => {
        intentAtSend = ctrl.intent();
        sent.push(msg);
        return true;
      });

      const ok = ctrl.start("chan-1");

      expect(ok).toBe(true);
      // Intent was already set when 'start' went out — not a tick later.
      expect(intentAtSend).toEqual({ channelId: "chan-1", gen: 1 });
      expect(sent).toEqual([{ type: "start", channelId: "chan-1" }]);
      expect(ctrl.intent()).toEqual({ channelId: "chan-1", gen: 1 });
      expect(ctrl.currentGen()).toBe(1);
    });

    it("a 'speaking' echo that races the 'start' send already finds the intent", () => {
      // The server echoes our grant synchronously while we're still inside send.
      let grantedDuringSend: ReturnType<TransmitController["handleSpeaking"]> = null;
      send.mockImplementationOnce((msg: { type: "start" | "end"; channelId: string }) => {
        sent.push(msg);
        grantedDuringSend = ctrl.handleSpeaking("chan-1", "u1");
        return true;
      });

      ctrl.start("chan-1");

      // Because intent was set BEFORE the send, the racing echo publishes.
      expect(grantedDuringSend).toEqual({ channelId: "chan-1", gen: 1 });
    });
  });

  describe("stopTalking", () => {
    it("bumps the generation, nulls the intent, and sends WS 'end'", () => {
      ctrl.start("chan-1");
      const genWhileLive = ctrl.currentGen();

      const had = ctrl.stop(null, "chan-1");

      expect(had).toBe(true);
      expect(ctrl.intent()).toBeNull();
      expect(ctrl.currentGen()).toBe(genWhileLive + 1);
      expect(sent).toEqual([
        { type: "start", channelId: "chan-1" },
        { type: "end", channelId: "chan-1" },
      ]);
    });

    it("still cleans up + sends 'end' on a fast press/release (state never settled)", () => {
      // startTalking ran, then stopTalking runs from a render where React state
      // is still "idle". The controller gates on the synchronous intent, not
      // state, so cleanup + 'end' must still happen.
      ctrl.start("chan-2");
      const had = ctrl.stop(null, "chan-2");

      expect(had).toBe(true);
      expect(ctrl.intent()).toBeNull();
      expect(sent).toContainEqual({ type: "end", channelId: "chan-2" });
    });

    it("ends the channel actually publishing over the active fallback", () => {
      ctrl.start("chan-active");
      // The mic is publishing on chan-pub (publishingChannelId), distinct from the
      // active channel — 'end' must target what we're actually transmitting on.
      ctrl.stop("chan-pub", "chan-active");

      expect(sent).toContainEqual({ type: "end", channelId: "chan-pub" });
      expect(sent).not.toContainEqual({ type: "end", channelId: "chan-active" });
    });

    it("is a no-op when there is no live intent (nothing to release)", () => {
      const had = ctrl.stop(null, "chan-1");

      expect(had).toBe(false);
      expect(send).not.toHaveBeenCalled();
    });
  });

  describe("late lock-grant after release", () => {
    it("does NOT publish when the 'speaking' echo arrives after stop", () => {
      ctrl.start("chan-1");
      ctrl.stop(null, "chan-1");

      // The server's grant lands one tick too late — intent was already cleared.
      const granted = ctrl.handleSpeaking("chan-1", "u1");

      expect(granted).toBeNull();
    });

    it("does NOT publish when the echo arrives after cancelTransmit (WS drop)", () => {
      ctrl.start("chan-1");
      ctrl.cancel(); // WS dropped / denied — abort without sending 'end'

      const granted = ctrl.handleSpeaking("chan-1", "u1");

      expect(granted).toBeNull();
      // cancel never sends 'end' (the socket may be gone).
      expect(sent).toEqual([{ type: "start", channelId: "chan-1" }]);
      expect(ctrl.intent()).toBeNull();
    });

    it("positive control: an echo during a live hold DOES publish with the owning gen", () => {
      ctrl.start("chan-1");

      const granted = ctrl.handleSpeaking("chan-1", "u1");

      expect(granted).toEqual({ channelId: "chan-1", gen: 1 });
    });

    it("ignores an echo for a different channel or a different speaker", () => {
      ctrl.start("chan-1");

      expect(ctrl.handleSpeaking("chan-2", "u1")).toBeNull(); // wrong channel
      expect(ctrl.handleSpeaking("chan-1", "someone-else")).toBeNull(); // not us
      // The genuine grant still works.
      expect(ctrl.handleSpeaking("chan-1", "u1")).toEqual({ channelId: "chan-1", gen: 1 });
    });
  });

  describe("generation hand-off across consecutive transmits", () => {
    it("a stale gen from a prior hold can no longer abort a fresh one", () => {
      ctrl.start("chan-1");
      const firstGen = ctrl.currentGen();
      ctrl.stop(null, "chan-1");

      ctrl.start("chan-1");
      const secondGen = ctrl.currentGen();

      // beginPublish from the first hold aborts (gen moved on); the second is live.
      expect(secondGen).not.toBe(firstGen);
      expect(ctrl.currentGen()).toBe(secondGen);
      expect(ctrl.intent()).toEqual({ channelId: "chan-1", gen: secondGen });
    });
  });
});
