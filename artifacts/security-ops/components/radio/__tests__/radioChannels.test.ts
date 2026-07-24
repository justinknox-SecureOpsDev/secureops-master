import { describe, it, expect } from "vitest";
import { selectSiteChannels, reconcileActiveId, type RadioChannel } from "../radioChannels";

/**
 * Coverage for the Radio screen's "Site Channels" section roster and the
 * active-channel reconciliation that runs after every focus-driven refetch.
 * RadioScreen itself is a React-Native component (no RN renderer in this Node
 * test runner), so we exercise the extracted pure helpers it delegates to.
 *
 * Key invariant: archived channels must NEVER render in the Site Channels
 * section — when an admin archives a site channel, the next focus refetch
 * must drop it from the list, and if it was the active channel the selection
 * must move off it.
 */

const ch = (over: Partial<RadioChannel> & { id: string }): RadioChannel => ({
  name: over.id,
  scope: "site",
  siteId: "s-" + over.id,
  siteName: null,
  adminOnly: false,
  archivedAt: null,
  ...over,
});

describe("selectSiteChannels", () => {
  it("excludes archived site channels", () => {
    const rows = [
      ch({ id: "a", siteName: "Alpha Site" }),
      ch({ id: "b", siteName: "Bravo Site", archivedAt: "2026-07-24T00:00:00Z" }),
      ch({ id: "c", siteName: "Charlie Site" }),
    ];
    expect(selectSiteChannels(rows).map((c) => c.id)).toEqual(["a", "c"]);
  });

  it("excludes non-site scopes (global / all_officers / admins)", () => {
    const rows = [
      ch({ id: "g", scope: "global" }),
      ch({ id: "o", scope: "all_officers" }),
      ch({ id: "ad", scope: "admins" }),
      ch({ id: "s1", siteName: "Depot" }),
    ];
    expect(selectSiteChannels(rows).map((c) => c.id)).toEqual(["s1"]);
  });

  it("reflects a newly created site channel on refetch (fresh list in, fresh roster out)", () => {
    const before = [ch({ id: "a", siteName: "Alpha" })];
    const after = [...before, ch({ id: "new", siteName: "New Mall" })];
    expect(selectSiteChannels(before).map((c) => c.id)).toEqual(["a"]);
    expect(selectSiteChannels(after).map((c) => c.id)).toEqual(["a", "new"]);
  });

  it("sorts by site name, falling back to channel name", () => {
    const rows = [
      ch({ id: "z", siteName: "Zulu Yard" }),
      ch({ id: "m", siteName: null, name: "Mid Channel" }),
      ch({ id: "a", siteName: "Alpha Plaza" }),
    ];
    expect(selectSiteChannels(rows).map((c) => c.id)).toEqual(["a", "m", "z"]);
  });
});

describe("reconcileActiveId", () => {
  it("keeps the current selection when it still exists un-archived", () => {
    const rows = [ch({ id: "a" }), ch({ id: "b" })];
    expect(reconcileActiveId(rows, "b")).toBe("b");
  });

  it("moves off a channel that was archived since the last fetch", () => {
    const rows = [ch({ id: "a" }), ch({ id: "b", archivedAt: "2026-07-24T00:00:00Z" })];
    expect(reconcileActiveId(rows, "b")).toBe("a");
  });

  it("moves off a channel that was deleted, and handles an empty list", () => {
    expect(reconcileActiveId([ch({ id: "a" })], "gone")).toBe("a");
    expect(reconcileActiveId([], "gone")).toBeNull();
  });

  it("selects the first channel when nothing was selected yet", () => {
    expect(reconcileActiveId([ch({ id: "first" }), ch({ id: "second" })], null)).toBe("first");
  });

  it("skips archived channels when falling back to a default selection", () => {
    const rows = [ch({ id: "arch", archivedAt: "2026-07-24T00:00:00Z" }), ch({ id: "live" })];
    expect(reconcileActiveId(rows, null)).toBe("live");
    expect(reconcileActiveId(rows, "gone")).toBe("live");
  });
});
