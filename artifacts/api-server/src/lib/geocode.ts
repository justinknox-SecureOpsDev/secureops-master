import { logger } from "./logger";

export type GeocodeResult = { lat: number; lng: number };

/**
 * Best-effort US geocoder using the US Census Bureau's free public
 * geocoding API. No API key required, but US-only — perfect for the
 * Texas applicant footprint. Returns null on any failure (network,
 * unparseable, no match). Caller MUST treat null as "unknown" and
 * never block on the result.
 *
 * Census API docs:
 *   https://geocoding.geo.census.gov/geocoder/Geocoding_Services_API.pdf
 */
export async function geocodeUsAddress(parts: {
  street?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
}): Promise<GeocodeResult | null> {
  const street = parts.street?.trim();
  const city = parts.city?.trim();
  const state = parts.state?.trim();
  const zip = parts.zip?.trim();
  // Census needs at least a street + (city/state or zip) to have any
  // chance of resolving. Bail early if we have nothing useful.
  if (!street || (!city && !state && !zip)) return null;

  const url = new URL("https://geocoding.geo.census.gov/geocoder/locations/address");
  url.searchParams.set("street", street);
  if (city) url.searchParams.set("city", city);
  if (state) url.searchParams.set("state", state);
  if (zip) url.searchParams.set("zip", zip);
  url.searchParams.set("benchmark", "Public_AR_Current");
  url.searchParams.set("format", "json");

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(url.toString(), { signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) {
      logger.info({ status: res.status }, "Geocode HTTP non-2xx");
      return null;
    }
    const data = (await res.json()) as {
      result?: { addressMatches?: Array<{ coordinates?: { x?: number; y?: number } }> };
    };
    const match = data.result?.addressMatches?.[0]?.coordinates;
    if (typeof match?.x !== "number" || typeof match?.y !== "number") return null;
    // Census returns x=lng, y=lat
    return { lat: match.y, lng: match.x };
  } catch (err) {
    logger.info({ err: (err as Error).message }, "Geocode failed");
    return null;
  }
}
