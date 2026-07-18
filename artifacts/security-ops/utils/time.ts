// WCSG operations run on Central time. All displayed dates/times use this
// zone (matches the server's PAYROLL_TIMEZONE) so the schedule reads the
// same regardless of the device's timezone.
export const BUSINESS_TIME_ZONE = "America/Chicago";

export function formatTime(date: Date | string, timeZone: string = BUSINESS_TIME_ZONE): string {
  const d = typeof date === "string" ? new Date(date) : date;
  if (Number.isNaN(d.getTime())) return String(date);
  return new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone,
  }).format(d);
}

export function formatDateTime(date: Date | string, timeZone: string = BUSINESS_TIME_ZONE): string {
  const d = typeof date === "string" ? new Date(date) : date;
  if (Number.isNaN(d.getTime())) return String(date);
  return new Intl.DateTimeFormat("en-GB", {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone,
  }).format(d);
}

export function formatWeekdayTime(date: Date | string, timeZone: string = BUSINESS_TIME_ZONE): string {
  const d = typeof date === "string" ? new Date(date) : date;
  if (Number.isNaN(d.getTime())) return String(date);
  return new Intl.DateTimeFormat("en-GB", {
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone,
  }).format(d);
}

/** Calendar day ("YYYY-MM-DD") of an instant in the business timezone. */
export function dateKey(date: Date | string, timeZone: string = BUSINESS_TIME_ZONE): string {
  const d = typeof date === "string" ? new Date(date) : date;
  if (Number.isNaN(d.getTime())) return String(date);
  return new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone,
  }).format(d);
}

/** Add n calendar days to a "YYYY-MM-DD" key (DST-safe — pure date arithmetic). */
export function addDaysToKey(key: string, n: number): string {
  const [y, m, d] = key.split("-").map(Number);
  if (!y || !m || d === undefined) return key;
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

export function formatDate(
  date: Date | string,
  options: Intl.DateTimeFormatOptions = { weekday: "short", day: "numeric", month: "short" },
  timeZone: string = BUSINESS_TIME_ZONE,
): string {
  const d = typeof date === "string" ? new Date(date) : date;
  if (Number.isNaN(d.getTime())) return String(date);
  return new Intl.DateTimeFormat("en-GB", { ...options, timeZone }).format(d);
}
