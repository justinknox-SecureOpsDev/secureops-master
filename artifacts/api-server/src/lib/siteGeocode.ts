import { db, sitesTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { geocodeOnelineAddress } from "./geocode";
import type { Logger } from "pino";

type SiteRow = {
  id: string;
  address: string | null;
  locationLat: string | null;
  locationLng: string | null;
  lastGeocodedAddress: string | null;
};

function norm(s: string | null | undefined): string {
  return (s ?? "").trim();
}

/**
 * Adjust an incoming update body so that an address change invalidates the
 * stored coordinates (forcing a re-geocode) unless the caller is also
 * explicitly supplying new lat/lng. When the caller supplies coords
 * alongside an address, we snapshot the new address as the
 * `lastGeocodedAddress` so the bulk backfill won't flag the row as drifted.
 *
 * The returned object is the body to actually persist.
 */
export function preparePreUpdateBody(
  current: SiteRow,
  body: Record<string, unknown>,
): Record<string, unknown> {
  const out = { ...body };
  if (out.address === undefined) return out;

  const newAddress = norm(out.address as string | null);
  const oldAddress = norm(current.address);
  // Trigger off the actual current value, not the snapshot — legacy rows
  // pre-dating `lastGeocodedAddress` have a null snapshot but otherwise
  // correct coords, and we shouldn't wipe those on an unrelated edit.
  const addressChanged = newAddress !== oldAddress;
  if (!addressChanged) return out;

  const callerSetCoords = out.locationLat !== undefined || out.locationLng !== undefined;
  if (callerSetCoords) {
    // Admin is asserting that the supplied coords match the new address.
    out.lastGeocodedAddress = newAddress.length > 0 ? newAddress : null;
    return out;
  }

  // Address changed and caller didn't override coords — wipe them so the
  // next read clearly shows "no coords" and our post-update hook will try
  // to re-resolve via Census.
  out.locationLat = null;
  out.locationLng = null;
  out.lastGeocodedAddress = null;
  return out;
}

/**
 * After a site row is written, if it ended up with an address but no
 * coordinates, try to auto-geocode and stamp the result. Best-effort —
 * never throws, and returns the row that should be sent back to the
 * caller (re-fetched if we wrote new coords).
 */
export async function maybeAutoGeocode(
  row: Record<string, unknown>,
  log?: Pick<Logger, "info">,
): Promise<Record<string, unknown>> {
  const id = row.id as string | undefined;
  const address = (row.address as string | null | undefined) ?? null;
  const lat = (row.locationLat as string | null | undefined) ?? null;
  const lng = (row.locationLng as string | null | undefined) ?? null;
  if (!id || !address || lat != null || lng != null) return row;
  try {
    const result = await geocodeOnelineAddress(address);
    if (!result) return row;
    const [updated] = await db
      .update(sitesTable)
      .set({
        locationLat: String(result.lat),
        locationLng: String(result.lng),
        lastGeocodedAddress: address,
      })
      .where(eq(sitesTable.id, id))
      .returning();
    return (updated as Record<string, unknown>) ?? row;
  } catch (err) {
    log?.info({ err: (err as Error).message }, "Auto-geocode on site update failed");
    return row;
  }
}
