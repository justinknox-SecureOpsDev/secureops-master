import { Router, type IRouter } from "express";
import { eq, and, sql, isNotNull, inArray } from "drizzle-orm";
import { db, usersTable, employeesTable } from "@workspace/db";
import { requireAdmin } from "../middlewares/auth";
import { WORKER_ROLES } from "../lib/eligibility";
import { logger } from "../lib/logger";

const router: IRouter = Router();

// ---------------------------------------------------------------------------
// Employee profile completeness report
//
// Returns every active internal employee with per-field completeness flags so
// admins can identify gaps (missing bank info, no login, unacknowledged
// policies, etc.) and action them in bulk.
//
// Security: admin-only. Finance data (bank account number) is never returned;
// only the boolean flag is sent.
// ---------------------------------------------------------------------------

export type CompletenessRow = {
  userId: string;
  employeeId: string;
  firstName: string | null;
  lastName: string | null;
  email: string;
  status: string;
  position: string | null;
  // flags
  hasDirectDeposit: boolean;
  hasPolicyAcknowledgements: boolean;
  hasEverLoggedIn: boolean;
  hasPhoto: boolean;
  hasEmergencyContact: boolean;
  hasRightToWork: boolean;
  hasPhone: boolean;
  hasHourlyRate: boolean;
  // timestamps
  lastLoginAt: string | null;
  invitedAt: string | null;
  createdAt: string | null;
};

router.get(
  "/admin/reports/employee-completeness",
  requireAdmin,
  async (req, res) => {
    try {
      const rows = await db
        .select({
          userId: usersTable.id,
          employeeId: employeesTable.id,
          firstName: usersTable.firstName,
          lastName: usersTable.lastName,
          email: usersTable.email,
          status: usersTable.status,
          position: employeesTable.position,
          // direct deposit — consent flag + bank account number must both be set
          hasDirectDeposit: sql<boolean>`
            CASE WHEN ${employeesTable.directDepositConsent} = true
                  AND ${employeesTable.bankAccountNumber} IS NOT NULL
                  AND ${employeesTable.bankAccountNumber} <> ''
              THEN true ELSE false END`.as("has_direct_deposit"),
          // policy acknowledgements — jsonb array with at least one entry
          hasPolicyAcknowledgements: sql<boolean>`
            CASE WHEN ${employeesTable.acknowledgements} IS NOT NULL
                  AND jsonb_typeof(${employeesTable.acknowledgements}) = 'array'
                  AND jsonb_array_length(${employeesTable.acknowledgements}) > 0
              THEN true ELSE false END`.as("has_policy_acknowledgements"),
          // login history
          hasEverLoggedIn: sql<boolean>`
            CASE WHEN ${usersTable.firstLoginAt} IS NOT NULL
              THEN true ELSE false END`.as("has_ever_logged_in"),
          // profile photo
          hasPhoto: sql<boolean>`
            CASE WHEN ${employeesTable.photoKey} IS NOT NULL
                  AND ${employeesTable.photoKey} <> ''
              THEN true ELSE false END`.as("has_photo"),
          // emergency contact — both name and phone required
          hasEmergencyContact: sql<boolean>`
            CASE WHEN ${employeesTable.emergencyContactName} IS NOT NULL
                  AND ${employeesTable.emergencyContactName} <> ''
                  AND ${employeesTable.emergencyContactPhone} IS NOT NULL
                  AND ${employeesTable.emergencyContactPhone} <> ''
              THEN true ELSE false END`.as("has_emergency_contact"),
          // right-to-work status
          hasRightToWork: sql<boolean>`
            CASE WHEN ${employeesTable.rightToWorkStatus} IS NOT NULL
                  AND ${employeesTable.rightToWorkStatus} <> ''
              THEN true ELSE false END`.as("has_right_to_work"),
          // account phone number (for SMS and contact)
          hasPhone: sql<boolean>`
            CASE WHEN ${usersTable.phoneNumber} IS NOT NULL
                  AND ${usersTable.phoneNumber} <> ''
              THEN true ELSE false END`.as("has_phone"),
          // hourly rate (needed for payroll)
          hasHourlyRate: sql<boolean>`
            CASE WHEN ${employeesTable.hourlyRate} IS NOT NULL
                  AND ${employeesTable.hourlyRate}::numeric > 0
              THEN true ELSE false END`.as("has_hourly_rate"),
          lastLoginAt: usersTable.lastLoginAt,
          invitedAt: usersTable.invitedAt,
          createdAt: usersTable.createdAt,
        })
        .from(usersTable)
        .innerJoin(employeesTable, eq(employeesTable.userId, usersTable.id))
        .where(
          and(
            inArray(usersTable.role, WORKER_ROLES as unknown as string[]),
            // exclude inactive/pending accounts from this report
          ),
        )
        .orderBy(usersTable.lastName, usersTable.firstName);

      const out: CompletenessRow[] = rows.map((r) => ({
        userId: r.userId,
        employeeId: r.employeeId,
        firstName: r.firstName,
        lastName: r.lastName,
        email: r.email,
        status: r.status,
        position: r.position,
        hasDirectDeposit: Boolean(r.hasDirectDeposit),
        hasPolicyAcknowledgements: Boolean(r.hasPolicyAcknowledgements),
        hasEverLoggedIn: Boolean(r.hasEverLoggedIn),
        hasPhoto: Boolean(r.hasPhoto),
        hasEmergencyContact: Boolean(r.hasEmergencyContact),
        hasRightToWork: Boolean(r.hasRightToWork),
        hasPhone: Boolean(r.hasPhone),
        hasHourlyRate: Boolean(r.hasHourlyRate),
        lastLoginAt: r.lastLoginAt ? (r.lastLoginAt as Date).toISOString() : null,
        invitedAt: r.invitedAt ? (r.invitedAt as Date).toISOString() : null,
        createdAt: r.createdAt ? (r.createdAt as Date).toISOString() : null,
      }));

      res.json(out);
    } catch (err) {
      logger.error({ err }, "employee-completeness report failed");
      res.status(500).json({ error: "Failed to generate report" });
    }
  },
);

export default router;
