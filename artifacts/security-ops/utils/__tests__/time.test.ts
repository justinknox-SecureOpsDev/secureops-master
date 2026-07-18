import { describe, it, expect } from "vitest";
import {
  formatTime,
  formatDateTime,
  formatWeekdayTime,
  formatDate,
  dateKey,
  addDaysToKey,
} from "../time";

// 2026-07-11T00:30:00Z is 19:30 on Fri Jul 10 in America/Chicago (CDT, UTC-5).
const NEAR_MIDNIGHT_UTC = "2026-07-11T00:30:00Z";

describe("business-timezone formatting (America/Chicago default)", () => {
  it("formatTime renders in Central time regardless of device timezone", () => {
    expect(formatTime(NEAR_MIDNIGHT_UTC)).toBe("19:30");
    expect(formatTime(NEAR_MIDNIGHT_UTC, "UTC")).toBe("00:30");
  });

  it("formatDateTime / formatWeekdayTime render the Central calendar day", () => {
    expect(formatDateTime(NEAR_MIDNIGHT_UTC)).toContain("Fri");
    expect(formatDateTime(NEAR_MIDNIGHT_UTC, "UTC")).toContain("Sat");
    expect(formatWeekdayTime(NEAR_MIDNIGHT_UTC)).toContain("Fri");
  });

  it("formatDate defaults to Central time", () => {
    expect(formatDate(NEAR_MIDNIGHT_UTC)).toContain("Fri");
    expect(formatDate(NEAR_MIDNIGHT_UTC)).toContain("10");
  });

  it("dateKey buckets instants by Central calendar day across midnight", () => {
    expect(dateKey(NEAR_MIDNIGHT_UTC)).toBe("2026-07-10");
    expect(dateKey("2026-07-11T05:30:00Z")).toBe("2026-07-11"); // 00:30 CDT
    // Winter (CST, UTC-6)
    expect(dateKey("2026-01-15T01:30:00Z")).toBe("2026-01-14");
  });

  it("addDaysToKey does pure date arithmetic (DST/month/year safe)", () => {
    expect(addDaysToKey("2026-07-10", 1)).toBe("2026-07-11");
    expect(addDaysToKey("2026-07-31", 1)).toBe("2026-08-01");
    expect(addDaysToKey("2026-12-31", 1)).toBe("2027-01-01");
    // Spring-forward (Mar 8 2026) and fall-back (Nov 1 2026) boundaries
    expect(addDaysToKey("2026-03-07", 1)).toBe("2026-03-08");
    expect(addDaysToKey("2026-10-31", 1)).toBe("2026-11-01");
  });

  it("returns the input string for invalid dates", () => {
    expect(formatTime("not-a-date")).toBe("not-a-date");
    expect(dateKey("not-a-date")).toBe("not-a-date");
  });
});
