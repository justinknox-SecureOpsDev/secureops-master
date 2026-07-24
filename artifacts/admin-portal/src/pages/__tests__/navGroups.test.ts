import { describe, it, expect } from "vitest";
import { buildNavGroups, resolveGroupKey, applyNavOrder } from "@/pages/AppShell";

/**
 * Locks in the role-aligned navigation IA and the route→group resolution that
 * drives the active top-level tab. This is the logic a recent reorg regressed:
 * the dispatcher Dispatch tab must stay Live-Map-only so chat/radio/personnel
 * resolve to the dedicated Comms tab (first-match-wins on item href), and
 * every admin table/page route must land in exactly one real group.
 */

const adminGroups = buildNavGroups(false);
const dispatcherGroups = buildNavGroups(true);

const keyOf = (groups: ReturnType<typeof buildNavGroups>, label: string) =>
  groups.find((g) => g.label === label)?.key;

describe("buildNavGroups", () => {
  it("gives admins the ten role-aligned groups in order", () => {
    expect(adminGroups.map((g) => g.key)).toEqual([
      "overview",
      "dispatch",
      "staffing",
      "hr",
      "compliance",
      "clients_sites",
      "contracts",
      "accounting",
      "account",
      "platform",
    ]);
  });

  it("places HR items under Personnel Management only", () => {
    const hr = adminGroups.find((g) => g.key === "hr");
    expect(hr?.items.map((i) => i.href)).toEqual([
      "/hr/applications",
      "/hr/application-builder",
      "/hr/onboarding",
      "/hr/invitations",
      "/hr/policies",
      "/hr/reports",
      "/tables/employees",
    ]);
  });

  it("groups compliance + training together", () => {
    const compliance = adminGroups.find((g) => g.key === "compliance");
    expect(compliance?.items.map((i) => i.href)).toContain(
      "/tables/training-certifications",
    );
    expect(compliance?.items.map((i) => i.href)).toContain("/tables/licenses");
  });

  it("Clients & Sites tab holds sales leads, clients, sites, and client users", () => {
    const cs = adminGroups.find((g) => g.key === "clients_sites");
    expect(cs?.items.map((i) => i.href)).toEqual([
      "/tables/sales_leads",
      "/tables/clients",
      "/tables/sites",
      "/hr/client-users",
    ]);
  });

  it("Contracts tab holds subcontractor items only", () => {
    const contracts = adminGroups.find((g) => g.key === "contracts");
    expect(contracts?.items.map((i) => i.href)).toEqual([
      "/tables/subcontractors",
      "/tables/subcontractor_cois",
      "/tables/subcontractor_contracts",
      "/tables/subcontractor_invoices",
      "/subcontractors/pay-run",
      "/subcontractors/clock-in-entries",
    ]);
  });

  it("Account tab holds only My Account and is visible to admins", () => {
    const account = adminGroups.find((g) => g.key === "account");
    expect(account?.items.map((i) => i.href)).toEqual(["/account/security"]);
  });

  it("Platform tab holds system/admin items", () => {
    const platform = adminGroups.find((g) => g.key === "platform");
    expect(platform?.items.map((i) => i.href)).toContain("/tables/users");
    expect(platform?.items.map((i) => i.href)).toContain("/audit-log");
    expect(platform?.items.map((i) => i.href)).toContain("/exports");
    expect(platform?.items.map((i) => i.href)).not.toContain("/account/security");
  });

  it("never lists the same route in two admin groups", () => {
    const seen = new Set<string>();
    for (const g of adminGroups) {
      for (const item of g.items) {
        expect(seen.has(item.href)).toBe(false);
        seen.add(item.href);
      }
    }
  });

  it("keeps the dispatcher Dispatch tab Live-Map-only", () => {
    const dispatch = dispatcherGroups.find((g) => g.key === "dispatch");
    expect(dispatch?.items.map((i) => i.href)).toEqual(["/dispatch"]);
  });

  it("gives dispatchers a Comms tab (not Security) that owns chat/radio/personnel", () => {
    expect(dispatcherGroups.find((g) => g.key === "security")).toBeUndefined();
    const comms = dispatcherGroups.find((g) => g.key === "comms");
    expect(comms?.label).toBe("Comms");
    expect(comms?.items.map((i) => i.href)).toEqual([
      "/chat",
      "/personnel",
      "/radio",
    ]);
  });

  it("gives dispatchers an Account tab instead of Settings", () => {
    expect(dispatcherGroups.find((g) => g.key === "settings")).toBeUndefined();
    const account = dispatcherGroups.find((g) => g.key === "account");
    expect(account?.items.map((i) => i.href)).toEqual(["/account/security"]);
  });

  it("dispatchers do not see a Platform tab", () => {
    expect(dispatcherGroups.find((g) => g.key === "platform")).toBeUndefined();
  });
});

