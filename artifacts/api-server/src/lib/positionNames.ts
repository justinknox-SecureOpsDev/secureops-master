// Named position helpers.
//
// A site's rate card is a list of NAMED POSITIONS (site_rates rows). The name
// is the primary label wherever a rate is shown or picked. Rows created before
// naming existed carry a null name and fall back to their internal slot number
// ("Rate 1"), so nothing renders blank.
//
// Shifts snapshot the name they were created with (shifts.position_name) but
// reads prefer the LIVE rate-card name, so renaming a position updates every
// shift still linked to it. A shift whose rate row was deleted keeps its
// snapshot.
//
// Eligibility is NEVER derived from a name — who may claim or be assigned to a
// shift still comes from the numeric requiredLicenseLevel.
import { eq, inArray } from "drizzle-orm";
import { db, siteRatesTable } from "@workspace/db";

export type RateNameSource = { name?: string | null; rateTier?: number | null };

/** Admin-facing label for a rate-card row: its name, else "Rate <slot>". */
export function rateDisplayName(rate: RateNameSource): string {
  const n = typeof rate.name === "string" ? rate.name.trim() : "";
  return n || `Rate ${rate.rateTier ?? 1}`;
}

/** Human label for a license level, used in duplicate-position messages. */
export const LEVEL_NAMES: Record<number, string> = {
  1: "Support",
  2: "L2 Unarmed",
  3: "L3 Armed",
  4: "L4/PPO",
};

export function levelName(level: number): string {
  return LEVEL_NAMES[level] ?? `L${level}`;
}

/** id → display name for the supplied rate-card ids (skips unknown ids). */
export async function loadRateNames(rateIds: Array<string | null | undefined>): Promise<Map<string, string>> {
  const ids = Array.from(new Set(rateIds.filter((id): id is string => !!id)));
  const map = new Map<string, string>();
  if (ids.length === 0) return map;
  const rows = await db
    .select({ id: siteRatesTable.id, name: siteRatesTable.name, rateTier: siteRatesTable.rateTier })
    .from(siteRatesTable)
    .where(inArray(siteRatesTable.id, ids));
  for (const r of rows) map.set(r.id, rateDisplayName(r));
  return map;
}

/** Named positions configured for a site, keyed by rate id. */
export async function loadSitePositionNames(siteId: string): Promise<Map<string, string>> {
  const rows = await db
    .select({ id: siteRatesTable.id, name: siteRatesTable.name, rateTier: siteRatesTable.rateTier })
    .from(siteRatesTable)
    .where(eq(siteRatesTable.siteId, siteId));
  return new Map(rows.map((r) => [r.id, rateDisplayName(r)]));
}

type ShiftLike = { siteRateId?: string | null; positionName?: string | null };

/**
 * Resolve the position name shown for a shift: the live rate-card name when
 * the rate still exists, otherwise the name captured at creation.
 */
export function resolvePositionName(
  shift: ShiftLike,
  liveNames: Map<string, string>,
): string | null {
  const live = shift.siteRateId ? liveNames.get(shift.siteRateId) : undefined;
  const snapshot = typeof shift.positionName === "string" ? shift.positionName.trim() : "";
  return live ?? (snapshot || null);
}

/** Attach a resolved `positionName` to every shift row in one extra query. */
export async function withPositionNames<T extends ShiftLike>(shifts: T[]): Promise<Array<T & { positionName: string | null }>> {
  const liveNames = await loadRateNames(shifts.map((s) => s.siteRateId));
  return shifts.map((s) => ({ ...s, positionName: resolvePositionName(s, liveNames) }));
}
