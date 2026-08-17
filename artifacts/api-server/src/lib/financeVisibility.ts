// Centralised finance-field visibility for shift and time-entry responses.
//
// The client bill rate (billRate/billableRate) is what WCSG charges the client
// and is the ONLY rate restricted to admin (and dispatcher, who is
// finance-bearing staff). The officer pay rate (payRate) is not commercially
// sensitive in the same way and is visible to every internal staff role
// (admin, dispatcher, site_manager, officer) — including a site manager
// viewing an officer's rate while scheduling or approving their time.
//
// The external client-portal role is the one exception: clients must never
// see any rate, pay or bill — they shouldn't normally reach shift/time-entry
// rows at all (staff routes are requireStaff-gated), but this keeps every
// rate out as defense in depth if a shared read ever hands them one.
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
 * - client: external customer — must never see any rate (pay or bill).
 * - everyone else (site_manager, officer/employee, and any other role): may
 *   see payRate, but NEVER the client bill rate (billRate/billableRate).
 */
export function stripShiftFinanceForRole<T extends Record<string, unknown>>(
  role: string | undefined,
  shift: T,
): T {
  if (role === "admin" || role === "dispatcher") return shift;
  if (role === "client") {
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
 * - client: external customer — strip every rate (see stripShiftFinanceForRole).
 * - everyone else (site_manager, officer): keep payRate, but never the client
 *   bill rate.
 */
export function stripTimeEntryBillRateForRole<T extends Record<string, unknown>>(
  role: string | undefined,
  row: T,
): T {
  if (role === "admin" || role === "dispatcher") return row;
  if (role === "client") {
    const { payRate, billRate, ...rest } = row as Record<string, unknown>;
    return rest as T;
  }
  const { billRate, ...rest } = row as Record<string, unknown>;
  return rest as T;
}
