/**
 * Radio listen policy — what the phone keeps connected, and when.
 *
 * The rules exist to bound LiveKit usage: standing audio connections are only
 * justified while an officer is actually on shift, and even then only for the
 * one channel an admin designated always-on (Dispatch). Everything else is
 * foreground-only.
 */

import { describe, expect, it } from "vitest";
import {
  computeDesiredListenChannels,
  findAlwaysOnChannelId,
  type ListenPolicyChannel,
} from "../components/radio/listenPolicy";

const DISPATCH = "dispatch-id";
const SITE = "site-id";

const CHANNELS: ListenPolicyChannel[] = [
  { id: DISPATCH, alwaysOn: true, archivedAt: null },
  { id: SITE, alwaysOn: false, archivedAt: null },
];

function policy(over: Partial<Parameters<typeof computeDesiredListenChannels>[0]> = {}): string[] {
  return computeDesiredListenChannels({
    foreground: true,
    clockedIn: true,
    activeId: SITE,
    channels: CHANNELS,
    leftChannels: new Set(),
    mutedChannels: new Set(),
    publishingChannelId: null,
    ...over,
  });
}

describe("radio listen policy", () => {
  it("finds the designated always-on channel", () => {
    expect(findAlwaysOnChannelId(CHANNELS)).toBe(DISPATCH);
    expect(findAlwaysOnChannelId([{ id: SITE }])).toBeNull();
  });

  it("ignores an archived always-on channel", () => {
    const archived: ListenPolicyChannel[] = [{ id: DISPATCH, alwaysOn: true, archivedAt: "2026-01-01T00:00:00Z" }];
    expect(findAlwaysOnChannelId(archived)).toBeNull();
    expect(policy({ channels: archived, activeId: null })).toEqual([]);
  });

  it("on duty in the foreground: keeps dispatch open alongside the selected channel", () => {
    expect(policy().sort()).toEqual([DISPATCH, SITE].sort());
  });

  it("on duty in the background: keeps ONLY dispatch", () => {
    expect(policy({ foreground: false })).toEqual([DISPATCH]);
  });

  it("off duty in the foreground: only the selected channel, dispatch is not held open", () => {
    expect(policy({ clockedIn: false })).toEqual([SITE]);
  });

  it("off duty in the background: nothing stays connected", () => {
    expect(policy({ clockedIn: false, foreground: false })).toEqual([]);
  });

  it("off duty with dispatch selected: still listens in the foreground, drops it in the background", () => {
    expect(policy({ clockedIn: false, activeId: DISPATCH })).toEqual([DISPATCH]);
    expect(policy({ clockedIn: false, activeId: DISPATCH, foreground: false })).toEqual([]);
  });

  it("never lists the same channel twice when dispatch is the selected channel", () => {
    expect(policy({ activeId: DISPATCH })).toEqual([DISPATCH]);
  });

  it("respects mute and leave, including on the always-on channel", () => {
    expect(policy({ mutedChannels: new Set([DISPATCH]) })).toEqual([SITE]);
    expect(policy({ leftChannels: new Set([DISPATCH]) })).toEqual([SITE]);
    expect(policy({ mutedChannels: new Set([SITE]) })).toEqual([DISPATCH]);
  });

  it("excludes the channel being transmitted on (the publish connection replaces it)", () => {
    expect(policy({ publishingChannelId: DISPATCH })).toEqual([SITE]);
    expect(policy({ publishingChannelId: SITE })).toEqual([DISPATCH]);
  });

  it("handles a selected channel that is no longer in the list", () => {
    expect(policy({ activeId: "gone" })).toEqual([DISPATCH]);
    expect(policy({ activeId: null, clockedIn: false })).toEqual([]);
  });
});
