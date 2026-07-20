import { describe, it, expect } from "vitest";

import colors, {
  derivePalette,
  sanitizeBrandColors,
  contrastRatio,
  ENV_BRAND_COLORS,
} from "../colors";

describe("derivePalette", () => {
  it("returns the hand-tuned palette VERBATIM for the build-time defaults", () => {
    expect(derivePalette(ENV_BRAND_COLORS)).toEqual(colors.light);
    // Case-insensitive match still short-circuits.
    expect(
      derivePalette({
        navy: ENV_BRAND_COLORS.navy.toUpperCase(),
        gold: ENV_BRAND_COLORS.gold.toUpperCase(),
        cream: ENV_BRAND_COLORS.cream.toUpperCase(),
      }),
    ).toEqual(colors.light);
  });

  it("falls back to defaults for invalid/missing colors", () => {
    expect(sanitizeBrandColors(null)).toEqual({
      navy: ENV_BRAND_COLORS.navy.toLowerCase(),
      gold: ENV_BRAND_COLORS.gold.toLowerCase(),
      cream: ENV_BRAND_COLORS.cream.toLowerCase(),
    });
    expect(sanitizeBrandColors({ navy: "red", gold: "#12345", cream: undefined }))
      .toEqual(sanitizeBrandColors(null));
    // All-invalid input degrades to the default (hand-tuned) palette.
    expect(derivePalette({ navy: "junk", gold: "", cream: "#zzzzzz" } as any))
      .toEqual(colors.light);
  });

  it.each([
    ["dark blue tenant", { navy: "#0a1a3a", gold: "#4da3ff", cream: "#e8f0ff" }],
    ["dark green tenant", { navy: "#07130b", gold: "#37d67a", cream: "#eafff2" }],
    ["light tenant", { navy: "#f7f7f2", gold: "#8a5a00", cream: "#1d1d1d" }],
    ["mid grey tenant", { navy: "#565656", gold: "#ffd23f", cream: "#ffffff" }],
  ])("produces a legible palette for a %s", (_label, brand) => {
    const p = derivePalette(brand);
    // Core text pairs stay readable (WCAG AA for body text).
    expect(contrastRatio(p.foreground, p.background)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(p.mutedForeground, p.background)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(p.primaryForeground, p.primary)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(p.accentForeground, p.accent)).toBeGreaterThanOrEqual(4.5);
    // Brand inputs flow through directly.
    expect(p.background).toBe(brand.navy);
    expect(p.primary).toBe(brand.gold);
    expect(p.tint).toBe(brand.gold);
    // Surfaces differ from the background so cards/borders stay visible.
    expect(p.card).not.toBe(p.background);
    expect(p.border).not.toBe(p.background);
  });
});
