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
//
// Every `numeric`-typed column on shiftsTable / timeEntriesTable must be
// accounted for by the allowlists in financeVisibility.test.ts (schema-drift
// coverage, mirroring the DASHBOARD_FINANCE_FIELDS test below) — that test
// fails the moment a new money-shaped column is added to either table
// without an explicit strip/keep decision, so a new rate field can't
// silently reach the client role.

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
    const { payRate, billRate, payRateOverride, ...rest } = row as Record<string, unknown>;
    return rest as T;
  }
  // payRateOverride is the raw admin-set override input on time_entries
  // (see schema comment on timeEntriesTable.payRateOverride) — the same
  // admin/dispatcher-only class as billRate, not the officer-facing
  // resolved `payRate` field. The wired-up caller (routes/timeEntries.ts)
  // already renames it to `_payRateOverride` and drops it before reaching
  // here, so this is defense in depth for any other caller that passes a
  // raw time_entries row straight through.
  const { billRate, payRateOverride, ...rest } = row as Record<string, unknown>;
  return rest as T;
}

// ---------------------------------------------------------------------------
// Company-owner dashboard finance visibility (Task #733)
//
// SEPARATE axis from the pay/bill-rate policy above: this gates the
// aggregate, company-wide financial picture (revenue, margin, profit,
// payroll/invoice board totals) behind the `isCompanyOwner` flag rather than
// role. An admin who is not an owner must have these fields stripped from
// dashboard JSON exactly like a non-owner of any other role — the two checks
// are independent and BOTH apply where relevant (e.g. a non-admin,
// non-owner caller gets both the role-based rate strip AND the owner-based
// dashboard strip).
//
// Field-name allowlist approach: any key matching one of these (case
// sensitive, exact match against the known field set below) is treated as
// a company-financial-aggregate field and stripped for non-owners. New
// dashboard endpoints should add their money-bearing field names here rather
// than inventing a bespoke strip, so the policy stays centralized.
// ---------------------------------------------------------------------------

/**
 * Canonical set of aggregate financial field names gated behind the
 * company-owner flag.
 *
 * This also covers the GET /payroll and GET /invoices PLAIN LIST endpoints
 * (see routes/payroll.ts, routes/invoices.ts): a non-owner bookkeeper with
 * `finance.transactions` may browse those lists to locate a record, but the
 * list itself must carry NO dollar figure of any kind — not just summed
 * dashboard totals, but each row's own subtotal/tax/fee/gross/net, since a
 * list of every record's amount is functionally the same leak as a single
 * aggregate. (Per-record detail — opening ONE invoice/payroll entry via its
 * own route — is a separate, allowed axis; see the comment block in
 * companyOwnerAndPermissions.test.ts.)
 *
 * Every `numeric`-typed column on payrollEntriesTable / invoicesTable must
 * either appear here or be added to the small allowlist of per-record rate/
 * duration fields in the schema-drift test (companyOwnerAndPermissions.test.ts)
 * that are intentionally NOT aggregate money (e.g. hourlyRate — a single
 * officer's own rate, the same class as shift payRate). That test fails the
 * build the moment a new numeric column is added to either table without an
 * explicit decision either way, so this list can't silently go stale.
 */
export const DASHBOARD_FINANCE_FIELDS = new Set([
  "revenue",
  "totalRevenue",
  "margin",
  "marginPercent",
  "profit",
  "grossProfit",
  "netProfit",
  "laborCost",
  "totalLaborCost",
  "totalCost",
  "grossPay",
  "totalGrossPay",
  "netPay",
  "totalNetPay",
  "totalPayroll",
  "totalInvoiced",
  "totalBilled",
  "totalAmount",
  "subtotal",
  "tax",
  "taxAmount",
  "feeAmount",
  "processingFeeAmount",
  "processingFeeRate",
  "invoiceTotal",
  "payrollTotal",
  "avgBillRate",
  "avgPayRate",
  "billableRevenue",
  // Not a numeric column, but a jsonb array of per-line { hours, rate,
  // amount } money breakdown — the single richest source of company money
  // detail on the invoice list row. The plain list has no legitimate use
  // for it (only /invoices/:id/entries and the PDF route do), so it is
  // stripped as a whole rather than trying to sanitize nested line items.
  "lineItems",
]);

/**
 * Strip company-wide financial-aggregate fields from a dashboard payload
 * when the caller is not a company owner. Recurses into plain objects and
 * arrays (charts/trend series, per-site/per-officer breakdown rows) so a
 * single call at the route's response boundary covers nested structures.
 *
 * NOT a replacement for the server-side `requireCompanyOwner` gate on
 * endpoints that are wholly financial (those should 403 outright) — this is
 * for the "mixed data" case: a route that legitimately serves some
 * non-financial fields (counts, names, dates) to every caller alongside
 * owner-only financial fields.
 */
export function stripDashboardFinanceForOwner<T>(isOwner: boolean, value: T): T {
  if (isOwner) return value;
  return stripFinanceDeep(value) as T;
}

function stripFinanceDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripFinanceDeep);
  if (value && typeof value === "object" && !(value instanceof Date)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (DASHBOARD_FINANCE_FIELDS.has(k)) continue;
      out[k] = stripFinanceDeep(v);
    }
    return out;
  }
  return value;
}
