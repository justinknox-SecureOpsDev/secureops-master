import { describe, expect, it } from "vitest";
import {
  addIsoDays,
  businessDayWindow,
  businessWeekKey,
  businessWeekWindowUtc,
  startOfBusinessDay,
  tzOffsetMs,
} from "../lib/businessTime";

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

describe("businessWeekKey (America/Chicago)", () => {
  it("keeps a Sunday-evening Central clock-in in the ENDING week even though it is already Monday UTC", () => {
    // 2026-07-19 is a Sunday. 21:30 CDT = 2026-07-20 02:30Z (Monday UTC).
    // Business-week rule: it belongs to the week starting Mon 2026-07-13.
    // (The old UTC rule keyed this to 2026-07-20 — the core bug.)
    const sundayEvening = new Date("2026-07-20T02:30:00Z");
    expect(businessWeekKey(sundayEvening, CHICAGO)).toBe("2026-07-13");
  });

  it("keys a Monday-morning Central clock-in to that same Monday", () => {
    // 2026-07-20 00:30 CDT = 2026-07-20 05:30Z.
    const mondayMorning = new Date("2026-07-20T05:30:00Z");
    expect(businessWeekKey(mondayMorning, CHICAGO)).toBe("2026-07-20");
  });

  it("keys a winter (CST) Sunday-evening instant to the ending week", () => {
    // 2026-01-18 is a Sunday. 20:00 CST = 2026-01-19 02:00Z (Monday UTC).
    const winterSundayEvening = new Date("2026-01-19T02:00:00Z");
    expect(businessWeekKey(winterSundayEvening, CHICAGO)).toBe("2026-01-12");
  });
});

describe("businessWeekWindowUtc (America/Chicago)", () => {
  it("bounds a normal week at local Monday midnights (168h)", () => {
    const { start, end } = businessWeekWindowUtc("2026-07-13", CHICAGO);
    expect(start.toISOString()).toBe("2026-07-13T05:00:00.000Z"); // Mon 00:00 CDT
    expect(end.toISOString()).toBe("2026-07-20T05:00:00.000Z");   // next Mon 00:00 CDT
    expect((end.getTime() - start.getTime()) / 3_600_000).toBe(168);
  });

  it("spring-forward week is 167h and still ends at local Monday midnight", () => {
    // Week of Mon 2026-03-02 contains the 2026-03-08 spring-forward.
    const { start, end } = businessWeekWindowUtc("2026-03-02", CHICAGO);
    expect(start.toISOString()).toBe("2026-03-02T06:00:00.000Z"); // Mon 00:00 CST
    expect(end.toISOString()).toBe("2026-03-09T05:00:00.000Z");   // Mon 00:00 CDT
    expect((end.getTime() - start.getTime()) / 3_600_000).toBe(167);
  });

  it("fall-back week is 169h and still ends at local Monday midnight", () => {
    // Week of Mon 2026-10-26 contains the 2026-11-01 fall-back.
    const { start, end } = businessWeekWindowUtc("2026-10-26", CHICAGO);
    expect(start.toISOString()).toBe("2026-10-26T05:00:00.000Z"); // Mon 00:00 CDT
    expect(end.toISOString()).toBe("2026-11-02T06:00:00.000Z");   // Mon 00:00 CST
    expect((end.getTime() - start.getTime()) / 3_600_000).toBe(169);
  });

  it("a Sunday-evening instant falls inside its business week's window", () => {
    const sundayEvening = new Date("2026-07-20T02:30:00Z"); // Sun 21:30 CDT
    const key = businessWeekKey(sundayEvening, CHICAGO);
    const { start, end } = businessWeekWindowUtc(key, CHICAGO);
    expect(sundayEvening.getTime()).toBeGreaterThanOrEqual(start.getTime());
    expect(sundayEvening.getTime()).toBeLessThan(end.getTime());
  });
});

describe("addIsoDays", () => {
  it("does pure calendar math across month and year boundaries", () => {
    expect(addIsoDays("2026-07-13", 6)).toBe("2026-07-19");
    expect(addIsoDays("2026-07-13", 7)).toBe("2026-07-20");
    expect(addIsoDays("2026-12-29", 7)).toBe("2027-01-05");
    expect(addIsoDays("2026-03-02", -7)).toBe("2026-02-23");
  });
});

describe("tzOffsetMs", () => {
  it("is -5h in CDT (summer) and -6h in CST (winter)", () => {
    expect(tzOffsetMs(new Date("2026-07-01T12:00:00Z"), CHICAGO)).toBe(-5 * 3_600_000);
    expect(tzOffsetMs(new Date("2026-01-01T12:00:00Z"), CHICAGO)).toBe(-6 * 3_600_000);
  });
});
