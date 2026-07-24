/**
 * Unit tests for the live-officer map pure helpers.
 *
 * These cover:
 *   (a) buildLeafletHtml emits a diamond marker class when a site has geocoords
 *   (b) the Radio button postMessage is omitted when siteChannelId is absent/null
 *   (c) the wcsg:openSiteRadio postMessage wires to the onOpenSiteRadio callback
 *       via handleMapMessage (the same code the React component's window listener
 *       delegates to)
 *   (d) wcsg:openOfficer still routes to onSelectOfficer (regression guard)
 *
 * Imported from liveOfficerMapHelpers.ts (the RN-free module) so Vitest doesn't
 * choke on react-native's `import typeof` Flow extension.
 */
import { describe, it, expect, vi } from "vitest";
import {
  buildLeafletHtml,
  handleMapMessage,
  deriveSitePoints,
  type SitePoint,
  type ActiveOfficerCoords,
} from "../liveOfficerMapHelpers";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const OFFICER_POINT = {
  lat: 30.267153,
  lng: -97.743061,
  label: "J. Smith",
  sub: "Day Shift",
  userId: "user-1",
};

const SITE_NO_CHANNEL: SitePoint = {
  lat: 30.27,
  lng: -97.74,
  name: "HQ",
  siteChannelId: null,
};

const SITE_WITH_CHANNEL: SitePoint = {
  lat: 30.27,
  lng: -97.74,
  name: "HQ",
  siteChannelId: "chan-hq-1",
};

// ---------------------------------------------------------------------------
// buildLeafletHtml — officer markers (regression guard)
// ---------------------------------------------------------------------------

describe("buildLeafletHtml — officer markers", () => {
  it("emits wcsg:openOfficer postMessage code for each officer", () => {
    const html = buildLeafletHtml([OFFICER_POINT], []);
    expect(html).toContain("wcsg:openOfficer");
    expect(html).toContain("user-1");
  });

  it("includes no officer data in pts payload when points array is empty", () => {
    const html = buildLeafletHtml([], []);
    // The JSON data payload for officers must be an empty array so no markers render.
    expect(html).toContain("const pts = []");
  });

  it("includes the officer label and sub text in the data payload", () => {
    const html = buildLeafletHtml([OFFICER_POINT], []);
    expect(html).toContain("J. Smith");
    expect(html).toContain("Day Shift");
  });
});

// ---------------------------------------------------------------------------
// buildLeafletHtml — site diamond markers
// ---------------------------------------------------------------------------

describe("buildLeafletHtml — site markers", () => {
  it("emits a site-diamond marker class when a site point is provided", () => {
    const html = buildLeafletHtml([], [SITE_NO_CHANNEL]);
    expect(html).toContain("site-diamond");
  });

  it("includes the site name in the popup data", () => {
    const html = buildLeafletHtml([], [SITE_NO_CHANNEL]);
    expect(html).toContain('"HQ"');
  });

  it("includes no site data in sitePts payload when sites array is empty", () => {
    const html = buildLeafletHtml([OFFICER_POINT], []);
    // The JSON data payload for sites must be an empty array so no diamond markers render.
    expect(html).toContain("const sitePts = []");
  });

  it("emits Radio button postMessage code and the channel ID in the data when siteChannelId is non-null", () => {
    const html = buildLeafletHtml([], [SITE_WITH_CHANNEL]);
    // The wcsg:openSiteRadio type string is in the popup builder.
    expect(html).toContain("wcsg:openSiteRadio");
    // The channel ID must appear in the JSON data payload so the runtime if-check passes.
    expect(html).toContain('"chan-hq-1"');
  });

  it("site data payload carries null channelId when siteChannelId is null (no radio button at runtime)", () => {
    const html = buildLeafletHtml([], [SITE_NO_CHANNEL]);
    // The siteChannelId field must be null in the JSON — the runtime `if (siteChannelId)` guard
    // in sitePopupNode evaluates to false, so no Radio button is appended to the popup DOM.
    expect(html).toContain('"siteChannelId":null');
    // No non-null channel ID string appears anywhere in the JSON data.
    expect(html).not.toMatch(/"siteChannelId":"[^"]+"/);
  });

  it("site data payload has no siteChannelId key when siteChannelId is undefined", () => {
    const site: SitePoint = { lat: 30.27, lng: -97.74, name: "East Wing" };
    const html = buildLeafletHtml([], [site]);
    // JSON.stringify omits undefined keys, so no siteChannelId field appears in the data.
    // The runtime guard `if (siteChannelId)` will be falsy (undefined/missing), so no
    // Radio button is appended to the popup DOM.
    expect(html).not.toMatch(/"siteChannelId":"[^"]+"/);
  });

  it("can render both officer markers and site markers in the same map", () => {
    const html = buildLeafletHtml([OFFICER_POINT], [SITE_WITH_CHANNEL]);
    // Both popup builder function types are present in the script.
    expect(html).toContain("wcsg:openOfficer");
    expect(html).toContain("wcsg:openSiteRadio");
    // Site-diamond CSS class is always emitted in the <style> block.
    expect(html).toContain("site-diamond");
    // Both data payloads are non-empty.
    expect(html).toContain('"user-1"');
    expect(html).toContain('"chan-hq-1"');
  });

  it("XSS guard: popup builder uses createTextNode (not innerHTML) for site name", () => {
    const xssSite: SitePoint = {
      lat: 30.0,
      lng: -97.0,
      name: '<img onerror="alert(1)">',
      siteChannelId: null,
    };
    const html = buildLeafletHtml([], [xssSite]);
    // The popup builder must use createTextNode so the site name is rendered as
    // text even when it contains HTML tags — this is the actual XSS guard.
    expect(html).toContain("createTextNode");
    // Must never call innerHTML to set user-supplied content.
    expect(html).not.toContain("innerHTML");
  });
});

