import { and, count, countDistinct, eq, gt, gte, inArray, isNull, lt, ne, or, sql } from "drizzle-orm";
import {
  db,
  sitesTable,
  siteRatesTable,
  shiftsTable,
  usersTable,
  clientsTable,
  incidentsTable,
  incidentShareLinksTable,
  dailyActivityReportsTable,
  patrolCheckpointsTable,
  shiftSwapRequestsTable,
  shiftRequestsTable,
  officerAvailabilityWindowsTable,
  trainingCertificationsTable,
  subcontractorTimeEntriesTable,
  subcontractorInvoicesTable,
  permissionOverridesTable,
  assistantSuggestionDismissalsTable,
} from "@workspace/db";
import { getManagedSiteIds } from "../siteManagerAuthz";
import { isFeatureEnabled, type FeatureKey } from "../features";
import { logger } from "../logger";

/**
 * Adoption & efficiency signal engine.
 *
 * Findings are computed HERE, in code, from ordinary aggregate queries — the
 * language model never invents one, never runs its own query, and never
 * restates a number a check did not produce. Its only job downstream is to
 * phrase what this file returns. That is what makes the suggestions
 * trustworthy, and it is why the list keeps working when Gemini is not
 * connected at all.
 *
 * Every check is scoped to what the signed-in user may already see: a site
 * manager's findings cover only the sites they manage, and company-wide money
 * checks are admin-only. A check for a feature the deployment has switched off
 * is skipped rather than suggested.
 *
 * Findings are never stored. They are recomputed on read, so one disappears by
 * itself the moment its condition is resolved. The only persisted state is a
 * per-user dismissal (see the assistant_suggestion_dismissals table).
 */

export type FindingCategory = "money" | "compliance" | "client" | "dispatch" | "admin";

export type Finding = {
  /** Stable across releases — dismissals are keyed on it. */
  id: string;
  category: FindingCategory;
  title: string;
  /** The measured fact behind the finding. Produced by the query, never by the model. */
  evidence: string;
  /** Why the admin should care, in their terms. */
  benefit: string;
  /** Portal route that resolves it. */
  route: string;
  routeLabel: string;
};

/** Money first, then compliance, then client deliverables, then workload, then housekeeping. */
const CATEGORY_RANK: Record<FindingCategory, number> = {
  money: 0,
  compliance: 1,
  client: 2,
  dispatch: 3,
  admin: 4,
};

export type AssistantScope = {
  userId: string;
  role: string;
  /** null = every site (admin); otherwise the exact sites this user manages. */
  siteIds: string[] | null;
};

export async function resolveScope(user: { userId: string; role: string }): Promise<AssistantScope> {
  if (user.role === "admin") return { userId: user.userId, role: user.role, siteIds: null };
  if (user.role === "site_manager") {
    return { userId: user.userId, role: user.role, siteIds: await getManagedSiteIds(user.userId) };
  }
  // Dispatchers and anyone else get no site-scoped findings at all rather than
  // an accidental company-wide view.
  return { userId: user.userId, role: user.role, siteIds: [] };
}

type Check = {
  id: string;
  category: FindingCategory;
  /** Skip entirely when this feature is switched off for the deployment. */
  feature?: FeatureKey;
  /** Company-wide checks only an admin may see. */
  adminOnly: boolean;
  run: (scope: AssistantScope) => Promise<Finding | null>;
};

const DAY = 24 * 60 * 60 * 1000;
const RECENT_SHIFT_DAYS = 60;

function since(days: number): Date {
  return new Date(Date.now() - days * DAY);
}

/** Restrict a site-keyed query to the caller's scope. Null scope = unrestricted. */
function siteScopeFilter(column: typeof sitesTable.id, siteIds: string[] | null) {
  if (siteIds === null) return undefined;
  if (siteIds.length === 0) return sql`false`;
  return inArray(column, siteIds);
}

