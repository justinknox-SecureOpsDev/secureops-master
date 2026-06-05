import { describe, expect, it } from "vitest";
import {
  getFederalHolidayName,
  isFederalHoliday,
  federalHolidaysForYear,
  HOLIDAY_PAY_MULTIPLIER,
} from "../lib/holidays";

describe("US federal holiday calendar", () => {
  it("uses a fixed time-and-a-half multiplier", () => {
    expect(HOLIDAY_PAY_MULTIPLIER).toBe(1.5);
  });

  it("computes all 11 federal holidays for a year", () => {
    const map = federalHolidaysForYear(2026);
    expect(map.size).toBe(11);
    const expected: Record<string, string> = {
      "2026-01-01": "New Year's Day",
      "2026-01-19": "Martin Luther King Jr. Day",
      "2026-02-16": "Presidents' Day",
      "2026-05-25": "Memorial Day",
      "2026-06-19": "Juneteenth National Independence Day",
      "2026-07-04": "Independence Day",
      "2026-09-07": "Labor Day",
      "2026-10-12": "Columbus Day",
      "2026-11-11": "Veterans Day",
      "2026-11-26": "Thanksgiving Day",
      "2026-12-25": "Christmas Day",
    };
    for (const [date, name] of Object.entries(expected)) {
      expect(map.get(date)).toBe(name);
    }
  });

  it("recomputes floating holidays correctly for a different year", () => {
    // 2025: MLK = Jan 20 (3rd Mon), Thanksgiving = Nov 27 (4th Thu).
    const map = federalHolidaysForYear(2025);
    expect(map.get("2025-01-20")).toBe("Martin Luther King Jr. Day");
    expect(map.get("2025-11-27")).toBe("Thanksgiving Day");
    expect(map.get("2025-05-26")).toBe("Memorial Day"); // last Mon May 2025
  });

  it("identifies a holiday clock-in by name", () => {
    // Noon CDT on Independence Day.
    expect(getFederalHolidayName(new Date("2026-07-04T17:00:00Z"))).toBe("Independence Day");
    expect(isFederalHoliday(new Date("2026-07-04T17:00:00Z"))).toBe(true);
  });

  it("returns null for an ordinary day", () => {
    expect(getFederalHolidayName(new Date("2026-07-05T17:00:00Z"))).toBeNull();
    expect(isFederalHoliday(new Date("2026-07-06T17:00:00Z"))).toBe(false);
  });

  it("resolves the holiday by the company-local (Central) date, not UTC", () => {
    // 9pm CDT on July 4 is already July 5 in UTC — still the holiday locally.
    expect(getFederalHolidayName(new Date("2026-07-05T02:00:00Z"))).toBe("Independence Day");
    // 1am CDT on July 5 is past the holiday locally.
    expect(getFederalHolidayName(new Date("2026-07-05T06:00:00Z"))).toBeNull();
  });

  it("accepts ISO strings and tolerates null/invalid input", () => {
    expect(getFederalHolidayName("2026-12-25T18:00:00Z")).toBe("Christmas Day");
    expect(getFederalHolidayName(null)).toBeNull();
    expect(getFederalHolidayName(undefined)).toBeNull();
    expect(getFederalHolidayName("not-a-date")).toBeNull();
  });
});
