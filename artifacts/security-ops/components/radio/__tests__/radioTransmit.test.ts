import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";
import { createTransmitController, type TransmitController } from "../radioTransmit";

type SendFn = (msg: { type: "start" | "end"; channelId: string }) => boolean;

/**
 * Regression coverage for the mobile (Expo) radio CONTROL plane — the
 * push-to-talk transmit-intent state machine that `RadioScreen.tsx` delegates
 * its `startTalking` / `stopTalking` / `cancelTransmit` handlers (and the WS
 * `speaking` echo gate) to.
 *
 * Task #53 covered the native media layer (LiveKit room/track teardown on
 * release). This covers the complementary control-plane invariant from
 * `.agents/memory/ptt-transmit-intent-sync-ref.md`:
 *
 *  - intent is recorded SYNCHRONOUSLY *before* the WS `start` is sent, so a
 *    `speaking` echo that races the send still goes live;
 *  - release bumps the generation, nulls the intent, and sends WS `end` — even
 *    on a fast press/release where React state never left "idle";
 *  - a late lock-grant arriving AFTER release does NOT start a publish (the echo
 *    gate returns null because intent was cleared).
 *
 * RadioScreen is a React-Native component and the mobile test runner is Node
 * (no RN renderer), so we exercise the extracted controller directly — exactly
 * the same module the screen wires its handlers to.
 */

describe("radio transmit controller (mobile)", () => {
  let sent: Array<{ type: "start" | "end"; channelId: string }>;
  let sendOpen: boolean;
  let userId: string | undefined;
  let send: Mock<SendFn>;
  let ctrl: TransmitController;

  beforeEach(() => {
    sent = [];
    sendOpen = true;
    userId = "officer-1";
    send = vi.fn<SendFn>((msg) => {
      if (!sendOpen) return false;
      sent.push(msg);
      return true;
    });
    ctrl = createTransmitController({ send, getUserId: () => userId });
  });

  describe("startTalking", () => {
    it("records intent SYNCHRONOUSLY before sending WS 'start'", () => {
      let intentAtSend: ReturnType<TransmitController["intent"]> = null;
      send.mockImplementationOnce((msg: { type: "start" | "end"; channelId: string }) => {
        intentAtSend = ctrl.intent();
        sent.push(msg);
        return true;
      });

      const ok = ctrl.start("chan-1");

      expect(ok).toBe(true);
      expect(intentAtSend).toEqual({ channelId: "chan-1", gen: 1 });
      expect(sent).toEqual([{ type: "start", channelId: "chan-1" }]);
      expect(ctrl.intent()).toEqual({ channelId: "chan-1", gen: 1 });
      expect(ctrl.currentGen()).toBe(1);
    });

    it("a 'speaking' echo that races the 'start' send already finds the intent", () => {
      let grantedDuringSend: ReturnType<TransmitController["handleSpeaking"]> = null;
      send.mockImplementationOnce((msg: { type: "start" | "end"; channelId: string }) => {
        sent.push(msg);
        grantedDuringSend = ctrl.handleSpeaking("chan-1", "officer-1");
        return true;
      });

      ctrl.start("chan-1");

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
      ctrl.start("chan-2");
      const had = ctrl.stop(null, "chan-2");

      expect(had).toBe(true);
      expect(ctrl.intent()).toBeNull();
      expect(sent).toContainEqual({ type: "end", channelId: "chan-2" });
    });

    it("ends the channel actually publishing over the active fallback", () => {
      ctrl.start("chan-active");
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

      const granted = ctrl.handleSpeaking("chan-1", "officer-1");

      expect(granted).toBeNull();
    });

    it("does NOT publish when the echo arrives after cancelTransmit (WS drop)", () => {
      ctrl.start("chan-1");
      ctrl.cancel();

      const granted = ctrl.handleSpeaking("chan-1", "officer-1");

      expect(granted).toBeNull();
      expect(sent).toEqual([{ type: "start", channelId: "chan-1" }]);
      expect(ctrl.intent()).toBeNull();
    });

    it("positive control: an echo during a live hold DOES publish with the owning gen", () => {
      ctrl.start("chan-1");

      const granted = ctrl.handleSpeaking("chan-1", "officer-1");

      expect(granted).toEqual({ channelId: "chan-1", gen: 1 });
    });

    it("ignores an echo for a different channel or a different speaker", () => {
      ctrl.start("chan-1");

      expect(ctrl.handleSpeaking("chan-2", "officer-1")).toBeNull();
      expect(ctrl.handleSpeaking("chan-1", "someone-else")).toBeNull();
      expect(ctrl.handleSpeaking("chan-1", "officer-1")).toEqual({ channelId: "chan-1", gen: 1 });
    });
  });

  describe("generation hand-off across consecutive transmits", () => {
    it("a stale gen from a prior hold can no longer abort a fresh one", () => {
      ctrl.start("chan-1");
      const firstGen = ctrl.currentGen();
      ctrl.stop(null, "chan-1");

      ctrl.start("chan-1");
      const secondGen = ctrl.currentGen();

      expect(secondGen).not.toBe(firstGen);
      expect(ctrl.currentGen()).toBe(secondGen);
      expect(ctrl.intent()).toEqual({ channelId: "chan-1", gen: secondGen });
    });
  });
});
