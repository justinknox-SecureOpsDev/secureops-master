import type { Field } from "./tables";

// WCSG operations run on Central time. All displayed dates/times use this
// zone (matches the server's PAYROLL_TIMEZONE) so the schedule reads the
// same regardless of where the viewer's browser is located.
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

export function formatDate(
  date: Date | string,
  options: Intl.DateTimeFormatOptions = { month: "short", day: "numeric", year: "numeric" },
  timeZone: string = BUSINESS_TIME_ZONE,
): string {
  const d = typeof date === "string" ? new Date(date) : date;
  if (Number.isNaN(d.getTime())) return String(date);
  return new Intl.DateTimeFormat("en-US", { ...options, timeZone }).format(d);
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

export function formatCell(value: unknown, field: Field): string {
  if (value === null || value === undefined || value === "") return "—";
  switch (field.type) {
    case "datetime": {
      const d = new Date(String(value));
      if (Number.isNaN(d.getTime())) return String(value);
      return formatDateTime(d);
    }
    case "date": {
      const d = new Date(String(value));
      if (Number.isNaN(d.getTime())) return String(value);
      // Date-only columns (e.g. "2026-07-11") parse as UTC midnight; format
      // in UTC so the literal calendar date shows regardless of viewer tz.
      return d.toLocaleDateString("en-US", { timeZone: "UTC" });
    }
    case "boolean":
      return value ? "Yes" : "No";
    case "json":
      try { return JSON.stringify(value); } catch { return String(value); }
    case "fileKey":
      return String(value);
    case "fileKeyList": {
      if (!Array.isArray(value)) return String(value);
      return `${value.length} file${value.length === 1 ? "" : "s"}`;
    }
    case "select": {
      const opt = field.options?.find((o) => o.value === String(value));
      return opt?.label ?? String(value);
    }
    case "password":
      return "••••••";
    default:
      return String(value);
  }
}

export function toFormValue(value: unknown, field: Field): string {
  if (value === null || value === undefined) return "";
  switch (field.type) {
    case "datetime": {
      const d = new Date(String(value));
      if (Number.isNaN(d.getTime())) return "";
      // input[type=datetime-local] expects "YYYY-MM-DDTHH:mm"
      const pad = (n: number) => String(n).padStart(2, "0");
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
    }
    case "date": {
      const s = String(value);
      if (s.length >= 10) return s.slice(0, 10);
      return s;
    }
    case "boolean":
      return value ? "true" : "false";
    case "json":
      try { return JSON.stringify(value, null, 2); } catch { return String(value); }
    case "fileKey":
      return String(value);
    case "fileKeyList":
      try { return JSON.stringify(value, null, 2); } catch { return String(value); }
    default:
      return String(value);
  }
}

export function fromFormValue(raw: string, field: Field): unknown {
  if (raw === "" || raw === null) {
    return field.required ? "" : null;
  }
  switch (field.type) {
    case "number":
      return raw;
    case "integer": {
      const n = parseInt(raw, 10);
      return Number.isNaN(n) ? null : n;
    }
    case "boolean":
      return raw === "true";
    case "datetime": {
      // <input type="datetime-local"> emits a wall-clock string like
      // "2026-05-16T10:00" with no timezone. Parse it as the user's local
      // time and convert to a UTC ISO string so the server stores the
      // correct instant regardless of where it's running.
      const d = new Date(raw);
      return Number.isNaN(d.getTime()) ? raw : d.toISOString();
    }
    case "date":
      return raw;
    case "json":
    case "fileKeyList":
      try { return JSON.parse(raw); } catch { return raw; }
    case "fileKey":
      return raw;
    default:
      return raw;
  }
}
