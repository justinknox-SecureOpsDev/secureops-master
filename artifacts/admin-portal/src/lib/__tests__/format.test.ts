import { describe, it, expect } from "vitest";
import { formatTime, formatDateTime, formatDate, dateKey } from "../format";

// 2026-07-11T00:30:00Z is 19:30 on Fri Jul 10 in America/Chicago (CDT, UTC-5).
const NEAR_MIDNIGHT_UTC = "2026-07-11T00:30:00Z";

describe("business-timezone formatting (America/Chicago default)", () => {
  it("formatTime renders in Central time regardless of host timezone", () => {
    expect(formatTime(NEAR_MIDNIGHT_UTC)).toBe("19:30");
    expect(formatTime(NEAR_MIDNIGHT_UTC, "UTC")).toBe("00:30");
  });

  it("formatDateTime renders the Central calendar day", () => {
    expect(formatDateTime(NEAR_MIDNIGHT_UTC)).toContain("Fri");
    expect(formatDateTime(NEAR_MIDNIGHT_UTC)).toContain("10");
    expect(formatDateTime(NEAR_MIDNIGHT_UTC, "UTC")).toContain("Sat");
  });

  it("formatDate defaults to Central time", () => {
    expect(formatDate(NEAR_MIDNIGHT_UTC)).toBe("Jul 10, 2026");
    expect(formatDate(NEAR_MIDNIGHT_UTC, { month: "short", day: "numeric", year: "numeric" }, "UTC")).toBe(
      "Jul 11, 2026",
    );
  });

  it("dateKey buckets instants by Central calendar day across midnight", () => {
    expect(dateKey(NEAR_MIDNIGHT_UTC)).toBe("2026-07-10");
    expect(dateKey("2026-07-11T05:30:00Z")).toBe("2026-07-11"); // 00:30 CDT
    // A shift 22:00 → 02:00 Central spans two Central days
    const start = "2026-07-11T03:00:00Z"; // 22:00 Jul 10 CDT
    const end = "2026-07-11T07:00:00Z"; // 02:00 Jul 11 CDT
    expect(dateKey(start)).not.toBe(dateKey(end));
  });

  it("handles CST (winter, UTC-6) too", () => {
    expect(formatTime("2026-01-15T01:30:00Z")).toBe("19:30");
    expect(dateKey("2026-01-15T01:30:00Z")).toBe("2026-01-14");
  });

  it("returns the input string for invalid dates", () => {
    expect(formatTime("not-a-date")).toBe("not-a-date");
    expect(dateKey("not-a-date")).toBe("not-a-date");
  });
});
