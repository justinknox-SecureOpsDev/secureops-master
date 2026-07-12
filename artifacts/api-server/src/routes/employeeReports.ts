import { Router, type IRouter } from "express";
import { eq, and, sql, inArray } from "drizzle-orm";
import { db, usersTable, employeesTable } from "@workspace/db";
import { requireAdmin } from "../middlewares/auth";
import { WORKER_ROLES } from "../lib/eligibility";
import { logger } from "../lib/logger";
import { sendEmail, renderProfileCompletenessEmail } from "../lib/email";

const router: IRouter = Router();

// ---------------------------------------------------------------------------
// Employee profile completeness report
//
// Returns every internal employee with per-field completeness flags so
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

// Human-readable labels for each completeness check, shared between the GET
// list and the POST notify endpoint so the email body is consistent.
const FIELD_LABELS: Record<string, string> = {
  hasDirectDeposit: "Direct deposit (bank account + consent)",
  hasPolicyAcknowledgements: "Policy acknowledgements",
  hasEverLoggedIn: "First login (never logged in)",
  hasPhoto: "Profile photo",
  hasEmergencyContact: "Emergency contact (name + phone)",
  hasRightToWork: "Right-to-work status",
  hasPhone: "Phone number",
  hasHourlyRate: "Hourly rate",
};

// Shared Drizzle select shape so the GET and notify paths stay in sync.
function completenessSelect() {
  return {
    userId: usersTable.id,
    employeeId: employeesTable.id,
    firstName: usersTable.firstName,
    lastName: usersTable.lastName,
    email: usersTable.email,
    status: usersTable.status,
    position: employeesTable.position,
    hasDirectDeposit: sql<boolean>`
      CASE WHEN ${employeesTable.directDepositConsent} = true
            AND ${employeesTable.bankAccountNumber} IS NOT NULL
            AND ${employeesTable.bankAccountNumber} <> ''
        THEN true ELSE false END`.as("has_direct_deposit"),
    hasPolicyAcknowledgements: sql<boolean>`
      CASE WHEN ${employeesTable.acknowledgements} IS NOT NULL
            AND jsonb_typeof(${employeesTable.acknowledgements}) = 'array'
            AND jsonb_array_length(${employeesTable.acknowledgements}) > 0
        THEN true ELSE false END`.as("has_policy_acknowledgements"),
    hasEverLoggedIn: sql<boolean>`
      CASE WHEN ${usersTable.firstLoginAt} IS NOT NULL
        THEN true ELSE false END`.as("has_ever_logged_in"),
    hasPhoto: sql<boolean>`
      CASE WHEN ${employeesTable.photoKey} IS NOT NULL
            AND ${employeesTable.photoKey} <> ''
        THEN true ELSE false END`.as("has_photo"),
    hasEmergencyContact: sql<boolean>`
      CASE WHEN ${employeesTable.emergencyContactName} IS NOT NULL
            AND ${employeesTable.emergencyContactName} <> ''
            AND ${employeesTable.emergencyContactPhone} IS NOT NULL
            AND ${employeesTable.emergencyContactPhone} <> ''
        THEN true ELSE false END`.as("has_emergency_contact"),
    hasRightToWork: sql<boolean>`
      CASE WHEN ${employeesTable.rightToWorkStatus} IS NOT NULL
            AND ${employeesTable.rightToWorkStatus} <> ''
        THEN true ELSE false END`.as("has_right_to_work"),
    hasPhone: sql<boolean>`
      CASE WHEN ${usersTable.phoneNumber} IS NOT NULL
            AND ${usersTable.phoneNumber} <> ''
        THEN true ELSE false END`.as("has_phone"),
    hasHourlyRate: sql<boolean>`
      CASE WHEN ${employeesTable.hourlyRate} IS NOT NULL
            AND ${employeesTable.hourlyRate}::numeric > 0
        THEN true ELSE false END`.as("has_hourly_rate"),
    lastLoginAt: usersTable.lastLoginAt,
    invitedAt: usersTable.invitedAt,
    createdAt: usersTable.createdAt,
  };
}

function toDto(r: ReturnType<typeof completenessSelect> extends Record<string, unknown> ? any : any): CompletenessRow {
  return {
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
  };
}

function missingFieldLabels(row: CompletenessRow): string[] {
  return Object.entries(FIELD_LABELS)
    .filter(([key]) => !row[key as keyof CompletenessRow])
    .map(([, label]) => label);
}

function buildLoginUrl(): string | null {
  const base =
    process.env.APP_BASE_URL ||
    process.env.REPLIT_DOMAINS?.split(",")[0]?.trim();
  if (!base) return null;
  const origin = base.startsWith("http") ? base : `https://${base}`;
  return `${origin.replace(/\/$/, "")}/`;
}

// ---------------------------------------------------------------------------
// GET /admin/reports/employee-completeness
// ---------------------------------------------------------------------------
router.get(
  "/admin/reports/employee-completeness",
  requireAdmin,
  async (req, res) => {
    try {
      const rows = await db
        .select(completenessSelect())
        .from(usersTable)
        .innerJoin(employeesTable, eq(employeesTable.userId, usersTable.id))
        .where(inArray(usersTable.role, WORKER_ROLES as unknown as string[]))
        .orderBy(usersTable.lastName, usersTable.firstName);

      res.json(rows.map(toDto));
    } catch (err) {
      logger.error({ err }, "employee-completeness report failed");
      res.status(500).json({ error: "Failed to generate report" });
    }
  },
);

// ---------------------------------------------------------------------------
// POST /admin/reports/employee-completeness/:userId/notify
//
// Sends the employee an email listing their missing profile fields.
// Always re-computes the missing list from the DB — never trusts the client.
// Returns { emailSent, missingFields, to, loginUrl }.
// ---------------------------------------------------------------------------
router.post(
  "/admin/reports/employee-completeness/:userId/notify",
  requireAdmin,
  async (req, res) => {
    const userId = req.params.userId as string;
    try {
      const rows = await db
        .select(completenessSelect())
        .from(usersTable)
        .innerJoin(employeesTable, eq(employeesTable.userId, usersTable.id))
        .where(
          and(
            eq(usersTable.id, userId),
            inArray(usersTable.role, WORKER_ROLES as unknown as string[]),
          ),
        )
        .limit(1);

      if (rows.length === 0) {
        res.status(404).json({ error: "Not Found", message: "Employee not found" });
        return;
      }

      const row = toDto(rows[0]);
      const missing = missingFieldLabels(row);

      if (missing.length === 0) {
        res.json({ emailSent: false, missingFields: [], to: row.email, skipped: true, reason: "Profile already complete" });
        return;
      }

      const loginUrl = buildLoginUrl();
      let emailSent = false;
      if (loginUrl) {
        const msg = renderProfileCompletenessEmail({
          firstName: row.firstName ?? "there",
          missingFieldLabels: missing,
          loginUrl,
        });
        emailSent = await sendEmail({ to: row.email, subject: msg.subject, text: msg.text, html: msg.html });
        if (emailSent) {
          req.log.info({ userId, to: row.email, missingCount: missing.length }, "Profile completeness reminder sent");
        } else {
          req.log.info({ userId }, "Profile completeness reminder not sent — email not configured or suppressed in dev");
        }
      } else {
        req.log.warn({ userId }, "notify: APP_BASE_URL/REPLIT_DOMAINS unset; skipping email");
      }

      res.json({ emailSent, missingFields: missing, to: row.email, loginUrl });
    } catch (err) {
      logger.error({ err, userId }, "employee-completeness notify failed");
      res.status(500).json({ error: "Failed to send notification" });
    }
  },
);

export default router;
