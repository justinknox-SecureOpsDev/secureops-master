/**
 * The Secure Ops AI Bot preview row in ChatRoomsList must only render when
 * the "assistant" feature flag is on for the tenant AND the caller has wired
 * up somewhere to open it (onOpenAiBot) — otherwise it would be a dead tap
 * target on a standalone usage with no bot route, or advertise a feature the
 * tenant hasn't purchased.
 */
import { describe, it, expect } from "vitest";
import { shouldShowAiBotEntry } from "../chatVisibility";

const noop = () => {};

describe("shouldShowAiBotEntry", () => {
  it("shows the row when the feature flag is on and onOpenAiBot is provided", () => {
    expect(shouldShowAiBotEntry(true, noop)).toBe(true);
  });

  it("hides the row when the feature flag is off, even with onOpenAiBot provided", () => {
    expect(shouldShowAiBotEntry(false, noop)).toBe(false);
  });

  it("hides the row when onOpenAiBot is not provided, even with the flag on", () => {
    expect(shouldShowAiBotEntry(true, undefined)).toBe(false);
  });

  it("hides the row when both the flag is off and onOpenAiBot is missing", () => {
    expect(shouldShowAiBotEntry(false, undefined)).toBe(false);
  });
});
