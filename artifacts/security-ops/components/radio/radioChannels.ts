// Pure channel-list helpers for the Radio screen. Kept free of any
// react-native imports so the Node test runner can exercise them directly
// (see .agents/memory/vitest-rn-import-parse-error.md).

export type RadioChannel = {
  id: string;
  name: string;
  scope: "global" | "all_officers" | "admins" | "site";
  siteId: string | null;
  siteName?: string | null;
  adminOnly: boolean;
  archivedAt: string | null;
};

/**
 * The "Site Channels" section roster: site-scoped, NON-archived channels,
 * sorted by site name for scanability. Archived channels must never render
 * here — an admin archiving a channel removes it from this list on the next
 * refetch (the Radio screen refetches on focus).
 */
export function selectSiteChannels<T extends Pick<RadioChannel, "scope" | "archivedAt" | "siteName" | "name">>(
  channels: T[],
): T[] {
  return channels
    .filter((c) => c.scope === "site" && !c.archivedAt)
    .sort((a, b) => (a.siteName ?? a.name).localeCompare(b.siteName ?? b.name));
}

/**
 * Pick the active channel id after a (re)fetch: keep the current selection if
 * it still exists and isn't archived, otherwise fall back to the first
 * channel in the fresh list (or null when empty).
 */
export function reconcileActiveId(
  channels: Array<Pick<RadioChannel, "id" | "archivedAt">>,
  currentId: string | null,
): string | null {
  const current = currentId ? channels.find((c) => c.id === currentId) : undefined;
  if (current && !current.archivedAt) return current.id;
  const firstLive = channels.find((c) => !c.archivedAt);
  return firstLive?.id ?? channels[0]?.id ?? null;
}
