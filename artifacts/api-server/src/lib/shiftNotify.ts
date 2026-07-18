import { and, eq, inArray } from "drizzle-orm";
import {
  db,
  usersTable,
  licensesTable,
  employeesTable,
  sitesTable,
  clientsTable,
} from "@workspace/db";
import { effectiveLevelSql, WORKER_ROLES } from "./eligibility";
import { getManagerUserIdsForSite } from "./siteManagerAuth";
import { logger } from "./logger";

// Company operating timezone (Central). Shift times are stored as UTC instants;
// notification/SMS copy must render them in the officer's local zone, otherwise
// the UTC clock reading is shown (e.g. a 5:30 PM Central start renders as
// "10:30 PM", which reads like the shift's end time).
export const COMPANY_TZ = "America/Chicago";

/** Format a shift instant for human-facing push/SMS copy, in company time. */
export function fmtShiftWhen(when: Date | string | number): string {
  return new Date(when).toLocaleString("en-US", {
    timeZone: COMPANY_TZ,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Short label for a shift's required level used in push/SMS copy. */
export function shiftLevelLabel(lvl: number): string {
  if (lvl <= 1) return "Support";
  if (lvl === 4) return "L4/PPO";
  return `L${lvl}+`;
}

type ShiftCreatedInput = {
  id: string;
  title: string;
  clientName?: string | null;
  startTime: Date | string | number;
  requiredLicenseLevel: number;
  siteId: string | null;
};

/**
 * Fan out the "a new shift was created" notifications. Shared by the manual
 * `POST /shifts` route AND the scheduler ingest (`processInboundShift`), so a
 * shift triggers the same alerts no matter where it originates. Previously only
 * the manual route notified, which meant scheduler-sourced shifts (the primary
 * source in production) silently reached nobody.
 *
 * Two audiences:
 *   1. Eligible WORKERS — role `employee` OR `site_manager` whose effective
 *      level covers the requirement — get a "New Shift Available" push so they
 *      can claim it. Site managers are workers too (see
 *      `lib/eligibility.isWorkerRole`), so they are INCLUDED here even for their
 *      own site: per product requirement a site manager receives the SAME
 *      employee notifications as anyone else.
 *   2. The site's assigned managers ALSO get a "New Shift At Your Site" push +
 *      SMS for scheduling oversight. So a manager of THIS shift's site receives
 *      BOTH (1) and (2) — the worker broadcast and the manager notice.
 *
 * Best-effort: every failure is swallowed (logged) so a notification problem
 * never blocks shift creation. Past-dated shifts (startTime already elapsed,
 * e.g. a scheduler backfill of historical rows) notify nobody.
 */
export async function notifyShiftCreated(shift: ShiftCreatedInput): Promise<void> {
  // Never notify about a shift that has already started — scheduler syncs can
  // ingest historical rows, and a past shift is not actionable for anyone.
  if (new Date(shift.startTime).getTime() <= Date.now()) return;

  // Resolve client name for nicer copy when the caller didn't supply it
  // (scheduler-created rows don't populate clientName).
  let clientName = shift.clientName ?? null;
  if (!clientName && shift.siteId) {
    try {
      const [site] = await db
        .select({ clientName: clientsTable.name })
        .from(sitesTable)
        .leftJoin(clientsTable, eq(clientsTable.id, sitesTable.clientId))
        .where(eq(sitesTable.id, shift.siteId))
        .limit(1);
      clientName = site?.clientName ?? null;
    } catch {
      // best-effort copy enrichment only — fall back to no client name
    }
  }

  const start = fmtShiftWhen(shift.startTime);
  const levelLabel = shiftLevelLabel(shift.requiredLicenseLevel);
  const at = clientName ? ` @ ${clientName}` : "";

  // Managers of this shift's site get the manager-specific "at your site" notice
  // below. They are ALSO workers, so they REMAIN in the worker broadcast and
  // receive the "shift available" page too — a site manager gets the same
  // employee notifications as everyone else AND the manager notice (no
  // exclusion / no dedupe between the two notification types).
  let managerIds: string[] = [];
  try {
    managerIds = await getManagerUserIdsForSite(shift.siteId);
  } catch (err) {
    logger.warn({ err, shiftId: shift.id }, "notifyShiftCreated: manager lookup failed");
  }

  // 1. Broadcast to ALL eligible workers (employees + site managers, including
  //    this site's own managers).
  try {
    const candidates = await db
      .select({ userId: usersTable.id, effLevel: effectiveLevelSql })
      .from(usersTable)
      .leftJoin(licensesTable, eq(licensesTable.employeeId, usersTable.id))
      .leftJoin(employeesTable, eq(employeesTable.userId, usersTable.id))
      .where(and(inArray(usersTable.role, [...WORKER_ROLES]), eq(usersTable.status, "active")))
      .groupBy(usersTable.id);

    const eligibleIds = candidates
      .filter((c) => c.effLevel >= shift.requiredLicenseLevel)
      .map((c) => c.userId);

    if (eligibleIds.length > 0) {
      const { sendPushToUsers } = await import("./push");
      await sendPushToUsers(eligibleIds, {
        title: `🛡️ New ${levelLabel} Shift Available`,
        body: `${shift.title}${at} — ${start}`,
        data: { type: "shift_available", shiftId: shift.id },
      });
    }
  } catch (err) {
    logger.warn({ err, shiftId: shift.id }, "notifyShiftCreated: worker broadcast failed");
  }

  // 2. Notify the site's assigned managers (push + SMS) for oversight.
  if (managerIds.length > 0) {
    try {
      const { sendPushToUsers } = await import("./push");
      const { sendSmsToUsers } = await import("./sms");
      await sendPushToUsers(managerIds, {
        title: "🗓️ New Shift At Your Site",
        body: `${shift.title}${at} — ${start}`,
        data: { type: "site_shift_created", shiftId: shift.id, siteId: shift.siteId },
      });
      void sendSmsToUsers(managerIds, `[WCSG] New shift at your site: ${shift.title} — ${start}.`);
    } catch (err) {
      logger.warn({ err, shiftId: shift.id }, "notifyShiftCreated: manager notify failed");
    }
  }
}
