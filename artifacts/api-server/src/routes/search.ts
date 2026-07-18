import { Router, type IRouter } from "express";
import { z } from "zod/v4";
import { asc, ilike, or, sql, eq } from "drizzle-orm";
import {
  db,
  usersTable,
  employeesTable,
  shiftsTable,
  sitesTable,
  incidentsTable,
  payrollEntriesTable,
  applicationsTable,
  chatRoomsTable,
} from "@workspace/db";
import { requireAdmin, requireAdminOrDispatcher } from "../middlewares/auth";
import { isFeatureEnabled, type FeatureKey } from "../lib/features";

const router: IRouter = Router();

// -----------------------------------------------------------------------
// Global search — GET /admin/search?q=<term>[&page=1&limit=10]
//
// Admin-only cross-domain text search. Returns results grouped by domain.
//
// Pagination: `page` (1-based, default 1) and `limit` (1–50, default 10)
// are applied per domain. Each domain's response includes a `hasMore` flag
// so the UI can offer a "Show more" button when results are cut off.
//
// Ranking: results are ordered by PostgreSQL full-text relevance
// (ts_rank over to_tsvector / plainto_tsquery) so the strongest match
// surfaces first, rather than insertion order.
//
// Per-domain results are omitted (empty array) when that domain's feature
// flag is disabled — matching the same DOMAIN_FEATURE exclusion pattern
// used by the Exports center (routes/exports.ts) and Dashboard aggregates
// (routes/dashboard.ts). This ensures that disabling a feature via
// DISABLED_FEATURES (or the super-admin UI) also removes that domain from
// any future global search surface without requiring code changes.
//
// Domain → feature gate mapping:
//   employees   → null    (core — always searched)
//   shifts      → null    (core — always searched)
//   incidents   → "incidents"
//   payroll     → "payroll"
//   applications→ "hr"
//   chatRooms   → "chat"
// -----------------------------------------------------------------------

export const DEFAULT_SEARCH_LIMIT = 10;
export const MAX_SEARCH_LIMIT = 50;

const querySchema = z.object({
  q: z.string().min(1).max(200),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(MAX_SEARCH_LIMIT).default(DEFAULT_SEARCH_LIMIT),
});

/**
 * Domain → feature key.  `null` means core — always searched.
 * Any new domain added here must also be reflected in the tests.
 */
export const DOMAIN_FEATURE = {
  employees: null,
  shifts: null,
  incidents: "incidents",
  payroll: "payroll",
  applications: "hr",
  chatRooms: "chat",
} as const satisfies Record<string, FeatureKey | null>;

type Domain = keyof typeof DOMAIN_FEATURE;

function domainEnabled(domain: Domain): boolean {
  const feature = DOMAIN_FEATURE[domain];
  if (feature === null) return true;
  return isFeatureEnabled(feature);
}

/**
 * Given a raw DB result set fetched with limit+1 rows, return the
 * paginated slice and a hasMore flag.
 */
function paginate<T>(rows: T[], limit: number): { items: T[]; hasMore: boolean } {
  const hasMore = rows.length > limit;
  return { items: hasMore ? rows.slice(0, limit) : rows, hasMore };
}

