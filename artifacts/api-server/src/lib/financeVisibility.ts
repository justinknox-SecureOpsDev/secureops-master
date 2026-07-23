// Centralised finance-field visibility for shift and time-entry responses.
//
// The client bill rate (billRate/billableRate) is what WCSG charges the client
// and is commercially sensitive — it must reach finance-bearing staff only
// (admin/dispatcher). The officer pay rate (payRate) is what an officer earns
// and may be shown to that officer. Site managers schedule and staff work
// but must never see any rate at all.
//
// These helpers are the single source of truth for that policy so every
// caller-reachable response (shifts list/detail/create, the mobile dashboard
// summary, time-entry lists) strips the same fields for the same role. Any new
// endpoint that returns raw `shifts` rows to a non-admin MUST run them through
// stripShiftFinanceForRole.

/**
 * Strip financial fields a caller must not see before returning a shift row.
 *
 * - admin / dispatcher: finance-bearing staff — see pay AND bill rates.
 * - site_manager: schedules and staffs shifts but must never see any rate (pay or bill).
 * - everyone else (officers/employees and any other role): may see their own
 *   pay rate, but NEVER the client bill rate (billRate/billableRate).
 */
export function stripShiftFinanceForRole<T extends Record<string, unknown>>(
  role: string | undefined,
  shift: T,
): T {
  if (role === "admin" || role === "dispatcher") return shift;
  // Site managers and external client-portal contacts must never see ANY
  // rate. Clients shouldn't normally reach shift rows at all (staff routes
  // are requireStaff-gated), but if a shared read ever hands them one this
  // keeps every rate out as defense in depth.
  if (role === "site_manager" || role === "client") {
    const { payRate, billRate, hourlyRate, billableRate, ...rest } = shift as Record<string, unknown>;
    return rest as T;
  }
  const { billRate, billableRate, ...rest } = shift as Record<string, unknown>;
  return rest as T;
}

/**
 * Strip finance fields a caller must not see from a time-entry row.
 *
 * - admin / dispatcher: see pay AND bill rates.
 * - site_manager: schedules and approves work but must never see any rate —
 *   strip BOTH payRate and billRate (mirrors stripShiftFinanceForRole).
 * - everyone else (officers): keep payRate so they can see their own earnings,
 *   but never the client bill rate.
 */
export function stripTimeEntryBillRateForRole<T extends Record<string, unknown>>(
  role: string | undefined,
  row: T,
): T {
  if (role === "admin" || role === "dispatcher") return row;
  // Site managers and clients: strip every rate (see stripShiftFinanceForRole).
  if (role === "site_manager" || role === "client") {
    const { payRate, billRate, ...rest } = row as Record<string, unknown>;
    return rest as T;
  }
  const { billRate, ...rest } = row as Record<string, unknown>;
  return rest as T;
}
