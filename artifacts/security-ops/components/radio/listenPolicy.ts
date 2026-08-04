/**
 * Which radio channels the phone should hold a live LiveKit audio connection
 * to, right now.
 *
 * Deliberately pure and React-Native-free so it can be unit-tested directly
 * (see __tests__/listenPolicy.test.ts) — the media layer and the screen just
 * reconcile to whatever this returns.
 *
 * The rules, in plain terms:
 *
 *  - **Off duty, nothing is held open.** An officer who is not clocked in can
 *    still listen and talk while they are looking at the radio, but the moment
 *    the app goes to the background every connection is dropped. Standing
 *    LiveKit subscriptions cost data and battery around the clock; they are
 *    only justified while someone is actually on shift.
 *  - **On duty, exactly one channel stays open in the background** — the
 *    channel an admin flagged `alwaysOn` (Dispatch). That is the walkie-talkie
 *    on the belt: an officer must never miss dispatch because their screen
 *    locked. Every other channel is foreground-only, even on duty.
 *  - The channel the officer currently has selected is listened to while the
 *    app is in the foreground, on duty or not.
 *
 * Muted / left / archived channels are excluded everywhere, and the channel we
 * are actively transmitting on is excluded too (the publish connection
 * replaces the listen one for its duration).
 */

export type ListenPolicyChannel = {
  id: string;
  archivedAt?: string | null;
  alwaysOn?: boolean;
};

export type ListenPolicyInput = {
  /** App is in the foreground (AppState "active"). */
  foreground: boolean;
  /** Officer has an open time entry — i.e. is on shift right now. */
  clockedIn: boolean;
  /** The channel the officer has selected in the UI. */
  activeId: string | null;
  channels: ListenPolicyChannel[];
  /** Channels the officer explicitly left. */
  leftChannels: ReadonlySet<string>;
  /** Channels the officer muted. */
  mutedChannels: ReadonlySet<string>;
  /** Channel currently being transmitted on, if any. */
  publishingChannelId: string | null;
};

/** The designated always-on channel, or null if no live one is flagged. */
export function findAlwaysOnChannelId(channels: ListenPolicyChannel[]): string | null {
  const hit = channels.find((c) => c.alwaysOn && !c.archivedAt);
  return hit ? hit.id : null;
}

export function computeDesiredListenChannels(input: ListenPolicyInput): string[] {
  const {
    foreground, clockedIn, activeId, channels,
    leftChannels, mutedChannels, publishingChannelId,
  } = input;

  const byId = new Map(channels.map((c) => [c.id, c]));
  const eligible = (id: string | null): id is string => {
    if (!id) return false;
    const channel = byId.get(id);
    if (!channel || channel.archivedAt) return false;
    if (leftChannels.has(id) || mutedChannels.has(id)) return false;
    return id !== publishingChannelId;
  };

  const desired: string[] = [];

  // The always-on channel outlives backgrounding — but only on duty.
  const alwaysOnId = findAlwaysOnChannelId(channels);
  if (clockedIn && eligible(alwaysOnId)) desired.push(alwaysOnId);

  // The selected channel is foreground-only, whatever the duty state.
  if (foreground && eligible(activeId) && !desired.includes(activeId)) {
    desired.push(activeId);
  }

  return desired;
}