const CHECKS: Check[] = [
  // ── Money ────────────────────────────────────────────────────────────────
  {
    id: "site_bill_rate_missing",
    category: "money",
    // Admin-only even though it is site-scoped: the finding names client bill
    // rates and un-invoiced revenue, and a site manager must never see client
    // finance — not even for a site they manage.
    adminOnly: true,
    async run(scope) {
      const scopeFilter = siteScopeFilter(sitesTable.id, scope.siteIds);
      const rows = await db
        .select({ id: sitesTable.id, name: sitesTable.name })
        .from(sitesTable)
        .where(
          and(
            eq(sitesTable.status, "active"),
            // No usable default bill rate on the site…
            or(isNull(sitesTable.defaultBillRate), lt(sitesTable.defaultBillRate, "0.01")),
            // …and no priced rate row either.
            sql`not exists (select 1 from ${siteRatesTable} sr where sr.site_id = ${sitesTable.id} and sr.bill_rate > 0)`,
            // …but hours are actually being worked there.
            sql`exists (select 1 from ${shiftsTable} sh where sh.site_id = ${sitesTable.id} and sh.start_time > ${since(RECENT_SHIFT_DAYS)})`,
            ...(scopeFilter ? [scopeFilter] : []),
          ),
        )
        .limit(6);
      if (rows.length === 0) return null;
      const names = rows.map((r) => r.name).join(", ");
      return {
        id: "site_bill_rate_missing",
        category: "money",
        title: "Some sites have no bill rate, so their hours are not being invoiced",
        evidence: `${rows.length} active ${rows.length === 1 ? "site has" : "sites have"} had shifts in the last ${RECENT_SHIFT_DAYS} days with no default bill rate and no priced rate row: ${names}.`,
        benefit:
          "Approved hours at a site with no resolvable bill rate are silently left off the client invoice — the work is done and recorded, and never billed. Setting the rate closes a live revenue leak.",
        route: "/tables/sites",
        routeLabel: "Clients & Sites → Sites",
      };
    },
  },
  {
    id: "subcontractor_hours_uninvoiced",
    category: "money",
    adminOnly: true,
    async run() {
      const [entries] = await db
        .select({ n: count(), hours: sql<string>`coalesce(sum(${subcontractorTimeEntriesTable.hoursWorked}), 0)` })
        .from(subcontractorTimeEntriesTable);
      const [invoices] = await db.select({ n: count() }).from(subcontractorInvoicesTable);
      if (!entries || entries.n === 0 || (invoices?.n ?? 0) > 0) return null;
      const hours = Number(entries.hours ?? 0);
      return {
        id: "subcontractor_hours_uninvoiced",
        category: "money",
        title: "Subcontractor hours are being captured but never invoiced here",
        evidence: `${entries.n} subcontractor clock-in ${entries.n === 1 ? "entry" : "entries"}${hours > 0 ? ` (${hours.toFixed(1)} hours)` : ""} recorded, and no subcontractor invoice has ever been created.`,
        benefit:
          "The hours are already in the system. Running them through subcontractor invoicing means the paperwork matches what was worked, instead of being reconciled by hand outside the platform.",
        route: "/tables/subcontractor_invoices",
        routeLabel: "Contracts → Invoices",
      };
    },
  },

  // ── Compliance ───────────────────────────────────────────────────────────
  {
    id: "pending_accounts_stale",
    category: "compliance",
    adminOnly: true,
    feature: "hr",
    async run() {
      const cutoff = since(14);
      const [row] = await db
        .select({ n: count() })
        .from(usersTable)
        .where(and(eq(usersTable.status, "pending"), lt(usersTable.createdAt, cutoff)));
      if (!row || row.n === 0) return null;
      return {
        id: "pending_accounts_stale",
        category: "compliance",
        title: "People are stuck part-way through onboarding",
        evidence: `${row.n} account${row.n === 1 ? " has" : "s have"} been sitting in pending for more than 14 days.`,
        benefit:
          "A pending account cannot be rostered, cannot clock in, and does not know it is waiting on anyone. Clearing the queue either puts them to work or frees up the pipeline.",
        route: "/hr/onboarding",
        routeLabel: "Personnel Management → Onboarding",
      };
    },
  },
  {
    id: "training_records_unused",
    category: "compliance",
    adminOnly: true,
    feature: "trainings",
    async run() {
      const [staff] = await db
        .select({ n: count() })
        .from(usersTable)
        .where(and(eq(usersTable.status, "active"), ne(usersTable.role, "client")));
      const [certs] = await db.select({ n: count() }).from(trainingCertificationsTable);
      const staffN = staff?.n ?? 0;
      const certN = certs?.n ?? 0;
      // Only worth raising once there is a real workforce, and only while
      // coverage is negligible (under 5%).
      if (staffN < 20 || certN >= staffN * 0.05) return null;
      return {
        id: "training_records_unused",
        category: "compliance",
        title: "Training certifications are barely recorded",
        evidence: `${certN} training certification${certN === 1 ? "" : "s"} on file across ${staffN} active staff.`,
        benefit:
          "Sites can require specific training before an officer works there. Without the records, that requirement cannot be enforced or evidenced to a client during an audit.",
        route: "/tables/training-certifications",
        routeLabel: "Compliance & Training → Training",
      };
    },
  },
  {
    id: "permission_matrix_unused",
    category: "admin",
    adminOnly: true,
    async run() {
      const [overrides] = await db.select({ n: count() }).from(permissionOverridesTable);
      const [nonAdmins] = await db
        .select({ n: count() })
        .from(usersTable)
        .where(
          and(
            eq(usersTable.status, "active"),
            inArray(usersTable.role, ["dispatcher", "site_manager"]),
          ),
        );
      if ((overrides?.n ?? 0) > 0 || (nonAdmins?.n ?? 0) === 0) return null;
      return {
        id: "permission_matrix_unused",
        category: "admin",
        title: "Every role is still on its default permissions",
        evidence: `${nonAdmins!.n} active dispatcher/site-manager account${nonAdmins!.n === 1 ? "" : "s"} and no permission has ever been adjusted.`,
        benefit:
          "The permission matrix lets you hand out one job — approving time, or handling invoices — without making someone a full admin. Most teams find at least one task they would rather delegate than do themselves.",
        route: "/settings/permissions",
        routeLabel: "Platform → Permissions",
      };
    },
  },

  // ── Client-facing deliverables ───────────────────────────────────────────
  {
    id: "patrol_unused",
    category: "client",
    adminOnly: false,
    feature: "patrol",
    async run(scope) {
      const scopeFilter = siteScopeFilter(sitesTable.id, scope.siteIds);
      const [sites] = await db
        .select({ n: count() })
        .from(sitesTable)
        .where(and(eq(sitesTable.status, "active"), ...(scopeFilter ? [scopeFilter] : [])));
      if (!sites || sites.n === 0) return null;
      const cpScope = siteScopeFilter(patrolCheckpointsTable.siteId as unknown as typeof sitesTable.id, scope.siteIds);
      const [checkpoints] = await db
        .select({ n: count() })
        .from(patrolCheckpointsTable)
        .where(and(eq(patrolCheckpointsTable.isActive, true), ...(cpScope ? [cpScope] : [])));
      if ((checkpoints?.n ?? 0) > 0) return null;
      return {
        id: "patrol_unused",
        category: "client",
        title: "No patrol checkpoints are set up, so there is no proof of patrol",
        evidence: `${sites.n} active site${sites.n === 1 ? "" : "s"} and zero patrol checkpoints defined.`,
        benefit:
          "Checkpoints turn 'the officer says they walked the rounds' into a timestamped scan record you can show a client who is questioning coverage.",
        route: "/tables/sites",
        routeLabel: "Clients & Sites → Sites",
      };
    },
  },
  {
    id: "dar_unused",
    category: "client",
    adminOnly: false,
    feature: "dar",
    async run(scope) {
      const cutoff = since(30);
      const shiftScope = siteScopeFilter(shiftsTable.siteId as unknown as typeof sitesTable.id, scope.siteIds);
      const [shifts] = await db
        .select({ n: count() })
        .from(shiftsTable)
        .where(and(gte(shiftsTable.startTime, cutoff), lt(shiftsTable.endTime, new Date()), ...(shiftScope ? [shiftScope] : [])));
      const darScope = siteScopeFilter(dailyActivityReportsTable.siteId as unknown as typeof sitesTable.id, scope.siteIds);
      const [reports] = await db
        .select({ n: count() })
        .from(dailyActivityReportsTable)
        .where(and(gte(dailyActivityReportsTable.createdAt, cutoff), ...(darScope ? [darScope] : [])));
      const shiftN = shifts?.n ?? 0;
      const reportN = reports?.n ?? 0;
      if (shiftN < 10 || reportN >= shiftN * 0.1) return null;
      return {
        id: "dar_unused",
        category: "client",
        title: "Daily activity reports are not being produced",
        evidence: `${reportN} daily activity report${reportN === 1 ? "" : "s"} filed against ${shiftN} completed shifts in the last 30 days.`,
        benefit:
          "The daily report is the standard end-of-shift deliverable most clients expect. Officers can file one from the app in under a minute, and it becomes the record of what happened on post.",
        route: "/dar",
        routeLabel: "Dispatch → Daily Reports",
      };
    },
  },
  {
    id: "incident_shares_unused",
    category: "client",
    adminOnly: true,
    feature: "incidents",
    async run() {
      const [incidents] = await db.select({ n: count() }).from(incidentsTable);
      const [shares] = await db.select({ n: count() }).from(incidentShareLinksTable);
      if ((incidents?.n ?? 0) < 3 || (shares?.n ?? 0) > 0) return null;
      return {
        id: "incident_shares_unused",
        category: "client",
        title: "Incident reports are leaving the system by hand",
        evidence: `${incidents!.n} incidents recorded and no share link has ever been created.`,
        benefit:
          "A share link gives the client a revocable, tracked, single-incident view instead of an emailed PDF you can never take back — and you can see whether they opened it.",
        route: "/incidents/share-links",
        routeLabel: "Dispatch → Incident shares",
      };
    },
  },
  {
    id: "client_portal_unused",
    category: "client",
    adminOnly: true,
    async run() {
      const [clients] = await db.select({ n: count() }).from(clientsTable);
      const [logins] = await db
        .select({ n: count() })
        .from(usersTable)
        .where(eq(usersTable.role, "client"));
      const clientN = clients?.n ?? 0;
      const loginN = logins?.n ?? 0;
      if (clientN < 3 || loginN >= clientN * 0.25) return null;
      return {
        id: "client_portal_unused",
        category: "client",
        title: "Most clients have no login of their own",
        evidence: `${clientN} client${clientN === 1 ? "" : "s"} on the books and ${loginN} client portal login${loginN === 1 ? "" : "s"}.`,
        benefit:
          "A client with a login pulls their own schedules, reports and invoices instead of emailing your team for them. It is the cheapest way to cut routine inbound questions.",
        route: "/hr/client-users",
        routeLabel: "Clients & Sites → Client Users",
      };
    },
  },

  // ── Dispatch workload ────────────────────────────────────────────────────
  {
    id: "swap_requests_unused",
    category: "dispatch",
    adminOnly: true,
    feature: "swapRequests",
    async run() {
      const [officers] = await db
        .select({ n: count() })
        .from(usersTable)
        .where(and(eq(usersTable.status, "active"), eq(usersTable.role, "employee")));
      const [swaps] = await db.select({ n: count() }).from(shiftSwapRequestsTable);
      if ((officers?.n ?? 0) < 10 || (swaps?.n ?? 0) > 0) return null;
      return {
        id: "swap_requests_unused",
        category: "dispatch",
        title: "Shift swaps are all being handled by hand",
        evidence: `${officers!.n} active officers and not one swap request has ever been raised in the system.`,
        benefit:
          "Officers can offer a shift to an eligible colleague themselves and you just approve the trade. Every swap that goes through the app is a phone call your dispatchers do not take.",
        route: "/swap-requests",
        routeLabel: "Staffing → Swap Requests",
      };
    },
  },
  {
    id: "coverage_requests_unused",
    category: "dispatch",
    adminOnly: true,
    async run() {
      const [clients] = await db.select({ n: count() }).from(clientsTable);
      const [requests] = await db.select({ n: count() }).from(shiftRequestsTable);
      if ((clients?.n ?? 0) < 3 || (requests?.n ?? 0) > 0) return null;
      return {
        id: "coverage_requests_unused",
        category: "dispatch",
        title: "Clients cannot ask for extra coverage themselves",
        evidence: `${clients!.n} clients and no coverage request has ever come through the portal.`,
        benefit:
          "A coverage request turns into a shift on approval, with the site, times and headcount already filled in — instead of an email your team retypes into the roster.",
        route: "/hr/coverage-requests",
        routeLabel: "Staffing → Coverage Requests",
      };
    },
  },
  {
    id: "availability_unused",
    category: "dispatch",
    adminOnly: true,
    feature: "availability",
    async run() {
      const [officers] = await db
        .select({ n: count() })
        .from(usersTable)
        .where(and(eq(usersTable.status, "active"), eq(usersTable.role, "employee")));
      const [withWindows] = await db
        .select({ n: countDistinct(officerAvailabilityWindowsTable.userId) })
        .from(officerAvailabilityWindowsTable);
      const officerN = officers?.n ?? 0;
      const covered = withWindows?.n ?? 0;
      if (officerN < 20 || covered >= officerN * 0.1) return null;
      return {
        id: "availability_unused",
        category: "dispatch",
        title: "Almost no officer has recorded when they can work",
        evidence: `${covered} of ${officerN} active officers have any availability on file.`,
        benefit:
          "With availability recorded, filling an open post stops being guesswork about who is free — you can see it before you start calling around.",
        route: "/personnel",
        routeLabel: "Dispatch → Personnel",
      };
    },
  },
];