describe("buildNavGroups feature filtering", () => {
  it("defaults to all-enabled so groups are unchanged when no predicate is passed", () => {
    const withDefault = buildNavGroups(false);
    const withAllEnabled = buildNavGroups(false, false, () => true);
    expect(withDefault.map((g) => g.key)).toEqual(withAllEnabled.map((g) => g.key));
    for (let i = 0; i < withDefault.length; i++) {
      expect(withDefault[i].items.map((it) => it.href)).toEqual(
        withAllEnabled[i].items.map((it) => it.href),
      );
    }
  });

  it("drops items whose feature flag is disabled", () => {
    const enabled = buildNavGroups(false, false, () => true)
      .flatMap((g) => g.items)
      .map((it) => it.href);
    const disabled = buildNavGroups(false, false, (key) => key !== "hr")
      .flatMap((g) => g.items)
      .map((it) => it.href);
    const removed = enabled.filter((href) => !disabled.includes(href));
    expect(removed).toContain("/hr/applications");
    expect(removed).toContain("/hr/onboarding");
    expect(removed).toContain("/hr/invitations");
  });

  it("drops a group entirely when every item is feature-gated off", () => {
    // The dispatcher Dispatch tab is Live-Map-only, so gating off liveMap
    // leaves the group empty and it must disappear.
    const groups = buildNavGroups(true, false, (key) => key !== "liveMap");
    expect(groups.find((g) => g.key === "dispatch")).toBeUndefined();
  });

  it("keeps the ungated Analytics item when payroll & invoicing are gated off", () => {
    const groups = buildNavGroups(false, false, (key) => key !== "payroll" && key !== "invoicing");
    const accounting = groups.find((g) => g.key === "accounting");
    expect(accounting?.items.map((i) => i.href)).toEqual(["/analytics"]);
  });

  it("keeps ungated items even when other features are disabled", () => {
    const groups = buildNavGroups(false, false, () => false);
    const allHrefs = groups.flatMap((g) => g.items).map((it) => it.href);
    expect(allHrefs).toContain("/tables/shifts");
  });
});

describe("resolveGroupKey (admin)", () => {
  const cases: Array<[string, string]> = [
    ["/dispatch", "dispatch"],
    ["/chat", "dispatch"],
    ["/tables/incidents", "dispatch"],
    ["/dar/123", "dispatch"],
    ["/tables/shifts", "staffing"],
    ["/shifts/calendar", "staffing"],
    ["/swap-requests", "staffing"],
    ["/staffing/42", "staffing"],
    ["/hr/applications", "hr"],
    ["/hr/coverage-requests", "staffing"],
    ["/compliance", "compliance"],
    ["/tables/licenses", "compliance"],
    ["/tables/training-certifications", "compliance"],
    ["/tables/clients", "clients_sites"],
    ["/sites/abc", "clients_sites"],
    ["/tables/sales_leads", "clients_sites"],
    ["/subcontractors/pay-run", "contracts"],
    ["/tables/subcontractors", "contracts"],
    ["/payroll/board", "accounting"],
    ["/invoices/board", "accounting"],
    ["/analytics", "accounting"],
    ["/account/security", "account"],
    ["/tables/users", "platform"],
    ["/settings/invite", "platform"],
    ["/audit-log", "platform"],
    ["/exports", "platform"],
  ];

  it.each(cases)("resolves %s -> %s", (location, expected) => {
    expect(resolveGroupKey(adminGroups, location)).toBe(expected);
  });

  it("returns null for an unmapped route", () => {
    expect(resolveGroupKey(adminGroups, "/totally-unknown")).toBeNull();
  });

  it("only ever returns keys that exist in the built groups", () => {
    const validKeys = new Set(adminGroups.map((g) => g.key));
    for (const [location] of cases) {
      const key = resolveGroupKey(adminGroups, location);
      expect(key).not.toBeNull();
      expect(validKeys.has(key as string)).toBe(true);
    }
  });
});

describe("resolveGroupKey (dispatcher)", () => {
  it("routes chat/radio/personnel to the Comms tab, not Dispatch", () => {
    expect(resolveGroupKey(dispatcherGroups, "/chat")).toBe("comms");
    expect(resolveGroupKey(dispatcherGroups, "/radio")).toBe("comms");
    expect(resolveGroupKey(dispatcherGroups, "/personnel")).toBe("comms");
  });

  it("routes the live map to Dispatch", () => {
    expect(resolveGroupKey(dispatcherGroups, "/dispatch")).toBe("dispatch");
  });

  it("routes account to the Account tab", () => {
    expect(resolveGroupKey(dispatcherGroups, "/account/security")).toBe("account");
  });
});

