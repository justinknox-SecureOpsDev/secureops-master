/**
 * Business-timezone helpers.
 *
 * WCSG operates on US Central Time, and all server-side "what calendar day is
 * this" decisions (the dispatch status board, etc.) must use that business
 * timezone — NOT the server's local time, which in production is UTC. A
 * server-local day boundary silently dropped every evening shift (e.g. 9pm
 * Central = 02:00 UTC the next day) out of "today".
 *
 * The zone is read from PAYROLL_TIMEZONE (the same env var payroll/holiday
 * calculations use), defaulting to America/Chicago. Invalid values fall back
 * to the default.
 */

const DEFAULT_BUSINESS_TZ = "America/Chicago";
const MS_MIN = 60_000;

let resolvedBusinessTz: string | null = null;

/** Configured PAYROLL_TIMEZONE if valid, else America/Chicago. Validated once. */
export function businessTimeZone(): string {
  if (resolvedBusinessTz) return resolvedBusinessTz;
  const candidate = process.env.PAYROLL_TIMEZONE?.trim() || DEFAULT_BUSINESS_TZ;
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: candidate });
    resolvedBusinessTz = candidate;
  } catch {
    resolvedBusinessTz = DEFAULT_BUSINESS_TZ;
  }
  return resolvedBusinessTz;
}

/** Offset (ms) of `tz` from UTC at `date`: (wall-clock in tz) − (actual UTC). */
export function tzOffsetMs(date: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(date);
  const m: Record<string, number> = {};
  for (const p of parts) if (p.type !== "literal") m[p.type] = Number(p.value);
  const hour = m.hour === 24 ? 0 : m.hour; // Intl can emit "24" at midnight
  const asUtc = Date.UTC(m.year, m.month - 1, m.day, hour, m.minute, m.second);
  return asUtc - date.getTime();
}

/** UTC instant of local midnight (start of the `tz` calendar day containing `now`). */
export function startOfBusinessDay(now: Date, tz: string): Date {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const g = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const utcGuess = Date.UTC(g("year"), g("month") - 1, g("day"), 0, 0, 0);
  return new Date(utcGuess - tzOffsetMs(new Date(utcGuess), tz));
}

/**
 * `[startOfDay, endOfDay)` UTC instants bounding the `tz` calendar day that
 * contains `now`. `endOfDay` is the NEXT local midnight (not naive +24h), so
 * DST transition days (23h / 25h long) still bound exactly one local day:
 * +36h lands firmly inside the following local day regardless of day length.
 */
export function businessDayWindow(now: Date, tz: string): { startOfDay: Date; endOfDay: Date } {
  const startOfDay = startOfBusinessDay(now, tz);
  const endOfDay = startOfBusinessDay(new Date(startOfDay.getTime() + 36 * 60 * MS_MIN), tz);
  return { startOfDay, endOfDay };
}

/**
 * UTC instant of the local Monday 00:00 that starts the `tz` business week
 * containing `now`. Composed from startOfBusinessDay and a walk back to
 * Monday so DST transition weeks stay exact (never naive `- n*24h`).
 */
export function startOfBusinessWeek(now: Date, tz: string): Date {
  let day = startOfBusinessDay(now, tz);
  for (let i = 0; i < 7; i++) {
    const weekday = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" }).format(day);
    if (weekday === "Mon") return day;
    // 12h before local midnight is safely inside the previous local day.
    day = startOfBusinessDay(new Date(day.getTime() - 12 * 60 * MS_MIN), tz);
  }
  return day;
}

/** `YYYY-MM-DD` of the `tz` calendar day containing `instant`. */
export function businessDateIso(instant: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(instant);
}

/** UTC instant of local midnight on the given `YYYY-MM-DD` in `tz`. */
export function businessDateToUtc(isoDate: string, tz: string): Date {
  const [y, m, d] = isoDate.split("-").map(Number);
  const utcGuess = Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1, 0, 0, 0);
  return new Date(utcGuess - tzOffsetMs(new Date(utcGuess), tz));
}

/**
 * Pure calendar-date arithmetic on a `YYYY-MM-DD` string. No timezone
 * involvement at all — "+7 days" is always the same weekday next week,
 * even across DST transitions (never add n*24h to a UTC instant for this).
 */
export function addIsoDays(isoDate: string, n: number): string {
  const [y, m, d] = isoDate.split("-").map(Number);
  const t = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, (d ?? 1) + n));
  return t.toISOString().slice(0, 10);
}

/**
 * Canonical pay/invoice week key: `YYYY-MM-DD` of the local Monday that
 * starts the `tz` business week containing `instant`. Weeks run Monday
 * 00:00 → Sunday 23:59 in the business timezone — a Sunday-evening
 * clock-in in Chicago belongs to THAT (ending) week even though it is
 * already Monday in UTC.
 */
export function businessWeekKey(instant: Date, tz: string): string {
  return businessDateIso(startOfBusinessWeek(instant, tz), tz);
}

/**
 * `[start, end)` UTC instants bounding the business week labelled by
 * `weekKey` (a local-Monday `YYYY-MM-DD`). `end` is the NEXT local
 * Monday 00:00 computed by calendar math + local-midnight resolution,
 * so DST weeks (167h/169h long) are still bounded exactly.
 */
export function businessWeekWindowUtc(weekKey: string, tz: string): { start: Date; end: Date } {
  return {
    start: businessDateToUtc(weekKey, tz),
    end: businessDateToUtc(addIsoDays(weekKey, 7), tz),
  };
}
