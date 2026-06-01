import { describe, it, expect } from "vitest";
import {
  resolveDeepLinkFilter,
  findHighlightIndex,
  isHighlightedIncident,
} from "../incidentDeepLink";
import { resolveNotificationTarget } from "../resolveNotificationTarget";

// Models one admin Incidents screen render: which status filter is active, the
// incident fetched by id from the deep link, and the list currently showing for
// that filter. The helpers decide whether to switch filters and where the
// target row sits.
type Incident = { id: string; status: string };

function listFor(all: Incident[], filter: string): Incident[] {
  return all.filter((i) => i.status === filter);
}

// A realistic spread of incidents across every status bucket.
const ALL: Incident[] = [
  { id: "a", status: "open" },
  { id: "b", status: "open" },
  { id: "c", status: "under_review" },
  { id: "d", status: "resolved" },
  { id: "e", status: "closed" },
];

describe("incident alert deep-link reveal", () => {
  describe("resolveNotificationTarget wiring (emergency alert -> incidents)", () => {
    it("carries the incidentId param admins land on the screen with", () => {
      const target = resolveNotificationTarget(
        { type: "emergency", incidentId: "c" },
        "admin",
      );
      expect(target).toEqual({
        pathname: "/(admin)/incidents",
        params: { incidentId: "c" },
      });
    });
  });

  describe("resolveDeepLinkFilter", () => {
    it("switches to the incident's status when a different filter is active", () => {
      // Admin is viewing "open"; the alert targets an under_review incident.
      expect(resolveDeepLinkFilter("c", { id: "c", status: "under_review" }, "open")).toBe(
        "under_review",
      );
    });

    it("switches when the incident has since moved to resolved", () => {
      // Tapped from a stale push: the incident is now resolved, filter is open.
      expect(resolveDeepLinkFilter("d", { id: "d", status: "resolved" }, "open")).toBe(
        "resolved",
      );
    });

    it("does not switch when the incident already matches the active filter", () => {
      expect(resolveDeepLinkFilter("a", { id: "a", status: "open" }, "open")).toBeNull();
    });

    it("does not switch when the incident hasn't loaded yet or was deleted", () => {
      expect(resolveDeepLinkFilter("zzz", null, "open")).toBeNull();
      expect(resolveDeepLinkFilter("zzz", undefined, "open")).toBeNull();
    });

    it("does not switch when there is no deep link at all", () => {
      expect(resolveDeepLinkFilter(undefined, { id: "a", status: "open" }, "open")).toBeNull();
    });

    it("does not switch when the fetched incident has no status", () => {
      expect(resolveDeepLinkFilter("a", { id: "a", status: null }, "open")).toBeNull();
    });
  });

  describe("findHighlightIndex", () => {
    it("finds the target row once the matching filter's list has loaded", () => {
      const list = listFor(ALL, "under_review");
      expect(findHighlightIndex(list, "c")).toBe(0);
    });

    it("returns -1 while the wrong filter's list is still showing", () => {
      // Filter switch hasn't completed yet: list is the open bucket, target is c.
      const openList = listFor(ALL, "open");
      expect(findHighlightIndex(openList, "c")).toBe(-1);
    });

    it("returns -1 for a stale/deleted id (graceful no-op)", () => {
      const list = listFor(ALL, "open");
      expect(findHighlightIndex(list, "ghost")).toBe(-1);
    });

    it("returns -1 when there is no deep link or the list is absent", () => {
      expect(findHighlightIndex(ALL, undefined)).toBe(-1);
      expect(findHighlightIndex(null, "a")).toBe(-1);
      expect(findHighlightIndex(undefined, "a")).toBe(-1);
    });
  });

  describe("isHighlightedIncident", () => {
    it("flags only the deep-link target row", () => {
      expect(isHighlightedIncident("c", "c")).toBe(true);
      expect(isHighlightedIncident("a", "c")).toBe(false);
    });

    it("flags nothing when there is no deep link", () => {
      expect(isHighlightedIncident("c", undefined)).toBe(false);
    });
  });

  // End-to-end of the screen-side logic: an alert tap arrives while a different
  // filter is active, the filter switches to the incident's status, the matching
  // list loads, and the target row is found + highlighted.
  describe("full reveal flow", () => {
    function reveal(target: Incident, activeFilter: string) {
      const fetched = { id: target.id, status: target.status };
      const nextFilter = resolveDeepLinkFilter(target.id, fetched, activeFilter);
      const effectiveFilter = nextFilter ?? activeFilter;
      const list = listFor(ALL, effectiveFilter);
      const index = findHighlightIndex(list, target.id);
      return {
        switched: nextFilter !== null,
        effectiveFilter,
        index,
        highlighted: index >= 0 && isHighlightedIncident(list[index].id, target.id),
      };
    }

    it("incident under a non-default filter: switches, finds, highlights", () => {
      const r = reveal({ id: "c", status: "under_review" }, "open");
      expect(r.switched).toBe(true);
      expect(r.effectiveFilter).toBe("under_review");
      expect(r.index).toBe(0);
      expect(r.highlighted).toBe(true);
    });

    it("incident moved to resolved: switches to resolved, finds, highlights", () => {
      const r = reveal({ id: "d", status: "resolved" }, "open");
      expect(r.switched).toBe(true);
      expect(r.effectiveFilter).toBe("resolved");
      expect(r.highlighted).toBe(true);
    });

    it("incident already under the active filter: no switch, still highlights", () => {
      const r = reveal({ id: "a", status: "open" }, "open");
      expect(r.switched).toBe(false);
      expect(r.effectiveFilter).toBe("open");
      expect(r.index).toBeGreaterThanOrEqual(0);
      expect(r.highlighted).toBe(true);
    });

    it("stale/deleted id: no switch, nothing found, nothing highlighted", () => {
      const fetched = undefined; // useGetIncident returns nothing for a dead id
      const nextFilter = resolveDeepLinkFilter("ghost", fetched, "open");
      const effectiveFilter = nextFilter ?? "open";
      const list = listFor(ALL, effectiveFilter);
      expect(nextFilter).toBeNull();
      expect(findHighlightIndex(list, "ghost")).toBe(-1);
      expect(isHighlightedIncident("a", "ghost")).toBe(false);
    });
  });
});