// ── Dismissals ─────────────────────────────────────────────────────────────

const DEFAULT_SNOOZE_DAYS = 30;

export async function dismissFinding(userId: string, findingId: string, permanent = false): Promise<void> {
  const resurfaceAfter = permanent ? null : new Date(Date.now() + DEFAULT_SNOOZE_DAYS * DAY);
  await db
    .insert(assistantSuggestionDismissalsTable)
    .values({ userId, findingId, resurfaceAfter })
    .onConflictDoUpdate({
      target: [assistantSuggestionDismissalsTable.userId, assistantSuggestionDismissalsTable.findingId],
      set: { resurfaceAfter, dismissedAt: new Date() },
    });
  cache.delete(userId);
}

async function activeDismissals(userId: string): Promise<Set<string>> {
  const rows = await db
    .select({
      findingId: assistantSuggestionDismissalsTable.findingId,
      resurfaceAfter: assistantSuggestionDismissalsTable.resurfaceAfter,
    })
    .from(assistantSuggestionDismissalsTable)
    .where(eq(assistantSuggestionDismissalsTable.userId, userId));
  const now = Date.now();
  return new Set(
    rows
      .filter((r) => r.resurfaceAfter === null || r.resurfaceAfter.getTime() > now)
      .map((r) => r.findingId),
  );
}

