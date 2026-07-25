/**
 * Unit tests for the settings-change audit metadata builders.
 *
 * These produce the human-readable old→new metadata the admin-portal Audit Log
 * renders for privileged settings changes (plan/commercial config, brand
 * overrides, feature flags). The key invariants: only changed fields appear,
 * fields absent from the payload are never reported as changes, and the brand
 * logo blob is reduced to a set/unset flag rather than persisting base64.
 */

import { describe, expect, it } from "vitest";
import {
  buildCustomerConfigChanges,
  buildBrandChanges,
  buildFeatureChanges,
} from "../lib/settingsAudit";

describe("buildCustomerConfigChanges", () => {
  it("reports only fields that actually changed", () => {
    const before = { customerName: "Acme", monthlyPriceCents: 1000, planTier: "starter" };
    const after = { customerName: "Acme", monthlyPriceCents: 2000, planTier: "starter" };
    const meta = buildCustomerConfigChanges(before, after);
    expect(meta?.settingsChange).toBe("customer_config");
    expect(meta?.changes).toEqual([
      { field: "monthlyPriceCents", label: "Monthly price", kind: "money_cents", old: 1000, new: 2000 },
    ]);
  });

  it("returns null when nothing changed", () => {
    const same = { customerName: "Acme", planTier: "starter" };
    expect(buildCustomerConfigChanges(same, same)).toBeNull();
  });

  it("does not report fields absent from the payload", () => {
    const before = { customerName: "Acme", processingFeeRate: "3.5" };
    const after = { customerName: "NewCo" }; // processingFeeRate omitted → unchanged
    const meta = buildCustomerConfigChanges(before, after);
    expect(meta?.changes.map((c) => c.field)).toEqual(["customerName"]);
  });

  it("treats undefined/null before as unset→set", () => {
    const meta = buildCustomerConfigChanges({}, { processingFeeEnabled: true });
    expect(meta?.changes).toEqual([
      { field: "processingFeeEnabled", label: "Processing fee", kind: "bool", old: null, new: true },
    ]);
  });
});

describe("buildBrandChanges", () => {
  it("records the logo as set/unset, never the base64 blob", () => {
    const before = { logoDataUrl: null };
    const after = { logoDataUrl: "data:image/png;base64,AAAAAAAAAAAAAAAA" };
    const meta = buildBrandChanges(before, after);
    expect(meta?.settingsChange).toBe("brand");
    expect(meta?.changes).toEqual([
      { field: "logoDataUrl", label: "Logo", kind: "image", old: false, new: true },
    ]);
  });

  it("reports colour changes with the color kind", () => {
    const meta = buildBrandChanges({ colorGold: "#c9a04a" }, { colorGold: "#ffffff" });
    expect(meta?.changes).toEqual([
      { field: "colorGold", label: "Accent colour", kind: "color", old: "#c9a04a", new: "#ffffff" },
    ]);
  });
});

describe("buildFeatureChanges", () => {
  it("reports only toggled flags", () => {
    const meta = buildFeatureChanges([
      { key: "radio", old: false, new: true },
      { key: "chat", old: true, new: true },
    ]);
    expect(meta?.settingsChange).toBe("features");
    expect(meta?.changes).toEqual([
      { field: "radio", label: "radio", kind: "feature", old: false, new: true },
    ]);
  });

  it("returns null when no flag changed", () => {
    expect(buildFeatureChanges([{ key: "radio", old: true, new: true }])).toBeNull();
  });
});