router.get("/admin/search", requireAdminOrDispatcher, async (req, res): Promise<void> => {
  const parsed = querySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "Bad Request", message: 'Query parameter "q" is required (1–200 chars); "limit" must be 1–50; "page" must be ≥ 1.' });
    return;
  }
  const { q, page, limit } = parsed.data;
  const term = `%${q}%`;
  const offset = (page - 1) * limit;
  // Fetch one extra row so we can detect hasMore without a COUNT query.
  const fetchLimit = limit + 1;

  // ts_rank rank expressions — each domain searches over its relevant text
  // columns. plainto_tsquery handles multi-word queries and ignores special
  // characters that would otherwise cause a syntax error.
  const employeeRank = sql<number>`ts_rank(
    to_tsvector('english',
      coalesce(${usersTable.firstName}, '') || ' ' ||
      coalesce(${usersTable.lastName}, '') || ' ' ||
      coalesce(${usersTable.email}, '')
    ),
    plainto_tsquery('english', ${q})
  )`;

  const shiftRank = sql<number>`ts_rank(
    to_tsvector('english',
      coalesce(${shiftsTable.title}, '') || ' ' ||
      coalesce(${sitesTable.name}, '')
    ),
    plainto_tsquery('english', ${q})
  )`;

  const incidentRank = sql<number>`ts_rank(
    to_tsvector('english',
      coalesce(${incidentsTable.title}, '') || ' ' ||
      coalesce(${incidentsTable.description}, '') || ' ' ||
      coalesce(${incidentsTable.locationDescription}, '')
    ),
    plainto_tsquery('english', ${q})
  )`;

  const payrollRank = sql<number>`ts_rank(
    to_tsvector('english',
      coalesce(${usersTable.firstName}, '') || ' ' ||
      coalesce(${usersTable.lastName}, '') || ' ' ||
      coalesce(${usersTable.email}, '') || ' ' ||
      coalesce(${payrollEntriesTable.status}, '')
    ),
    plainto_tsquery('english', ${q})
  )`;

  const applicationRank = sql<number>`ts_rank(
    to_tsvector('english',
      coalesce(${applicationsTable.firstName}, '') || ' ' ||
      coalesce(${applicationsTable.lastName}, '') || ' ' ||
      coalesce(${applicationsTable.email}, '')
    ),
    plainto_tsquery('english', ${q})
  )`;

  const chatRoomRank = sql<number>`ts_rank(
    to_tsvector('english', coalesce(${chatRoomsTable.name}, '')),
    plainto_tsquery('english', ${q})
  )`;

  const [employeeRows, shiftRows, incidentRows, payrollRows, applicationRows, chatRoomRows] = await Promise.all([
    // Employees — core (always searched)
    db
      .select({
        id: usersTable.id,
        domain: sql<"employees">`'employees'`,
        label: sql<string>`${usersTable.firstName} || ' ' || ${usersTable.lastName}`,
        sublabel: usersTable.email,
      })
      .from(usersTable)
      .leftJoin(employeesTable, eq(employeesTable.userId, usersTable.id))
      .where(
        or(
          ilike(usersTable.firstName, term),
          ilike(usersTable.lastName, term),
          ilike(usersTable.email, term),
          ilike(sql`${usersTable.firstName} || ' ' || ${usersTable.lastName}`, term),
        ),
      )
      .orderBy(sql`${employeeRank} DESC`, asc(usersTable.id))
      .limit(fetchLimit)
      .offset(offset),

    // Shifts — core (always searched)
    db
      .select({
        id: shiftsTable.id,
        domain: sql<"shifts">`'shifts'`,
        label: shiftsTable.title,
        sublabel: sitesTable.name,
      })
      .from(shiftsTable)
      .leftJoin(sitesTable, eq(sitesTable.id, shiftsTable.siteId))
      .where(
        or(
          ilike(shiftsTable.title, term),
          ilike(sitesTable.name, term),
        ),
      )
      .orderBy(sql`${shiftRank} DESC`, asc(shiftsTable.id))
      .limit(fetchLimit)
      .offset(offset),

    // Incidents — gated behind "incidents" feature
    domainEnabled("incidents")
      ? db
          .select({
            id: incidentsTable.id,
            domain: sql<"incidents">`'incidents'`,
            label: incidentsTable.title,
            sublabel: incidentsTable.severity,
          })
          .from(incidentsTable)
          .where(
            or(
              ilike(incidentsTable.title, term),
              ilike(incidentsTable.description, term),
              ilike(incidentsTable.locationDescription, term),
            ),
          )
          .orderBy(sql`${incidentRank} DESC`, asc(incidentsTable.id))
          .limit(fetchLimit)
          .offset(offset)
      : Promise.resolve([]),

    // Payroll entries — gated behind "payroll" feature
    domainEnabled("payroll")
      ? db
          .select({
            id: payrollEntriesTable.id,
            domain: sql<"payroll">`'payroll'`,
            label: sql<string>`'Payroll entry ' || ${payrollEntriesTable.periodStart}::text || ' – ' || ${payrollEntriesTable.periodEnd}::text`,
            sublabel: payrollEntriesTable.status,
          })
          .from(payrollEntriesTable)
          .leftJoin(usersTable, eq(usersTable.id, payrollEntriesTable.employeeId))
          .where(
            or(
              ilike(usersTable.firstName, term),
              ilike(usersTable.lastName, term),
              ilike(usersTable.email, term),
              ilike(payrollEntriesTable.status, term),
            ),
          )
          .orderBy(sql`${payrollRank} DESC`, asc(payrollEntriesTable.id))
          .limit(fetchLimit)
          .offset(offset)
      : Promise.resolve([]),

    // Applications — gated behind "hr" feature
    domainEnabled("applications")
      ? db
          .select({
            id: applicationsTable.id,
            domain: sql<"applications">`'applications'`,
            label: sql<string>`${applicationsTable.firstName} || ' ' || ${applicationsTable.lastName}`,
            sublabel: applicationsTable.status,
          })
          .from(applicationsTable)
          .where(
            or(
              ilike(applicationsTable.firstName, term),
              ilike(applicationsTable.lastName, term),
              ilike(applicationsTable.email, term),
              ilike(sql`${applicationsTable.firstName} || ' ' || ${applicationsTable.lastName}`, term),
            ),
          )
          .orderBy(sql`${applicationRank} DESC`, asc(applicationsTable.id))
          .limit(fetchLimit)
          .offset(offset)
      : Promise.resolve([]),

    // Chat rooms — gated behind "chat" feature
    domainEnabled("chatRooms")
      ? db
          .select({
            id: chatRoomsTable.id,
            domain: sql<"chatRooms">`'chatRooms'`,
            label: chatRoomsTable.name,
            sublabel: chatRoomsTable.type,
          })
          .from(chatRoomsTable)
          .where(ilike(chatRoomsTable.name, term))
          .orderBy(sql`${chatRoomRank} DESC`, asc(chatRoomsTable.id))
          .limit(fetchLimit)
          .offset(offset)
      : Promise.resolve([]),
  ]);

  const { items: employees, hasMore: employeesHasMore } = paginate(employeeRows, limit);
  const { items: shifts, hasMore: shiftsHasMore } = paginate(shiftRows, limit);
  const { items: incidents, hasMore: incidentsHasMore } = paginate(incidentRows, limit);
  const { items: payroll, hasMore: payrollHasMore } = paginate(payrollRows, limit);
  const { items: applications, hasMore: applicationsHasMore } = paginate(applicationRows, limit);
  const { items: chatRooms, hasMore: chatRoomsHasMore } = paginate(chatRoomRows, limit);

  res.json({
    q,
    page,
    limit,
    employees,
    shifts,
    incidents,
    payroll,
    applications,
    chatRooms,
    hasMore: {
      employees: employeesHasMore,
      shifts: shiftsHasMore,
      incidents: incidentsHasMore,
      payroll: payrollHasMore,
      applications: applicationsHasMore,
      chatRooms: chatRoomsHasMore,
    },
    featureStatus: {
      incidents: domainEnabled("incidents"),
      payroll: domainEnabled("payroll"),
      applications: domainEnabled("applications"),
      chatRooms: domainEnabled("chatRooms"),
    },
  });
});

export default router;
