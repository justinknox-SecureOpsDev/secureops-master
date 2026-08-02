/**
 * Search matching for the officer "Shifts" list.
 *
 * Deliberately React-Native-free so it can be unit tested: importing anything
 * that pulls in `react-native` breaks vitest (it can't parse RN's
 * `import typeof` syntax). The screen owns the UI; this module owns the
 * "does this shift match what the officer typed" decision.
 */

export type SearchableShift = {
  title?: string | null;
  clientName?: string | null;
  location?: string | null;
  notes?: string | null;
  startTime?: string | null;
  endTime?: string | null;
  requiredLicenseLevel?: number | null;
};

/** Fixed English names so a search for "friday" or "march" works regardless of
 *  the device locale. The locale-formatted date is appended separately, so a
 *  Spanish handset can match either "viernes" or "friday". */
const WEEKDAYS_LONG = [
  "sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday",
];
const MONTHS_LONG = [
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
];

/**
 * Split what the officer typed into lowercase tokens. Every token has to match
 * (AND), so "night dallas" narrows rather than widens.
 */
export function tokenizeQuery(query: string | null | undefined): string[] {
  return (query ?? "").toLowerCase().trim().split(/\s+/).filter(Boolean);
}

function dateSearchText(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const parts = [
    WEEKDAYS_LONG[d.getDay()],
    WEEKDAYS_LONG[d.getDay()].slice(0, 3),
    MONTHS_LONG[d.getMonth()],
    MONTHS_LONG[d.getMonth()].slice(0, 3),
    String(d.getDate()),
    String(d.getFullYear()),
  ];
  try {
    parts.push(
      d.toLocaleDateString([], { weekday: "long", day: "numeric", month: "long" }),
      d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    );
  } catch {
    /* exotic locale data missing — the fixed English parts still work */
  }
  return parts.join(" ");
}

/**
 * Flatten everything an officer might reasonably search a shift by into one
 * lowercase string: what the job is, who it's for, where it is, when it is,
 * the clearance it needs, and any notes.
 *
 * `levelLabel` is injected rather than imported because it lives in a
 * component module (see the RN-free note at the top of this file).
 */
export function buildShiftSearchText(
  shift: SearchableShift,
  levelLabel?: (level: number | null | undefined) => string,
): string {
  const level = shift.requiredLicenseLevel;
  const fields = [
    shift.title,
    shift.clientName,
    shift.location,
    shift.notes,
    dateSearchText(shift.startTime),
    typeof level === "number" ? `level ${level}` : null,
    levelLabel && level != null ? levelLabel(level) : null,
  ];
  return fields
    .filter((f): f is string => typeof f === "string" && f.length > 0)
    .join(" ")
    .toLowerCase();
}

/** True when every token appears somewhere in the pre-built search text. */
export function matchesSearchTokens(searchText: string, tokens: string[]): boolean {
  if (tokens.length === 0) return true;
  const haystack = searchText.toLowerCase();
  return tokens.every((t) => haystack.includes(t));
}

/**
 * Convenience wrapper: filter a list in one call. The screen uses the
 * lower-level pieces so it can cache the search text per shift instead of
 * rebuilding it on every keystroke.
 */
export function filterShiftsBySearch<T extends SearchableShift>(
  shifts: T[],
  query: string | null | undefined,
  levelLabel?: (level: number | null | undefined) => string,
): T[] {
  const tokens = tokenizeQuery(query);
  if (tokens.length === 0) return shifts;
  return shifts.filter((s) => matchesSearchTokens(buildShiftSearchText(s, levelLabel), tokens));
}