// ---------------------------------------------------------------------------
// handleMapMessage — wcsg:openOfficer (regression guard)
// ---------------------------------------------------------------------------

describe("handleMapMessage — wcsg:openOfficer (regression guard)", () => {
  it("routes a valid wcsg:openOfficer message to onSelectOfficer", () => {
    const onSelectOfficer = vi.fn();
    handleMapMessage({ type: "wcsg:openOfficer", userId: "user-42" }, { onSelectOfficer });
    expect(onSelectOfficer).toHaveBeenCalledOnce();
    expect(onSelectOfficer).toHaveBeenCalledWith("user-42");
  });

  it("ignores wcsg:openOfficer when userId is empty string", () => {
    const onSelectOfficer = vi.fn();
    handleMapMessage({ type: "wcsg:openOfficer", userId: "" }, { onSelectOfficer });
    expect(onSelectOfficer).not.toHaveBeenCalled();
  });

  it("ignores wcsg:openOfficer when userId is not a string", () => {
    const onSelectOfficer = vi.fn();
    handleMapMessage({ type: "wcsg:openOfficer", userId: 999 }, { onSelectOfficer });
    expect(onSelectOfficer).not.toHaveBeenCalled();
  });

  it("does not call onOpenSiteRadio for a wcsg:openOfficer message", () => {
    const onOpenSiteRadio = vi.fn();
    handleMapMessage({ type: "wcsg:openOfficer", userId: "user-42" }, { onOpenSiteRadio });
    expect(onOpenSiteRadio).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// handleMapMessage — wcsg:openSiteRadio
// ---------------------------------------------------------------------------

describe("handleMapMessage — wcsg:openSiteRadio", () => {
  it("routes a valid wcsg:openSiteRadio message to onOpenSiteRadio", () => {
    const onOpenSiteRadio = vi.fn();
    handleMapMessage(
      { type: "wcsg:openSiteRadio", channelId: "chan-hq-1", siteName: "HQ" },
      { onOpenSiteRadio },
    );
    expect(onOpenSiteRadio).toHaveBeenCalledOnce();
    expect(onOpenSiteRadio).toHaveBeenCalledWith("chan-hq-1", "HQ");
  });

  it("coerces missing siteName to empty string", () => {
    const onOpenSiteRadio = vi.fn();
    handleMapMessage({ type: "wcsg:openSiteRadio", channelId: "chan-1" }, { onOpenSiteRadio });
    expect(onOpenSiteRadio).toHaveBeenCalledWith("chan-1", "");
  });

  it("ignores wcsg:openSiteRadio when channelId is empty string", () => {
    const onOpenSiteRadio = vi.fn();
    handleMapMessage({ type: "wcsg:openSiteRadio", channelId: "" }, { onOpenSiteRadio });
    expect(onOpenSiteRadio).not.toHaveBeenCalled();
  });

  it("ignores wcsg:openSiteRadio when channelId is missing", () => {
    const onOpenSiteRadio = vi.fn();
    handleMapMessage({ type: "wcsg:openSiteRadio" }, { onOpenSiteRadio });
    expect(onOpenSiteRadio).not.toHaveBeenCalled();
  });

  it("does not call onSelectOfficer for a wcsg:openSiteRadio message", () => {
    const onSelectOfficer = vi.fn();
    handleMapMessage(
      { type: "wcsg:openSiteRadio", channelId: "chan-hq-1", siteName: "HQ" },
      { onSelectOfficer },
    );
    expect(onSelectOfficer).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// handleMapMessage — liveOps:officerLeft (WS clock-out push)
// ---------------------------------------------------------------------------

describe("handleMapMessage — liveOps:officerLeft", () => {
  it("routes a valid liveOps:officerLeft message to onOfficerLeft", () => {
    const onOfficerLeft = vi.fn();
    handleMapMessage({ type: "liveOps:officerLeft", userId: "user-7" }, { onOfficerLeft });
    expect(onOfficerLeft).toHaveBeenCalledOnce();
    expect(onOfficerLeft).toHaveBeenCalledWith("user-7");
  });

  it("ignores liveOps:officerLeft when userId is empty string", () => {
    const onOfficerLeft = vi.fn();
    handleMapMessage({ type: "liveOps:officerLeft", userId: "" }, { onOfficerLeft });
    expect(onOfficerLeft).not.toHaveBeenCalled();
  });

  it("ignores liveOps:officerLeft when userId is not a string", () => {
    const onOfficerLeft = vi.fn();
    handleMapMessage({ type: "liveOps:officerLeft", userId: 42 }, { onOfficerLeft });
    expect(onOfficerLeft).not.toHaveBeenCalled();
  });

  it("ignores liveOps:officerLeft when userId is missing", () => {
    const onOfficerLeft = vi.fn();
    handleMapMessage({ type: "liveOps:officerLeft" }, { onOfficerLeft });
    expect(onOfficerLeft).not.toHaveBeenCalled();
  });

  it("does not call onSelectOfficer or onOpenSiteRadio for an officerLeft message", () => {
    const onSelectOfficer = vi.fn();
    const onOpenSiteRadio = vi.fn();
    handleMapMessage(
      { type: "liveOps:officerLeft", userId: "user-7" },
      { onSelectOfficer, onOpenSiteRadio },
    );
    expect(onSelectOfficer).not.toHaveBeenCalled();
    expect(onOpenSiteRadio).not.toHaveBeenCalled();
  });

  it("does not call onOfficerLeft for wcsg:openOfficer messages", () => {
    const onOfficerLeft = vi.fn();
    handleMapMessage({ type: "wcsg:openOfficer", userId: "user-7" }, { onOfficerLeft });
    expect(onOfficerLeft).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// handleMapMessage — liveOps:officerJoined (WS clock-in push)
// ---------------------------------------------------------------------------

describe("handleMapMessage — liveOps:officerJoined", () => {
  it("routes a valid liveOps:officerJoined message to onOfficerJoined", () => {
    const onOfficerJoined = vi.fn();
    handleMapMessage({ type: "liveOps:officerJoined", userId: "user-9" }, { onOfficerJoined });
    expect(onOfficerJoined).toHaveBeenCalledOnce();
    expect(onOfficerJoined).toHaveBeenCalledWith("user-9");
  });

  it("ignores liveOps:officerJoined when userId is empty string", () => {
    const onOfficerJoined = vi.fn();
    handleMapMessage({ type: "liveOps:officerJoined", userId: "" }, { onOfficerJoined });
    expect(onOfficerJoined).not.toHaveBeenCalled();
  });

  it("ignores liveOps:officerJoined when userId is not a string", () => {
    const onOfficerJoined = vi.fn();
    handleMapMessage({ type: "liveOps:officerJoined", userId: 42 }, { onOfficerJoined });
    expect(onOfficerJoined).not.toHaveBeenCalled();
  });

  it("ignores liveOps:officerJoined when userId is missing", () => {
    const onOfficerJoined = vi.fn();
    handleMapMessage({ type: "liveOps:officerJoined" }, { onOfficerJoined });
    expect(onOfficerJoined).not.toHaveBeenCalled();
  });

  it("does not call other callbacks for an officerJoined message", () => {
    const onSelectOfficer = vi.fn();
    const onOpenSiteRadio = vi.fn();
    const onOfficerLeft = vi.fn();
    handleMapMessage(
      { type: "liveOps:officerJoined", userId: "user-9" },
      { onSelectOfficer, onOpenSiteRadio, onOfficerLeft },
    );
    expect(onSelectOfficer).not.toHaveBeenCalled();
    expect(onOpenSiteRadio).not.toHaveBeenCalled();
    expect(onOfficerLeft).not.toHaveBeenCalled();
  });

  it("does not call onOfficerJoined for liveOps:officerLeft messages", () => {
    const onOfficerJoined = vi.fn();
    handleMapMessage({ type: "liveOps:officerLeft", userId: "user-9" }, { onOfficerJoined });
    expect(onOfficerJoined).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// handleMapMessage — unknown / malformed messages
// ---------------------------------------------------------------------------

describe("handleMapMessage — unknown / malformed messages", () => {
  it("ignores null data", () => {
    const onSelectOfficer = vi.fn();
    const onOpenSiteRadio = vi.fn();
    handleMapMessage(null, { onSelectOfficer, onOpenSiteRadio });
    expect(onSelectOfficer).not.toHaveBeenCalled();
    expect(onOpenSiteRadio).not.toHaveBeenCalled();
  });

  it("ignores primitive data", () => {
    const onSelectOfficer = vi.fn();
    handleMapMessage("wcsg:openOfficer", { onSelectOfficer });
    expect(onSelectOfficer).not.toHaveBeenCalled();
  });

  it("ignores an unknown message type without throwing", () => {
    const onSelectOfficer = vi.fn();
    const onOpenSiteRadio = vi.fn();
    expect(() =>
      handleMapMessage({ type: "other:event", payload: "x" }, { onSelectOfficer, onOpenSiteRadio }),
    ).not.toThrow();
    expect(onSelectOfficer).not.toHaveBeenCalled();
    expect(onOpenSiteRadio).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// deriveSitePoints — deduplication helper
// ---------------------------------------------------------------------------

describe("deriveSitePoints", () => {
  const makeOfficer = (overrides: Partial<ActiveOfficerCoords>): ActiveOfficerCoords => ({
    userId: "u1",
    ...overrides,
  });

  it("returns an empty array when no officers have site coords", () => {
    const result = deriveSitePoints([makeOfficer({ siteLat: null, siteLng: null })]);
    expect(result).toHaveLength(0);
  });

  it("returns one site point per geocoded site (deduplicates same lat/lng)", () => {
    const officers = [
      makeOfficer({ userId: "u1", siteLat: "30.27", siteLng: "-97.74", siteName: "HQ", siteChannelId: "chan-1" }),
      makeOfficer({ userId: "u2", siteLat: "30.27", siteLng: "-97.74", siteName: "HQ", siteChannelId: "chan-1" }),
    ];
    const result = deriveSitePoints(officers);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("HQ");
    expect(result[0].siteChannelId).toBe("chan-1");
  });

  it("returns distinct entries for officers at different sites", () => {
    const officers = [
      makeOfficer({ userId: "u1", siteLat: "30.27", siteLng: "-97.74", siteName: "HQ", siteChannelId: "chan-1" }),
      makeOfficer({ userId: "u2", siteLat: "29.76", siteLng: "-95.37", siteName: "South", siteChannelId: null }),
    ];
    const result = deriveSitePoints(officers);
    expect(result).toHaveLength(2);
    expect(result.map((s) => s.name).sort()).toEqual(["HQ", "South"]);
  });

  it("skips officers missing siteName", () => {
    const result = deriveSitePoints([
      makeOfficer({ siteLat: "30.27", siteLng: "-97.74", siteName: null }),
    ]);
    expect(result).toHaveLength(0);
  });

  it("skips officers with non-finite site coords", () => {
    const result = deriveSitePoints([
      makeOfficer({ siteLat: "abc", siteLng: "-97.74", siteName: "Bad" }),
    ]);
    expect(result).toHaveLength(0);
  });

  it("preserves siteChannelId=null for sites without a radio channel", () => {
    const result = deriveSitePoints([
      makeOfficer({ siteLat: "30.27", siteLng: "-97.74", siteName: "Annex", siteChannelId: null }),
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].siteChannelId).toBeNull();
  });
});
