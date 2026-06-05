import { describe, expect, it } from "vitest";
import { businessDayWindow, startOfBusinessDay, tzOffsetMs } from "../lib/businessTime";

const CHICAGO = "America/Chicago";

describe("startOfBusinessDay (America/Chicago)", () => {
  it("resolves local midnight for an evening-Central instant that is already next-day UTC", () => {
    // 2026-06-05 21:00 Central (CDT, UTC-5) = 2026-06-06 02:00Z.
    // The business day must still be 2026-06-05, i.e. local midnight
    // 2026-06-05 00:00 CDT = 2026-06-05 05:00Z — NOT the UTC day's midnight.
    const eveningCentral = new Date("2026-06-06T02:00:00Z");
    const start = startOfBusinessDay(eveningCentral, CHICAGO);
    expect(start.toISOString()).toBe("2026-06-05T05:00:00.000Z");
  });

  it("uses standard-time offset (UTC-6) in winter", () => {
    // 2026-01-15 20:00 CST = 2026-01-16 02:00Z. Local midnight 2026-01-15
    // 00:00 CST = 2026-01-15 06:00Z.
    const winterEvening = new Date("2026-01-16T02:00:00Z");
    const start = startOfBusinessDay(winterEvening, CHICAGO);
    expect(start.toISOString()).toBe("2026-01-15T06:00:00.000Z");
  });
});

describe("businessDayWindow DST handling (America/Chicago)", () => {
  it("spring-forward day is 23h long", () => {
    // 2026-03-08: clocks jump 02:00 -> 03:00 CST->CDT. Local day = 23h.
    const during = new Date("2026-03-08T12:00:00Z");
    const { startOfDay, endOfDay } = businessDayWindow(during, CHICAGO);
    expect(startOfDay.toISOString()).toBe("2026-03-08T06:00:00.000Z"); // 00:00 CST
    expect(endOfDay.toISOString()).toBe("2026-03-09T05:00:00.000Z"); // 00:00 CDT
    const hours = (endOfDay.getTime() - startOfDay.getTime()) / 3_600_000;
    expect(hours).toBe(23);
  });

  it("fall-back day is 25h long", () => {
    // 2026-11-01: clocks fall 02:00 -> 01:00 CDT->CST. Local day = 25h.
    const during = new Date("2026-11-01T12:00:00Z");
    const { startOfDay, endOfDay } = businessDayWindow(during, CHICAGO);
    expect(startOfDay.toISOString()).toBe("2026-11-01T05:00:00.000Z"); // 00:00 CDT
    expect(endOfDay.toISOString()).toBe("2026-11-02T06:00:00.000Z"); // 00:00 CST
    const hours = (endOfDay.getTime() - startOfDay.getTime()) / 3_600_000;
    expect(hours).toBe(25);
  });

  it("normal day is exactly 24h", () => {
    const during = new Date("2026-06-15T18:00:00Z");
    const { startOfDay, endOfDay } = businessDayWindow(during, CHICAGO);
    const hours = (endOfDay.getTime() - startOfDay.getTime()) / 3_600_000;
    expect(hours).toBe(24);
  });
});

describe("tzOffsetMs", () => {
  it("is -5h in CDT (summer) and -6h in CST (winter)", () => {
    expect(tzOffsetMs(new Date("2026-07-01T12:00:00Z"), CHICAGO)).toBe(-5 * 3_600_000);
    expect(tzOffsetMs(new Date("2026-01-01T12:00:00Z"), CHICAGO)).toBe(-6 * 3_600_000);
  });
});