describe("applyNavOrder — stale key migration", () => {
  it("silently drops retired keys and appends new tabs in default order", () => {
    // A user who saved their order before the nav restructure will have the
    // three retired keys: "administration", "security", "settings".
    // applyNavOrder must drop them and append the five new tabs that were not
    // in the saved preference at all.
    const staleOrder = [
      "overview",
      "dispatch",
      "staffing",
      "administration", // retired
      "security",       // retired
      "settings",       // retired
    ];

    const result = applyNavOrder(adminGroups, staleOrder);
    const keys = result.map((g) => g.key);

    // Retired keys must not appear
    expect(keys).not.toContain("administration");
    expect(keys).not.toContain("security");
    expect(keys).not.toContain("settings");

    // The saved valid keys appear first, in saved order
    expect(keys.indexOf("overview")).toBeLessThan(keys.indexOf("dispatch"));
    expect(keys.indexOf("dispatch")).toBeLessThan(keys.indexOf("staffing"));

    // Every current group must still be reachable — no tab dropped
    const defaultKeys = adminGroups.map((g) => g.key);
    for (const key of defaultKeys) {
      expect(keys).toContain(key);
    }

    // New tabs not present in the stale order are appended in default order
    const newTabs = ["hr", "compliance", "clients_sites", "contracts", "accounting", "account", "platform"];
    const appendedPositions = newTabs.map((k) => keys.indexOf(k));
    // All new tabs come after the last known saved key ("staffing")
    const staffingIdx = keys.indexOf("staffing");
    for (const pos of appendedPositions) {
      expect(pos).toBeGreaterThan(staffingIdx);
    }
    // New tabs appear in the same relative order as the default group list
    for (let i = 0; i < appendedPositions.length - 1; i++) {
      expect(appendedPositions[i]).toBeLessThan(appendedPositions[i + 1]);
    }
  });

  it("returns all groups intact when saved order is null or empty", () => {
    expect(applyNavOrder(adminGroups, null)).toEqual(adminGroups);
    expect(applyNavOrder(adminGroups, [])).toEqual(adminGroups);
  });

  it("handles a saved order that is entirely stale keys", () => {
    const allStale = ["administration", "security", "settings"];
    const result = applyNavOrder(adminGroups, allStale);
    // All current groups appended in default order
    expect(result.map((g) => g.key)).toEqual(adminGroups.map((g) => g.key));
  });

  it("fully-stale dispatcher saved order (only retired keys) yields the complete tab list", () => {
    // Saved order contains ONLY the two retired dispatcher keys — no valid key at all.
    // applyNavOrder must return all dispatcher groups in default order.
    const result = applyNavOrder(dispatcherGroups, ["security", "settings"]);
    expect(result).toEqual(dispatcherGroups);
  });

  it("drops dispatcher's retired 'security'/'settings' keys and appends comms + account in default order", () => {
    // A dispatcher who saved their tab order before the restructure would have
    // "security" (now "comms") and "settings" (now "account") in their saved preference.
    // applyNavOrder must drop both retired keys and append the current dispatcher
    // groups that were absent from the saved preference in their default order.
    const staleOrder = [
      "dispatch",
      "security",   // retired — now "comms"
      "settings",   // retired — now "account"
    ];

    const result = applyNavOrder(dispatcherGroups, staleOrder);
    const keys = result.map((g) => g.key);

    // Retired keys must not appear
    expect(keys).not.toContain("security");
    expect(keys).not.toContain("settings");

    // The one valid saved key appears first
    expect(keys[0]).toBe("dispatch");

    // All current dispatcher groups must be present
    const defaultKeys = dispatcherGroups.map((g) => g.key);
    for (const key of defaultKeys) {
      expect(keys).toContain(key);
    }

    // comms and account are appended after dispatch (in default group order)
    const dispatchIdx = keys.indexOf("dispatch");
    const commsIdx = keys.indexOf("comms");
    const accountIdx = keys.indexOf("account");
    expect(commsIdx).toBeGreaterThan(dispatchIdx);
    expect(accountIdx).toBeGreaterThan(dispatchIdx);
    // comms appears before account (matching dispatcher default group order)
    expect(commsIdx).toBeLessThan(accountIdx);
  });
});
