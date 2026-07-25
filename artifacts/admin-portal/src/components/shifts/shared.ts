// Shared types + helpers for the unified Shifts area (calendar + list views).

export type ShiftAssignment = {
  id: string;
  status: string;
  employeeName: string | null;
};

export type Shift = {
  id: string;
  title: string;
  siteId: string | null;
  clientName: string | null;
  location: string | null;
  startTime: string;
  endTime: string;
  payRate: string;
  billRate: string;
  status: "upcoming" | "active" | "completed" | "cancelled" | string;
  requiredLicenseLevel: number;
  headcount: number;
  isRepeat: boolean;
  repeatPattern: string | null;
  seriesId: string | null;
  notes: string | null;
  shiftType?: "standard" | "ppo_detail" | string | null;
  siteRateId?: string | null;
  assignments: ShiftAssignment[];
};

export type SiteRow = {
  id: string;
  name: string;
  address: string | null;
  clientName: string | null;
};

export type PendingClaim = {
  shiftId: string;
  assignmentId: string;
  employeeName: string | null;
  shiftTitle: string;
  clientName: string | null;
  location: string | null;
  startTime: string;
  endTime: string;
  requiredLicenseLevel: number;
};

export const NO_SITE_KEY = "__no_site__";
export const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;
export const LOAD_MORE_PAGE = 50;

// WCSG operates in Texas. All calendar day bucketing and the timezone-repair
// tooling are pinned to America/Chicago so behavior is identical regardless of
// where the admin's browser is.
export const COMPANY_TZ = "America/Chicago";

export function filledCount(s: Shift): number {
  return (s.assignments ?? []).filter((a) => a.status === "accepted").length;
}

export function seriesKeyFor(s: Shift): string {
  return s.seriesId
    ? `sid::${s.seriesId}`
    : `legacy::${s.siteId ?? NO_SITE_KEY}::${s.title}::${s.repeatPattern ?? ""}`;
}

export function fmtDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    weekday: "short", month: "short", day: "numeric",
    hour: "numeric", minute: "2-digit",
  });
}

export function fmtTimeOfDay(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

export function fmtTimeTz(iso: string): string {
  return new Date(iso).toLocaleString("en-US", {
    timeZone: COMPANY_TZ, hour: "numeric", minute: "2-digit",
  });
}

export function fmtDateLongTz(iso: string): string {
  return new Date(iso).toLocaleString("en-US", {
    timeZone: COMPANY_TZ, weekday: "long", month: "long", day: "numeric", year: "numeric",
  });
}

/** Company-timezone day key (YYYY-MM-DD) for an ISO instant. */
export function tzDayKey(iso: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: COMPANY_TZ, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date(iso));
  const y = parts.find((p) => p.type === "year")?.value ?? "";
  const m = parts.find((p) => p.type === "month")?.value ?? "";
  const d = parts.find((p) => p.type === "day")?.value ?? "";
  return `${y}-${m}-${d}`;
}

/** Browser-local day key for a Date cell in the calendar grid. */
export function localDayKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// "HH:MM" in the supplied IANA zone (24h) for an ISO instant.
function localHHMM(iso: string, tz: string): string | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  try {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false,
    }).formatToParts(d);
    const h = parts.find((p) => p.type === "hour")?.value ?? "";
    const m = parts.find((p) => p.type === "minute")?.value ?? "";
    if (!h || !m) return null;
    return `${h === "24" ? "00" : h}:${m}`;
  } catch { return null; }
}

// A series is "affected" by the old UTC-instead-of-local bug when its first
// occurrence's Central HH:MM doesn't match the intended HH:MM stored in the
// repeatPattern. Returns the (intended, actual) pair so the UI can explain
// the fix to the admin before they click.
export function detectSeriesTimezoneIssue(
  s: Shift | undefined,
): { intended: string; actual: string } | null {
  if (!s || !s.repeatPattern) return null;
  let pattern: { startTime?: unknown } | null = null;
  try { pattern = JSON.parse(s.repeatPattern); } catch { return null; }
  const intended = pattern?.startTime;
  if (typeof intended !== "string" || !/^\d{2}:\d{2}$/.test(intended)) return null;
  const actual = localHHMM(s.startTime, COMPANY_TZ);
  if (!actual) return null;
  if (actual === intended) return null;
  return { intended, actual };
}

