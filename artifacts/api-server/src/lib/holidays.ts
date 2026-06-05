/**
 * US federal holiday calendar + holiday-pay policy (June 2026).
 *
 * WCSG pays a premium on the 11 US federal holidays for both officer
 * payroll and client billing. This module is the single source of truth
 * for "is this instant a federal holiday?" and "what's the multiplier?".
 *
 * Design decisions (documented because they are policy, not code-derivable):
 *
 *  - **Actual dates, not observed dates.** Federal *bank* closures shift to
 *    Friday/Monday when a fixed-date holiday lands on a weekend (e.g. July 4
 *    on a Saturday → observed Friday July 3). WCSG is a 24/7 operation:
 *    officers who actually work the *real* holiday should get the premium,
 *    so we match the actual calendar date and never the observed substitute.
 *
 *  - **Qualifying date = the entry's clock-in date in PAYROLL_TIMEZONE.**
 *    A time entry's whole hours are treated as holiday hours iff its
 *    clock-in instant falls on a federal holiday in the company's local
 *    timezone (default America/Chicago — WCSG is TX-based). We do NOT split
 *    a shift's hours across midnight; the clock-in date governs, mirroring
 *    how payroll weeks are already bucketed by clock-in. Timezone matters:
 *    a night shift starting 8pm CT on the holiday is still the holiday even
 *    though it is already the next day in UTC.
 *
 *  - **Multiplier is a fixed 1.5× (time and a half).**
 */

/** Company-local timezone used to resolve an instant to a calendar date. */
const DEFAULT_TIMEZONE = "America/Chicago";

/** Holiday pay rate: time and a half on the normal (officer/bill) rate. */
export const HOLIDAY_PAY_MULTIPLIER = 1.5;

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function dateKey(year: number, month1: number, day: number): string {
  return `${year}-${pad2(month1)}-${pad2(day)}`;
}

/**
 * The nth (1-based) occurrence of `weekday` (0=Sun … 6=Sat) in a month.
 * Uses a UTC-constructed Date purely as a calendar calculator — no timezone
 * conversion happens, we only read back UTC components.
 */
function nthWeekday(year: number, month1: number, weekday: number, n: number): string {
  const firstDow = new Date(Date.UTC(year, month1 - 1, 1)).getUTCDay();
  const day = 1 + ((weekday - firstDow + 7) % 7) + (n - 1) * 7;
  return dateKey(year, month1, day);
}

/** The last occurrence of `weekday` (0=Sun … 6=Sat) in a month. */
function lastWeekday(year: number, month1: number, weekday: number): string {
  const lastDate = new Date(Date.UTC(year, month1, 0)); // day 0 of next month = last day
  const lastDom = lastDate.getUTCDate();
  const lastDow = lastDate.getUTCDay();
  const day = lastDom - ((lastDow - weekday + 7) % 7);
  return dateKey(year, month1, day);
}

const yearCache = new Map<number, Map<string, string>>();

/**
 * The 11 US federal holidays for a given year, keyed by `YYYY-MM-DD`
 * (actual date) → display name. Memoized per year.
 */
export function federalHolidaysForYear(year: number): Map<string, string> {
  const cached = yearCache.get(year);
  if (cached) return cached;
  const m = new Map<string, string>([
    [dateKey(year, 1, 1), "New Year's Day"],
    [nthWeekday(year, 1, 1, 3), "Martin Luther King Jr. Day"], // 3rd Mon Jan
    [nthWeekday(year, 2, 1, 3), "Presidents' Day"], // 3rd Mon Feb
    [lastWeekday(year, 5, 1), "Memorial Day"], // last Mon May
    [dateKey(year, 6, 19), "Juneteenth National Independence Day"],
    [dateKey(year, 7, 4), "Independence Day"],
    [nthWeekday(year, 9, 1, 1), "Labor Day"], // 1st Mon Sep
    [nthWeekday(year, 10, 1, 2), "Columbus Day"], // 2nd Mon Oct
    [dateKey(year, 11, 11), "Veterans Day"],
    [nthWeekday(year, 11, 4, 4), "Thanksgiving Day"], // 4th Thu Nov
    [dateKey(year, 12, 25), "Christmas Day"],
  ]);
  yearCache.set(year, m);
  return m;
}

let resolvedTimeZone: string | null = null;

/** Configured PAYROLL_TIMEZONE if valid, else the default. Validated once. */
function holidayTimeZone(): string {
  if (resolvedTimeZone) return resolvedTimeZone;
  const candidate = process.env.PAYROLL_TIMEZONE?.trim() || DEFAULT_TIMEZONE;
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: candidate });
    resolvedTimeZone = candidate;
  } catch {
    resolvedTimeZone = DEFAULT_TIMEZONE;
  }
  return resolvedTimeZone;
}

/** The calendar date (`YYYY-MM-DD`) of `instant` in the given timezone. */
function localDateKey(instant: Date, tz: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(instant);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/**
 * Returns the federal-holiday display name if `instant` falls on a US
 * federal holiday (in PAYROLL_TIMEZONE), else null. Accepts a Date, an
 * ISO string, or null/undefined (returns null for the latter two when
 * unparseable).
 */
export function getFederalHolidayName(instant: Date | string | null | undefined): string | null {
  if (!instant) return null;
  const d = instant instanceof Date ? instant : new Date(instant);
  if (Number.isNaN(d.getTime())) return null;
  const key = localDateKey(d, holidayTimeZone());
  const year = Number(key.slice(0, 4));
  if (!Number.isFinite(year)) return null;
  return federalHolidaysForYear(year).get(key) ?? null;
}

/** True iff `instant` falls on a US federal holiday. */
export function isFederalHoliday(instant: Date | string | null | undefined): boolean {
  return getFederalHolidayName(instant) !== null;
}