// ── Public entry point ─────────────────────────────────────────────────────

const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map<string, { at: number; findings: Finding[] }>();

/** Test helper — drop the per-user findings cache. */
export function clearSignalCacheForTests(): void {
  cache.clear();
}

/**
 * Compute the findings this user should see, ranked. Cached briefly per user
 * so opening the panel repeatedly does not re-run a dozen aggregates.
 */
export async function computeFindings(
  user: { userId: string; role: string },
  opts: { skipCache?: boolean } = {},
): Promise<Finding[]> {
  if (!opts.skipCache) {
    const hit = cache.get(user.userId);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.findings;
  }

  const scope = await resolveScope(user);
  const isAdmin = scope.role === "admin";
  const eligible = CHECKS.filter((c) => {
    if (c.adminOnly && !isAdmin) return false;
    if (c.feature && !isFeatureEnabled(c.feature)) return false;
    // A site-scoped check is pointless for someone who manages no sites.
    if (!c.adminOnly && scope.siteIds !== null && scope.siteIds.length === 0) return false;
    return true;
  });

  const settled = await Promise.all(
    eligible.map(async (c) => {
      try {
        return await c.run(scope);
      } catch (err) {
        // One broken check must never take the whole list down.
        logger.warn({ err, check: c.id }, "[assistant] adoption check failed");
        return null;
      }
    }),
  );

  const dismissed = await activeDismissals(user.userId);
  const findings = settled
    .filter((f): f is Finding => f !== null)
    .filter((f) => !dismissed.has(f.id))
    .sort((a, b) => CATEGORY_RANK[a.category] - CATEGORY_RANK[b.category]);

  cache.set(user.userId, { at: Date.now(), findings });
  return findings;
}

/** Compact, model-facing rendering. Every number here came from a query above. */
export function findingsForModel(findings: Finding[]): string {
  if (findings.length === 0) return "No findings — this account is using the capabilities that apply to it.";
  return findings
    .map(
      (f, i) =>
        `${i + 1}. [${f.id}] ${f.title}\n   Measured: ${f.evidence}\n   Benefit: ${f.benefit}\n   Where: ${f.routeLabel} (${f.route})`,
    )
    .join("\n");
}

/** Exposed for the guard test that asserts every finding id is unique/stable. */
export const CHECK_IDS: readonly string[] = CHECKS.map((c) => c.id);
