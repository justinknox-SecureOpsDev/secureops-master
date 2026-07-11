import { describe, it, expect } from "vitest";
import { applyNavOrder, buildNavGroups, resolveGroupKey } from "@/pages/AppShell";

/**
 * Locks in the role-aligned navigation IA and the route→group resolution that
 * drives the active top-level tab. This is the logic a recent reorg regressed:
 * the dispatcher Dispatch tab must stay Live-Map-only so chat/radio/personnel
 * resolve to the dedicated Security tab (first-match-wins on item href), and
 * every admin table/page route must land in exactly one real group.
 */

const adminGroups = buildNavGroups(false);
const dispatcherGroups = buildNavGroups(true);

const keyOf = (groups: ReturnType<typeof buildNavGroups>, label: string) =>
  groups.find((g) => g.label === label)?.key;

describe("buildNavGroups", () => {
  it("gives admins the eight role-aligned groups in order", () => {
    expect(adminGroups.map((g) => g.key)).toEqual([
      "overview",
      "dispatch",
      "staffing",
      "hr",
      "compliance",
      "administration",
      "accounting",
      "settings",
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

  it("gives dispatchers a Security tab that owns chat/radio/personnel", () => {
    const security = dispatcherGroups.find((g) => g.key === "security");
    expect(security?.items.map((i) => i.href)).toEqual([
      "/chat",
      "/personnel",
      "/radio",
    ]);
  });
});

describe("resolveGroupKey (admin)", () => {
  const cases: Array<[string, string]> = [
    ["/", "overview"],
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
    ["/tables/clients", "administration"],
    ["/sites/abc", "administration"],
    ["/subcontractors/pay-run", "administration"],
    ["/analytics", "accounting"],
    ["/payroll/board", "accounting"],
    ["/invoices/board", "accounting"],
    ["/tables/users", "settings"],
    ["/audit-log", "settings"],
    ["/exports", "settings"],
    ["/account/security", "settings"],
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

describe("applyNavOrder", () => {
  const defaultKeys = adminGroups.map((g) => g.key);

  it("returns the default order when no preference is saved", () => {
    expect(applyNavOrder(adminGroups, null).map((g) => g.key)).toEqual(defaultKeys);
    expect(applyNavOrder(adminGroups, undefined).map((g) => g.key)).toEqual(defaultKeys);
    expect(applyNavOrder(adminGroups, []).map((g) => g.key)).toEqual(defaultKeys);
  });

  it("reorders groups to match the saved preference", () => {
    const reversed = [...defaultKeys].reverse();
    expect(applyNavOrder(adminGroups, reversed).map((g) => g.key)).toEqual(reversed);
  });

  it("ignores unknown/stale keys from the preference", () => {
    const out = applyNavOrder(adminGroups, ["ghost-tab", "accounting", "overview"]);
    expect(out.map((g) => g.key)).toEqual([
      "accounting",
      "overview",
      ...defaultKeys.filter((k) => k !== "accounting" && k !== "overview"),
    ]);
  });

  it("appends newly shipped groups missing from the preference in default order", () => {
    const partial = ["settings", "dispatch"];
    const out = applyNavOrder(adminGroups, partial).map((g) => g.key);
    expect(out.slice(0, 2)).toEqual(partial);
    expect(out).toHaveLength(defaultKeys.length);
    expect(out.slice(2)).toEqual(defaultKeys.filter((k) => !partial.includes(k)));
  });

  it("drops duplicate keys, keeping the first occurrence", () => {
    const out = applyNavOrder(adminGroups, ["accounting", "accounting", "overview"]);
    expect(out.map((g) => g.key).filter((k) => k === "accounting")).toHaveLength(1);
    expect(out).toHaveLength(defaultKeys.length);
  });

  it("never loses or invents a group", () => {
    const out = applyNavOrder(adminGroups, ["hr", "nonsense", "hr", "settings"]);
    expect([...out.map((g) => g.key)].sort()).toEqual([...defaultKeys].sort());
  });
});

describe("resolveGroupKey (dispatcher)", () => {
  it("routes chat/radio/personnel to the Security tab, not Dispatch", () => {
    expect(resolveGroupKey(dispatcherGroups, "/chat")).toBe("security");
    expect(resolveGroupKey(dispatcherGroups, "/radio")).toBe("security");
    expect(resolveGroupKey(dispatcherGroups, "/personnel")).toBe("security");
  });

  it("routes the live map to Dispatch", () => {
    expect(resolveGroupKey(dispatcherGroups, "/dispatch")).toBe("dispatch");
  });
});