/** Human summary of a repeatPattern JSON blob ("Mon, Wed, Fri · 09:00–17:00"). */
export function describeRepeatPattern(repeatPattern: string | null): string | null {
  if (!repeatPattern) return null;
  try {
    const p = JSON.parse(repeatPattern) as {
      daysOfWeek?: number[]; startTime?: string; endTime?: string; frequency?: string;
    };
    const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const parts: string[] = [];
    if (Array.isArray(p.daysOfWeek) && p.daysOfWeek.length > 0) {
      parts.push(p.daysOfWeek.map((d) => dayNames[d] ?? String(d)).join(", "));
    } else if (p.frequency) {
      parts.push(p.frequency);
    }
    if (p.startTime && p.endTime) parts.push(`${p.startTime}–${p.endTime}`);
    else if (p.startTime) parts.push(p.startTime);
    return parts.length > 0 ? parts.join(" · ") : null;
  } catch { return null; }
}

export function levelBadge(level: number): { label: string; cls: string } {
  if (level >= 4) return { label: "L4 / PPO", cls: "bg-purple-100 text-purple-800 border-purple-300" };
  if (level === 3) return { label: "L3 Armed", cls: "bg-amber-100 text-amber-800 border-amber-300" };
  if (level <= 1) return { label: "Support", cls: "bg-slate-100 text-slate-600 border-slate-300" };
  return { label: "L2", cls: "bg-slate-100 text-slate-700 border-slate-300" };
}

export function statusBadge(status: string): string {
  switch (status) {
    case "active": return "bg-green-100 text-green-800 border-green-300";
    case "completed": return "bg-slate-100 text-slate-600 border-slate-300";
    case "cancelled": return "bg-red-100 text-red-700 border-red-300";
    default: return "bg-blue-100 text-blue-800 border-blue-300";
  }
}

export type StaffingFilter = "all" | "open" | "filled";
export type StatusFilter = "all" | "upcoming" | "active" | "completed" | "cancelled";
export const STATUS_OPTIONS: StatusFilter[] = ["all", "upcoming", "active", "completed", "cancelled"];

export type ShiftFilters = {
  search: string;
  siteId: string; // "" = all
  client: string; // "" = all (matches resolved client label)
  status: StatusFilter;
  staffing: StaffingFilter;
};

export const EMPTY_FILTERS: ShiftFilters = {
  search: "", siteId: "", client: "", status: "upcoming", staffing: "all",
};

/**
 * Client-side filter pass shared by both views. `siteIndex` resolves live
 * site/client names so renames flow through (denormalized shift snapshots
 * can be stale).
 */
export function applyFilters(
  rows: Shift[],
  f: ShiftFilters,
  siteIndex: Map<string, { name: string; clientName: string | null }>,
): Shift[] {
  const q = f.search.trim().toLowerCase();
  return rows.filter((s) => {
    if (f.siteId && s.siteId !== f.siteId) return false;
    if (f.status !== "all" && s.status !== f.status) return false;
    if (f.staffing !== "all") {
      const open = filledCount(s) < s.headcount;
      if (f.staffing === "open" && !open) return false;
      if (f.staffing === "filled" && open) return false;
    }
    const live = s.siteId ? siteIndex.get(s.siteId) : undefined;
    const clientLabel = live?.clientName ?? s.clientName ?? "";
    if (f.client && clientLabel !== f.client) return false;
    if (q) {
      const siteLabel = live?.name ?? s.location ?? "";
      const hay = [
        s.title, siteLabel, clientLabel, s.location ?? "",
        ...(s.assignments ?? []).map((a) => a.employeeName ?? ""),
      ].join(" ").toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

export function siteLabelFor(
  s: Shift,
  siteIndex: Map<string, { name: string; clientName: string | null }>,
): { site: string; client: string | null } {
  const live = s.siteId ? siteIndex.get(s.siteId) : undefined;
  return {
    site: live?.name ?? s.location ?? (s.siteId ? "Unnamed site" : "No site"),
    client: live?.clientName ?? s.clientName ?? null,
  };
}
