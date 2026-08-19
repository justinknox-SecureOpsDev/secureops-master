import { and, eq, gte, inArray, or, sql } from "drizzle-orm";
import {
  db,
  licensesTable,
  shiftAssignmentsTable,
  sitesTable,
  trainingCertificationsTable,
  usersTable,
} from "@workspace/db";
import { effectiveLevelSql, getEffectiveLevel, WORKER_ROLES } from "./eligibility";

export type EligibilityShift = {
  id: string;
  status: string;
  siteId: string | null;
  endTime: Date | string;
  claimableFrom: Date | string | null;
  requiredLicenseLevel: number;
  headcount: number;
};

export type OfficerEligibilityContext = {
  effectiveLevel: number;
  heldTrainings: Set<string>;
};

export type ShiftEligibilityResult =
  | { eligible: true }
  | {
      eligible: false;
      reason: "assigned" | "not_upcoming" | "ended" | "not_released" | "license" | "full" | "training";
      missingTrainings?: string[];
    };

export function evaluateShiftEligibility(args: {
  shift: EligibilityShift;
  officer: OfficerEligibilityContext;
  assigned: boolean;
  assignedCount: number;
  requiredTrainings: string[];
  now?: Date;
}): ShiftEligibilityResult {
  const { shift, officer, assigned, assignedCount, requiredTrainings } = args;
  const nowMs = (args.now ?? new Date()).getTime();
  if (assigned) return { eligible: false, reason: "assigned" };
  if (shift.status !== "upcoming") return { eligible: false, reason: "not_upcoming" };
  if (new Date(shift.endTime).getTime() < nowMs) return { eligible: false, reason: "ended" };
  if (shift.claimableFrom && new Date(shift.claimableFrom).getTime() > nowMs) {
    return { eligible: false, reason: "not_released" };
  }
  if (officer.effectiveLevel < shift.requiredLicenseLevel) {
    return { eligible: false, reason: "license" };
  }
  if (assignedCount >= shift.headcount) return { eligible: false, reason: "full" };
  const missingTrainings = requiredTrainings.filter((slug) => !officer.heldTrainings.has(slug));
  if (missingTrainings.length > 0) {
    return { eligible: false, reason: "training", missingTrainings };
  }
  return { eligible: true };
}

export async function getEmployeeHeldTrainings(employeeId: string): Promise<Set<string>> {
  const rows = await db
    .select({ type: trainingCertificationsTable.type })
    .from(trainingCertificationsTable)
    .where(and(
      eq(trainingCertificationsTable.employeeId, employeeId),
      or(
        sql`${trainingCertificationsTable.expiryDate} IS NULL`,
        gte(trainingCertificationsTable.expiryDate, sql`current_date`),
      ),
    ));
  return new Set(rows.map((row) => row.type));
}

export async function getOfficerEligibilityContext(userId: string): Promise<OfficerEligibilityContext> {
  const [effectiveLevel, heldTrainings] = await Promise.all([
    getEffectiveLevel(userId),
    getEmployeeHeldTrainings(userId),
  ]);
  return { effectiveLevel, heldTrainings };
}

export async function getEligibleOfficerIds(shift: EligibilityShift): Promise<string[]> {
  const candidates = await db
    .select({ userId: usersTable.id, effectiveLevel: effectiveLevelSql })
    .from(usersTable)
    .leftJoin(licensesTable, eq(licensesTable.employeeId, usersTable.id))
    .where(and(
      inArray(usersTable.role, [...WORKER_ROLES]),
      eq(usersTable.status, "active"),
    ))
    .groupBy(usersTable.id);

  const [assignmentRows, siteRows] = await Promise.all([
    db
      .select({ employeeId: shiftAssignmentsTable.employeeId })
      .from(shiftAssignmentsTable)
      .where(eq(shiftAssignmentsTable.shiftId, shift.id)),
    shift.siteId
      ? db
          .select({ requiredTrainings: sitesTable.requiredTrainings })
          .from(sitesTable)
          .where(eq(sitesTable.id, shift.siteId))
          .limit(1)
      : Promise.resolve([]),
  ]);

  if (assignmentRows.length >= shift.headcount) return [];
  const assigned = new Set(assignmentRows.map((row) => row.employeeId));
  const requiredTrainings = Array.isArray(siteRows[0]?.requiredTrainings)
    ? siteRows[0].requiredTrainings
    : [];
  const candidateIds = candidates
    .filter((candidate) => candidate.effectiveLevel >= shift.requiredLicenseLevel && !assigned.has(candidate.userId))
    .map((candidate) => candidate.userId);
  if (candidateIds.length === 0 || requiredTrainings.length === 0) return candidateIds;

  const certRows = await db
    .select({
      employeeId: trainingCertificationsTable.employeeId,
      type: trainingCertificationsTable.type,
    })
    .from(trainingCertificationsTable)
    .where(and(
      inArray(trainingCertificationsTable.employeeId, candidateIds),
      or(
        sql`${trainingCertificationsTable.expiryDate} IS NULL`,
        gte(trainingCertificationsTable.expiryDate, sql`current_date`),
      ),
    ));
  const heldByOfficer = new Map<string, Set<string>>();
  for (const row of certRows) {
    const held = heldByOfficer.get(row.employeeId) ?? new Set<string>();
    held.add(row.type);
    heldByOfficer.set(row.employeeId, held);
  }
  return candidateIds.filter((id) =>
    requiredTrainings.every((slug) => heldByOfficer.get(id)?.has(slug)),
  );
}