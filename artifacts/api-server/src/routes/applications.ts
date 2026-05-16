import { Router, type IRouter, type Request, type Response } from "express";
import { eq, desc, ilike, or, sql, and, type SQL } from "drizzle-orm";
import bcrypt from "bcryptjs";
import { randomBytes } from "crypto";
import {
  db,
  applicationsTable,
  usersTable,
  employeesTable,
  licensesTable,
  onboardingTokensTable,
  onboardingSubmissionsTable,
  applicationAmendmentTokensTable,
  policiesTable,
} from "@workspace/db";
import { publicApplicationLimiter, tokenLookupLimiter } from "../middlewares/rateLimit";
import { ObjectStorageService } from "../lib/objectStorage";
import {
  SubmitApplicationBody,
  SubmitOnboardingBody,
  AdminApproveApplicationBody,
  AdminMarkApplicationUnderReviewBody,
  AdminRejectApplicationBody,
} from "@workspace/api-zod";
import { z } from "zod/v4";
import { requireAdmin } from "../middlewares/auth";
import { sendPushToUsers } from "../lib/push";
import { sendEmail, renderOnboardingEmail, renderResendOnboardingEmail, renderRejectionEmail, renderApplicationReceivedEmail, renderRequestInfoEmail } from "../lib/email";

const router: IRouter = Router();
const policyStorage = new ObjectStorageService();

const ONBOARDING_TOKEN_TTL_DAYS = 14;
const AMENDMENT_TOKEN_TTL_DAYS = 14;

// Whitelist of fields admins can request the applicant to update, mapped
// to (a) the application column the value lands on and (b) the type the
// applicant submits. File fields receive {objectPath, name} from the
// presigned-upload flow and we store objectPath on the *Key column.
type AmendmentFieldType = "text" | "textarea" | "number" | "date" | "file";
const AMENDABLE_FIELDS: Record<string, { column: string; type: AmendmentFieldType; label: string }> = {
  phone:               { column: "phone",                type: "text",     label: "Phone number" },
  address:             { column: "address",              type: "textarea", label: "Home address" },
  dateOfBirth:         { column: "dateOfBirth",          type: "date",     label: "Date of birth" },
  cityOfBirth:         { column: "cityOfBirth",          type: "text",     label: "City of birth" },
  stateOfBirth:        { column: "stateOfBirth",         type: "text",     label: "State of birth" },
  niNumber:            { column: "niNumber",             type: "text",     label: "SSN (last 4 digits)" },
  rightToWorkStatus:   { column: "rightToWorkStatus",    type: "text",     label: "Right-to-work status" },
  rightToWorkDoc:      { column: "rightToWorkDocKey",    type: "file",     label: "Right-to-work document" },
  siaLicenseNumber:    { column: "siaLicenseNumber",     type: "text",     label: "TX security license number" },
  siaLicenseLevel:     { column: "siaLicenseLevel",      type: "number",   label: "License level (2, 3, or 4)" },
  siaLicenseExpiry:    { column: "siaLicenseExpiry",     type: "date",     label: "License expiry date" },
  previousExperience:  { column: "previousExperience",   type: "textarea", label: "Previous security experience" },
  yearsExperience:     { column: "yearsExperience",      type: "number",   label: "Years of experience" },
  photo:               { column: "photoKey",             type: "file",     label: "Profile photo" },
  cv:                  { column: "cvKey",                type: "file",     label: "CV / résumé" },
};

const RequestInfoBody = z.object({
  requestedFields: z.array(z.string().refine((k) => k in AMENDABLE_FIELDS, "Unknown field")).min(1).max(20),
  note: z.string().trim().max(2000).optional(),
});

const FileUploadInput = z.object({
  objectPath: z.string().min(1),
  name: z.string().optional(),
});
const SubmitAmendmentBody = z.object({
  values: z.record(z.string(), z.union([z.string(), z.number(), FileUploadInput, z.null()])),
});

type ActivePolicyRow = {
  id: string; slug: string; label: string; version: number;
  fileKey: string; fileName: string | null;
};

/**
 * Returns every currently-active policy that has a document attached.
 * No signing — safe to use during validation (won't silently drop
 * policies if the storage backend hiccups).
 */
async function getActivePoliciesForValidation(): Promise<ActivePolicyRow[]> {
  const { seedPolicies } = await import("@workspace/db");
  await seedPolicies();
  const rows = await db.select().from(policiesTable);
  const active = rows
    .filter((r) => r.isActive && !!r.fileKey)
    .map((r) => ({
      id: r.id, slug: r.slug, label: r.label, version: r.version,
      fileKey: r.fileKey!, fileName: r.fileName,
    }));
  active.sort((a, b) => a.label.localeCompare(b.label));
  return active;
}

/**
 * For the public onboarding prefill — also signs each policy URL.
 * FAILS CLOSED: if any active policy can't be signed, throws so the
 * caller can surface a clear error instead of silently dropping it
 * (which would let the applicant skip the acknowledgement).
 */
async function getActivePoliciesForPrefill() {
  const active = await getActivePoliciesForValidation();
  const out: Array<ActivePolicyRow & { viewUrl: string }> = [];
  for (const r of active) {
    const viewUrl = await policyStorage.getSignedDownloadURL(r.fileKey);
    out.push({ ...r, viewUrl });
  }
  return out;
}

function genToken(): string {
  return randomBytes(24).toString("base64url");
}

// Random 12-char temp password — avoids visually ambiguous characters so it
// can be read back from a screen/email without confusion.
const TEMP_PW_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
function genTempPassword(): string {
  const buf = randomBytes(12);
  let out = "";
  for (let i = 0; i < 12; i++) {
    out += TEMP_PW_ALPHABET[buf[i]! % TEMP_PW_ALPHABET.length];
  }
  return out;
}

/**
 * Resolve a trusted base URL for outbound onboarding/amendment links.
 *
 * Mirrors the policy in `routes/auth.ts` (password reset) and
 * `routes/admin.ts` (admin-issued resets). We deliberately do NOT use
 * request headers (Host / X-Forwarded-*) — those are attacker-influenced
 * and would let a hostile caller send a victim a link pointing to an
 * attacker-controlled domain that captures the live single-use token.
 *
 * Resolution order:
 *   1. APP_BASE_URL — explicit operator-configured origin (preferred).
 *   2. REPLIT_DOMAINS — first comma-separated value, used over HTTPS.
 *
 * Returns null if neither is set; callers must then skip the email and
 * return `onboardingUrl: null` so the admin shares the link some other way.
 */
function getTrustedBaseUrl(): string | null {
  const explicit = process.env.APP_BASE_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/, "");
  const replitDomain = process.env.REPLIT_DOMAINS?.split(",")[0]?.trim();
  if (replitDomain) return `https://${replitDomain}`;
  return null;
}

function buildOnboardingUrl(token: string): string | null {
  const base = getTrustedBaseUrl();
  return base ? `${base}/admin-portal/onboard/${token}` : null;
}

// ---- helpers ---------------------------------------------------------------

type ApplicationRow = typeof applicationsTable.$inferSelect;

interface AcknowledgementEntry {
  type: string;
  accepted: boolean;
  signature?: string | null;
  timestamp?: string | null;
}

function rowToApplication(r: ApplicationRow) {
  return {
    ...r,
    dateOfBirth: r.dateOfBirth ?? null,
    siaLicenseExpiry: r.siaLicenseExpiry ?? null,
    references: r.references ?? null,
    trainingCertificateKeys: r.trainingCertificateKeys ?? null,
    availability: r.availability ?? null,
    reviewedAt: r.reviewedAt ? r.reviewedAt.toISOString() : null,
    createdAt: r.createdAt.toISOString(),
  };
}

// ---- Public: submit application -------------------------------------------

router.post("/applications", publicApplicationLimiter, async (req, res): Promise<void> => {
  const parsed = SubmitApplicationBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Bad Request", message: parsed.error.message });
    return;
  }
  const d = parsed.data;
  try {
    const [row] = await db.insert(applicationsTable).values({
      firstName: d.firstName,
      lastName: d.lastName,
      email: d.email.toLowerCase(),
      phone: d.phone,
      address: d.address,
      dateOfBirth: d.dateOfBirth ?? null,
      cityOfBirth: d.cityOfBirth ?? null,
      stateOfBirth: d.stateOfBirth ?? null,
      niNumber: d.niNumber ?? null,
      rightToWorkStatus: d.rightToWorkStatus ?? null,
      rightToWorkDocKey: d.rightToWorkDoc?.objectPath ?? null,
      siaLicenseNumber: d.siaLicenseNumber ?? null,
      siaLicenseLevel: d.siaLicenseLevel ?? null,
      siaLicenseExpiry: d.siaLicenseExpiry ?? null,
      previousExperience: d.previousExperience ?? null,
      yearsExperience: d.yearsExperience ?? null,
      references: d.references ?? null,
      photoKey: d.photo?.objectPath ?? null,
      cvKey: d.cv?.objectPath ?? null,
      trainingCertificateKeys: d.trainingCertificates?.map((f) => f.objectPath) ?? null,
      availability: d.availability ?? null,
    }).returning();
    try {
      const { subject, text, html } = renderApplicationReceivedEmail({ firstName: row.firstName });
      const sent = await sendEmail({ to: row.email, subject, text, html });
      if (!sent) {
        req.log.info({ applicationId: row.id, to: row.email }, "Application confirmation email not sent (SMTP not configured or send failed)");
      }
    } catch (mailErr) {
      req.log.error({ err: mailErr, applicationId: row.id }, "Failed to send application confirmation email");
    }
    res.status(201).json(rowToApplication(row));
  } catch (err) {
    req.log.error({ err }, "Failed to submit application");
    res.status(500).json({ error: "Internal Server Error", message: "Could not submit application" });
  }
});

// ---- Admin: list / get / review / reject / approve ------------------------

router.get("/admin/applications", requireAdmin, async (req, res): Promise<void> => {
  const status = (req.query.status as string | undefined)?.trim();
  const search = (req.query.search as string | undefined)?.trim();
  const conds: SQL[] = [];
  if (status) conds.push(eq(applicationsTable.status, status));
  if (search) {
    const like = `%${search}%`;
    const searchOr = or(
      ilike(applicationsTable.firstName, like),
      ilike(applicationsTable.lastName, like),
      ilike(applicationsTable.email, like),
      ilike(applicationsTable.phone, like),
    );
    if (searchOr) conds.push(searchOr);
  }
  const rows = await db
    .select()
    .from(applicationsTable)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(applicationsTable.createdAt));
  res.json(rows.map(rowToApplication));
});

router.get("/admin/applications/:id", requireAdmin, async (req, res): Promise<void> => {
  const [row] = await db.select().from(applicationsTable).where(eq(applicationsTable.id, req.params.id as string)).limit(1);
  if (!row) { res.status(404).json({ error: "Not Found", message: "Application not found" }); return; }
  res.json(rowToApplication(row));
});

router.post("/admin/applications/:id/review", requireAdmin, async (req, res): Promise<void> => {
  const parsed = AdminMarkApplicationUnderReviewBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Bad Request", message: parsed.error.message });
    return;
  }
  const notes = parsed.data.notes;
  const [row] = await db.update(applicationsTable).set({
    status: "under_review",
    reviewerNotes: notes ?? null,
    reviewedBy: req.user!.userId,
    reviewedAt: new Date(),
  }).where(eq(applicationsTable.id, req.params.id as string)).returning();
  if (!row) { res.status(404).json({ error: "Not Found", message: "Application not found" }); return; }
  res.json(rowToApplication(row));
});

router.post("/admin/applications/:id/reject", requireAdmin, async (req, res): Promise<void> => {
  const parsed = AdminRejectApplicationBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Bad Request", message: parsed.error.message });
    return;
  }
  const notes = parsed.data.notes;
  const [row] = await db.update(applicationsTable).set({
    status: "rejected",
    reviewerNotes: notes ?? null,
    reviewedBy: req.user!.userId,
    reviewedAt: new Date(),
  }).where(eq(applicationsTable.id, req.params.id as string)).returning();
  if (!row) { res.status(404).json({ error: "Not Found", message: "Application not found" }); return; }

  const application = rowToApplication(row);
  const emailMsg = renderRejectionEmail({
    firstName: application.firstName,
    reviewerNotes: application.reviewerNotes ?? null,
  });
  const emailSent = await sendEmail({
    to: application.email,
    subject: emailMsg.subject,
    text: emailMsg.text,
    html: emailMsg.html,
  });
  if (emailSent) {
    req.log.info({ applicationId: application.id, to: application.email }, "Rejection email sent");
  } else {
    req.log.info({ applicationId: application.id }, "Rejection email not sent — SMTP not configured");
  }

  res.json({ ...application, emailSent });
});

router.post("/admin/applications/:id/approve", requireAdmin, async (req, res): Promise<void> => {
  const parsed = AdminApproveApplicationBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Bad Request", message: parsed.error.message });
    return;
  }
  const notes = parsed.data.notes;
  const appId = req.params.id as string;
  const reviewerId = req.user!.userId;

  const token = genToken();
  const expiresAt = new Date(Date.now() + ONBOARDING_TOKEN_TTL_DAYS * 86400_000);

  type ErrorBody = { error: string; message: string };
  type ApproveResult =
    | { updated: ApplicationRow; userId: string; tempPasswordPlain: string }
    | { error: { status: number; body: ErrorBody } };

  let result: ApproveResult;
  try {
    result = await db.transaction(async (tx): Promise<ApproveResult> => {
      // Typed SELECT … FOR UPDATE prevents concurrent approves and gives us
      // a properly typed Application row (camelCase, correct nullability).
      const [app] = await tx
        .select()
        .from(applicationsTable)
        .where(eq(applicationsTable.id, appId))
        .for("update")
        .limit(1);
      if (!app) {
        return { error: { status: 404, body: { error: "Not Found", message: "Application not found" } } };
      }
      if (app.status === "approved" && app.createdEmployeeId) {
        return { error: { status: 409, body: { error: "Conflict", message: "Application already approved" } } };
      }

      // Generate a cryptographically random temp password — never derive it
      // from applicant data (e.g. SSN last-4) which may be known to others.
      // The plaintext is returned to the admin once and never stored; the
      // employee must change it on first login (mustChangePassword=true).
      const tempPasswordPlain = genTempPassword();
      const passwordHash = await bcrypt.hash(tempPasswordPlain, 10);

      const email = app.email.toLowerCase();

      // Reuse user if email exists — but ONLY if the existing account is an
      // employee in pending/inactive state. We refuse to mutate any other
      // account (admins, active employees) to prevent the HR pipeline from
      // overwriting credentials of unrelated users with the same email.
      let userId: string;
      const [existingUser] = await tx.select().from(usersTable).where(eq(usersTable.email, email)).limit(1);
      if (existingUser) {
        const reusable =
          existingUser.role === "employee" &&
          (existingUser.status === "pending" || existingUser.status === "inactive");
        if (!reusable) {
          return {
            error: {
              status: 409,
              body: {
                error: "Conflict",
                message:
                  "An account with this email already exists and cannot be re-provisioned via the HR flow. Resolve the existing account first.",
              },
            },
          };
        }
        userId = existingUser.id;
        await tx.update(usersTable).set({
          passwordHash,
          firstName: app.firstName,
          lastName: app.lastName,
          status: "pending",
          mustChangePassword: true,
          mustCompleteProfile: true,
        }).where(eq(usersTable.id, userId));
      } else {
        const [u] = await tx.insert(usersTable).values({
          email,
          passwordHash,
          firstName: app.firstName,
          lastName: app.lastName,
          role: "employee",
          status: "pending",
          mustChangePassword: true,
          mustCompleteProfile: true,
        }).returning();
        userId = u.id;
      }

      // Mirror every applicant field onto the employee row so admins see the
      // full applicant profile in the Employees grid (no need to dig back into
      // the application record). On re-approve we update the existing row.
      const employeeFromApp = {
        phone: app.phone,
        address: app.address,
        dateOfBirth: app.dateOfBirth ?? null,
        cityOfBirth: app.cityOfBirth ?? null,
        stateOfBirth: app.stateOfBirth ?? null,
        niNumber: app.niNumber ?? null,
        rightToWorkStatus: app.rightToWorkStatus ?? null,
        rightToWorkDocKey: app.rightToWorkDocKey ?? null,
        siaLicenseNumber: app.siaLicenseNumber ?? null,
        siaLicenseLevel: app.siaLicenseLevel ?? null,
        siaLicenseExpiry: app.siaLicenseExpiry ?? null,
        previousExperience: app.previousExperience ?? null,
        yearsExperience: app.yearsExperience ?? null,
        references: app.references ?? null,
        photoKey: app.photoKey ?? null,
        cvKey: app.cvKey ?? null,
        trainingCertificateKeys: app.trainingCertificateKeys ?? null,
        availability: app.availability ?? null,
        applicationId: app.id,
      };
      const [existingEmployee] = await tx.select().from(employeesTable).where(eq(employeesTable.userId, userId)).limit(1);
      if (!existingEmployee) {
        await tx.insert(employeesTable).values({ userId, ...employeeFromApp });
      } else {
        await tx.update(employeesTable).set(employeeFromApp).where(eq(employeesTable.userId, userId));
      }

      // Create a licence row whenever the applicant declared *any* TX
      // licence info (number, level, or expiry). Previously we required
      // BOTH number and expiry, which silently dropped applications that
      // only filled in the level — leaving the officer with
      // maxLicenseLevel=null on mobile and unable to claim shifts.
      // Missing fields are stored as a 30-day placeholder so admin sees
      // an "expiring soon" row to verify and complete.
      const hasAnyLicenceInfo =
        !!app.siaLicenseNumber || app.siaLicenseLevel != null || !!app.siaLicenseExpiry;
      if (hasAnyLicenceInfo) {
        const placeholderExpiry = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
          .toISOString().slice(0, 10);
        await tx.insert(licensesTable).values({
          employeeId: userId,
          type: "SIA",
          level: app.siaLicenseLevel ?? null,
          licenseNumber: app.siaLicenseNumber || "PENDING-VERIFICATION",
          issuingAuthority: "SIA",
          expiryDate: app.siaLicenseExpiry || placeholderExpiry,
        });
      }

      await tx.update(onboardingTokensTable)
        .set({ consumedAt: new Date() })
        .where(and(eq(onboardingTokensTable.employeeId, userId), sql`${onboardingTokensTable.consumedAt} IS NULL`));

      await tx.insert(onboardingTokensTable).values({
        token, employeeId: userId, applicationId: appId, expiresAt,
      });

      const [updated] = await tx.update(applicationsTable).set({
        status: "approved",
        reviewerNotes: notes ?? app.reviewerNotes ?? null,
        reviewedBy: reviewerId,
        reviewedAt: new Date(),
        createdEmployeeId: userId,
      }).where(eq(applicationsTable.id, appId)).returning();

      return { updated, userId, tempPasswordPlain };
    });
  } catch (err) {
    req.log.error({ err }, "Approve transaction failed");
    res.status(500).json({ error: "Internal Server Error", message: "Approval failed" });
    return;
  }

  if ("error" in result) { res.status(result.error.status).json(result.error.body); return; }

  const onboardingUrl = buildOnboardingUrl(token);
  const app = result.updated;
  let emailSent = false;
  if (onboardingUrl) {
    const emailMsg = renderOnboardingEmail({
      firstName: app.firstName,
      onboardingUrl,
      email: app.email,
    });
    emailSent = await sendEmail({
      to: app.email,
      subject: emailMsg.subject,
      text: emailMsg.text,
      html: emailMsg.html,
    });
    if (emailSent) {
      req.log.info({ employeeId: result.userId, to: app.email }, "Onboarding approval email sent");
    } else {
      req.log.info({ employeeId: result.userId }, "Onboarding email not sent — admin must share link manually");
    }
  } else {
    req.log.error({ employeeId: result.userId }, "Approve: APP_BASE_URL/REPLIT_DOMAINS unset; cannot build onboarding link");
  }

  res.json({
    application: rowToApplication(result.updated),
    onboardingUrl,
    onboardingToken: token,
    employeeId: result.userId,
    tempPassword: result.tempPasswordPlain,
    emailSent,
  });
});

// ---- Admin: request more info from applicant -----------------------------

function buildAmendUrl(token: string): string | null {
  const base = getTrustedBaseUrl();
  return base ? `${base}/admin-portal/amend/${token}` : null;
}

router.post("/admin/applications/:id/request-info", requireAdmin, async (req, res): Promise<void> => {
  const parsed = RequestInfoBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Bad Request", message: parsed.error.message });
    return;
  }
  const appId = req.params.id as string;
  const [app] = await db.select().from(applicationsTable).where(eq(applicationsTable.id, appId)).limit(1);
  if (!app) { res.status(404).json({ error: "Not Found", message: "Application not found" }); return; }
  if (app.status === "approved" || app.status === "rejected") {
    res.status(409).json({ error: "Conflict", message: `Cannot request info on an ${app.status} application.` });
    return;
  }

  // Invalidate any prior unconsumed amendment tokens for this application
  // so an old link can't be used after a fresh request goes out.
  await db.update(applicationAmendmentTokensTable)
    .set({ consumedAt: new Date() })
    .where(and(
      eq(applicationAmendmentTokensTable.applicationId, appId),
      sql`${applicationAmendmentTokensTable.consumedAt} IS NULL`,
    ));

  const token = genToken();
  const expiresAt = new Date(Date.now() + AMENDMENT_TOKEN_TTL_DAYS * 86400_000);
  await db.insert(applicationAmendmentTokensTable).values({
    token,
    applicationId: appId,
    requestedFields: parsed.data.requestedFields,
    note: parsed.data.note ?? null,
    requestedBy: req.user!.userId,
    expiresAt,
  });

  const [updatedApp] = await db.update(applicationsTable).set({
    status: "info_requested",
    reviewedBy: req.user!.userId,
    reviewedAt: new Date(),
  }).where(eq(applicationsTable.id, appId)).returning();

  const amendUrl = buildAmendUrl(token);
  const fieldLabels = parsed.data.requestedFields.map((k) => AMENDABLE_FIELDS[k].label);
  let emailSent = false;
  if (amendUrl) {
    const emailMsg = renderRequestInfoEmail({
      firstName: app.firstName,
      amendUrl,
      note: parsed.data.note ?? null,
      fieldLabels,
    });
    emailSent = await sendEmail({
      to: app.email,
      subject: emailMsg.subject,
      text: emailMsg.text,
      html: emailMsg.html,
    });
  } else {
    req.log.error({ applicationId: appId }, "request-info: APP_BASE_URL/REPLIT_DOMAINS unset; cannot build amend link");
  }
  if (emailSent) {
    req.log.info({ applicationId: appId, to: app.email }, "Request-info email sent");
  } else {
    req.log.info({ applicationId: appId }, "Request-info email not sent — admin must share link manually");
  }

  res.json({
    application: rowToApplication(updatedApp),
    amendUrl,
    amendmentToken: token,
    requestedFields: parsed.data.requestedFields,
    fieldLabels,
    expiresAt: expiresAt.toISOString(),
    emailSent,
  });
});

// ---- Public: amendment token resolve / submit ----------------------------

async function resolveValidAmendmentToken(token: string) {
  const [t] = await db.select().from(applicationAmendmentTokensTable)
    .where(eq(applicationAmendmentTokensTable.token, token)).limit(1);
  if (!t) return { error: "Invalid link" } as const;
  if (t.consumedAt) return { error: "This link has already been used" } as const;
  if (t.expiresAt.getTime() < Date.now()) return { error: "This link has expired" } as const;
  return { token: t } as const;
}

router.get("/applications/amend/:token", tokenLookupLimiter, async (req, res): Promise<void> => {
  const result = await resolveValidAmendmentToken(req.params.token as string);
  if ("error" in result) { res.status(404).json({ error: "Not Found", message: result.error }); return; }
  const t = result.token;
  const [app] = await db.select().from(applicationsTable).where(eq(applicationsTable.id, t.applicationId)).limit(1);
  if (!app) { res.status(404).json({ error: "Not Found", message: "Application not found" }); return; }

  const requestedFields = (t.requestedFields as string[]).filter((k) => k in AMENDABLE_FIELDS);
  const fields = requestedFields.map((k) => {
    const def = AMENDABLE_FIELDS[k];
    const current = (app as Record<string, unknown>)[def.column];
    return {
      key: k,
      label: def.label,
      type: def.type,
      currentValue: current == null ? null : String(current),
    };
  });

  res.json({
    firstName: app.firstName,
    lastName: app.lastName,
    email: app.email,
    note: t.note ?? null,
    expiresAt: t.expiresAt.toISOString(),
    fields,
  });
});

router.post("/applications/amend/:token", tokenLookupLimiter, async (req, res): Promise<void> => {
  const result = await resolveValidAmendmentToken(req.params.token as string);
  if ("error" in result) { res.status(404).json({ error: "Not Found", message: result.error }); return; }
  const t = result.token;

  const parsed = SubmitAmendmentBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Bad Request", message: parsed.error.message });
    return;
  }
  const requestedFields = (t.requestedFields as string[]).filter((k) => k in AMENDABLE_FIELDS);
  const requestedSet = new Set(requestedFields);

  const updates: Record<string, string | number | null> = {};
  const provided = new Set<string>();
  for (const [k, raw] of Object.entries(parsed.data.values)) {
    if (!requestedSet.has(k)) continue;
    const def = AMENDABLE_FIELDS[k];
    if (raw === null || raw === undefined || raw === "") {
      // Treat empty as "not provided" — we require every requested field.
      continue;
    }
    provided.add(k);
    if (def.type === "file") {
      if (typeof raw !== "object" || raw === null || !("objectPath" in raw)) {
        res.status(400).json({ error: "Bad Request", message: `Field "${k}" must be an uploaded file.` });
        return;
      }
      updates[def.column] = (raw as { objectPath: string }).objectPath;
    } else if (def.type === "number") {
      const n = typeof raw === "number" ? raw : Number(raw);
      if (!Number.isFinite(n)) {
        res.status(400).json({ error: "Bad Request", message: `Field "${k}" must be a number.` });
        return;
      }
      updates[def.column] = n;
    } else {
      if (typeof raw !== "string") {
        res.status(400).json({ error: "Bad Request", message: `Field "${k}" must be text.` });
        return;
      }
      updates[def.column] = raw;
    }
  }

  // Enforce: every requested field must be provided. The whole point of this
  // flow is for the applicant to complete the missing details.
  const missing = requestedFields.filter((k) => !provided.has(k));
  if (missing.length > 0) {
    res.status(400).json({
      error: "Bad Request",
      message: `Please complete every requested item: ${missing.map((k) => AMENDABLE_FIELDS[k].label).join(", ")}.`,
      missingFields: missing,
    });
    return;
  }

  // Atomically consume token + apply updates so a re-submit can't double-apply.
  const updated = await db.transaction(async (tx) => {
    const [tokenRow] = await tx.select().from(applicationAmendmentTokensTable)
      .where(eq(applicationAmendmentTokensTable.id, t.id)).for("update").limit(1);
    if (!tokenRow || tokenRow.consumedAt) return null;
    if (Object.keys(updates).length > 0) {
      await tx.update(applicationsTable).set(updates).where(eq(applicationsTable.id, t.applicationId));
    }
    // Bump back to under_review so admin sees it ready to re-evaluate.
    await tx.update(applicationsTable).set({ status: "under_review" })
      .where(eq(applicationsTable.id, t.applicationId));
    await tx.update(applicationAmendmentTokensTable).set({ consumedAt: new Date() })
      .where(eq(applicationAmendmentTokensTable.id, t.id));
    const [row] = await tx.select().from(applicationsTable).where(eq(applicationsTable.id, t.applicationId)).limit(1);
    return row;
  });
  if (!updated) {
    res.status(409).json({ error: "Conflict", message: "This link has already been used." });
    return;
  }

  // Notify admins
  const admins = await db.select({ id: usersTable.id }).from(usersTable).where(eq(usersTable.role, "admin"));
  if (admins.length) {
    sendPushToUsers(admins.map((a) => a.id), {
      title: "📝 Application updated",
      body: `${updated.firstName} ${updated.lastName} submitted the missing details.`,
    }).catch(() => {});
  }

  res.json({ ok: true, applicationId: updated.id });
});

// ---- Public: onboarding token resolve / submit ----------------------------

async function resolveValidToken(token: string) {
  const [t] = await db.select().from(onboardingTokensTable).where(eq(onboardingTokensTable.token, token)).limit(1);
  if (!t) return { error: "Invalid onboarding link" } as const;
  if (t.consumedAt) return { error: "This onboarding link has already been used" } as const;
  if (t.expiresAt.getTime() < Date.now()) return { error: "This onboarding link has expired" } as const;
  return { token: t } as const;
}

router.get("/onboarding/:token", tokenLookupLimiter, async (req, res): Promise<void> => {
  const result = await resolveValidToken(req.params.token as string);
  if ("error" in result) { res.status(404).json({ error: "Not Found", message: result.error }); return; }
  const t = result.token;

  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, t.employeeId)).limit(1);
  if (!user) { res.status(404).json({ error: "Not Found", message: "Employee not found" }); return; }
  const [employee] = await db.select().from(employeesTable).where(eq(employeesTable.userId, user.id)).limit(1);

  let app: ApplicationRow | null = null;
  if (t.applicationId) {
    const [a] = await db.select().from(applicationsTable).where(eq(applicationsTable.id, t.applicationId)).limit(1);
    app = a ?? null;
  }
  const [existing] = await db.select().from(onboardingSubmissionsTable).where(eq(onboardingSubmissionsTable.employeeId, user.id)).limit(1);
  let policies;
  try {
    policies = await getActivePoliciesForPrefill();
  } catch (err) {
    req.log.error({ err }, "Failed to sign policy URLs for onboarding prefill");
    res.status(503).json({
      error: "Service Unavailable",
      message: "Policy documents are temporarily unavailable. Please try again in a moment or contact HR.",
    });
    return;
  }

  res.json({
    employeeId: user.id,
    firstName: user.firstName,
    lastName: user.lastName,
    email: user.email,
    phone: employee?.phone ?? app?.phone ?? null,
    address: employee?.address ?? app?.address ?? null,
    niNumber: app?.niNumber ?? null,
    siaLicenseNumber: app?.siaLicenseNumber ?? null,
    siaLicenseLevel: app?.siaLicenseLevel ?? null,
    existing: !!existing,
    policies,
  });
});

router.post("/onboarding/:token", tokenLookupLimiter, async (req, res): Promise<void> => {
  const result = await resolveValidToken(req.params.token as string);
  if ("error" in result) { res.status(404).json({ error: "Not Found", message: result.error }); return; }
  const t = result.token;

  const parsed = SubmitOnboardingBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Bad Request", message: parsed.error.message });
    return;
  }
  const d = parsed.data;

  // Fail-closed validation: every currently-active policy MUST appear
  // in the submission, AND each ack must reference (by policyId) a row
  // that is still currently active for that slug. This prevents two
  // bypasses: (a) a transient storage error silently dropping a
  // required acknowledgement, and (b) the applicant signing version N
  // while admin replaces it with version N+1 between view and submit.
  const activePolicies = await getActivePoliciesForValidation();
  const activeById = new Map(activePolicies.map((p) => [p.id, p]));
  const ackBySlug = new Map(d.acknowledgements.map((a) => [a.type, a]));

  for (const p of activePolicies) {
    const ack = ackBySlug.get(p.slug);
    if (!ack || !ack.accepted || !ack.signature?.trim()) {
      res.status(400).json({
        error: "Bad Request",
        message: `Missing acknowledgement for policy: ${p.label}`,
      });
      return;
    }
    if (!ack.policyId || ack.policyId !== p.id) {
      res.status(409).json({
        error: "Conflict",
        message: `The "${p.label}" policy was updated while you were filling out the form. Please refresh the page and review the new version.`,
      });
      return;
    }
  }

  // Snapshot from the EXACT row the applicant signed (looked up by the
  // submitted policyId), not by re-resolving the slug at submit time.
  const enrichedAcks = d.acknowledgements.map((a) => {
    const p = a.policyId ? activeById.get(a.policyId) ?? null : null;
    return {
      type: a.type,
      accepted: a.accepted,
      signature: a.signature,
      timestamp: a.timestamp,
      policyId: p?.id ?? a.policyId ?? null,
      policyVersion: p?.version ?? a.policyVersion ?? null,
      policyFileKey: p?.fileKey ?? null,
      policyLabel: p?.label ?? null,
    };
  });

  const values = {
    employeeId: t.employeeId,
    bankSortCode: d.bankSortCode,
    bankAccountNumber: d.bankAccountNumber,
    bankAccountName: d.bankAccountName,
    niNumberConfirmed: d.niNumberConfirmed ?? null,
    taxCode: d.taxCode ?? null,
    p45DocKey: d.p45Doc?.objectPath ?? null,
    emergencyContactName: d.emergencyContactName,
    emergencyContactRelationship: d.emergencyContactRelationship ?? null,
    emergencyContactPhone: d.emergencyContactPhone,
    uniformShirt: d.uniformShirt ?? null,
    uniformTrousers: d.uniformTrousers ?? null,
    uniformJacket: d.uniformJacket ?? null,
    uniformBoots: d.uniformBoots ?? null,
    siaLicenseDocKey: d.siaLicenseDoc?.objectPath ?? null,
    passportDocKey: d.passportDoc?.objectPath ?? null,
    directDepositConsent: d.directDepositConsent,
    directDepositSignature: d.directDepositSignature,
    acknowledgements: enrichedAcks,
  };

  // Upsert by employeeId
  const [existing] = await db.select().from(onboardingSubmissionsTable).where(eq(onboardingSubmissionsTable.employeeId, t.employeeId)).limit(1);
  let row;
  if (existing) {
    [row] = await db.update(onboardingSubmissionsTable).set(values).where(eq(onboardingSubmissionsTable.employeeId, t.employeeId)).returning();
  } else {
    [row] = await db.insert(onboardingSubmissionsTable).values(values).returning();
  }

  // Mirror every onboarding-submission field onto the employee row so admins
  // see the full profile in the Employees grid without opening the onboarding
  // detail dialog.
  await db.update(employeesTable).set({
    bankAccountName: d.bankAccountName,
    bankAccountNumber: d.bankAccountNumber,
    bankBsb: d.bankSortCode,
    niNumber: d.niNumberConfirmed ?? null,
    taxCode: d.taxCode ?? null,
    payStubDocKey: d.p45Doc?.objectPath ?? null,
    emergencyContactName: d.emergencyContactName,
    emergencyContactRelationship: d.emergencyContactRelationship ?? null,
    emergencyContactPhone: d.emergencyContactPhone,
    uniformShirt: d.uniformShirt ?? null,
    uniformTrousers: d.uniformTrousers ?? null,
    uniformJacket: d.uniformJacket ?? null,
    uniformBoots: d.uniformBoots ?? null,
    licenseDocKey: d.siaLicenseDoc?.objectPath ?? null,
    passportDocKey: d.passportDoc?.objectPath ?? null,
    directDepositConsent: d.directDepositConsent ?? null,
    directDepositSignature: d.directDepositSignature ?? null,
    acknowledgements: enrichedAcks,
    onboardingSubmissionId: row.id,
  }).where(eq(employeesTable.userId, t.employeeId));

  // Activate user, mark token consumed
  await db.update(usersTable).set({ status: "active" }).where(eq(usersTable.id, t.employeeId));
  await db.update(onboardingTokensTable).set({ consumedAt: new Date() }).where(eq(onboardingTokensTable.id, t.id));

  // Notify any admins via push
  const admins = await db.select({ id: usersTable.id }).from(usersTable).where(eq(usersTable.role, "admin"));
  if (admins.length) {
    sendPushToUsers(admins.map((a) => a.id), {
      title: "✅ Onboarding completed",
      body: `Onboarding submitted by employee.`,
    }).catch(() => {});
  }

  res.json({
    id: row.id,
    employeeId: row.employeeId,
    bankSortCode: row.bankSortCode,
    bankAccountNumber: row.bankAccountNumber,
    bankAccountName: row.bankAccountName,
    niNumberConfirmed: row.niNumberConfirmed,
    taxCode: row.taxCode,
    p45DocKey: row.p45DocKey,
    emergencyContactName: row.emergencyContactName,
    emergencyContactRelationship: row.emergencyContactRelationship,
    emergencyContactPhone: row.emergencyContactPhone,
    uniformShirt: row.uniformShirt,
    uniformTrousers: row.uniformTrousers,
    uniformJacket: row.uniformJacket,
    uniformBoots: row.uniformBoots,
    siaLicenseDocKey: row.siaLicenseDocKey,
    passportDocKey: row.passportDocKey,
    directDepositConsent: row.directDepositConsent,
    directDepositSignature: row.directDepositSignature,
    acknowledgements: (row.acknowledgements as AcknowledgementEntry[] | null) ?? null,
    submittedAt: row.submittedAt.toISOString(),
  });
});

// ---- Admin: onboarding list / detail / resend -----------------------------

router.get("/admin/onboarding", requireAdmin, async (req, res): Promise<void> => {
  const status = (req.query.status as string | undefined)?.trim();

  // Onboarding records = any user that has either a submission or a token.
  const subs = await db.select().from(onboardingSubmissionsTable);
  const tokens = await db.select().from(onboardingTokensTable);

  const employeeIds = new Set<string>([
    ...subs.map((s) => s.employeeId),
    ...tokens.map((t) => t.employeeId),
  ]);
  if (employeeIds.size === 0) { res.json([]); return; }

  const users = await db.select().from(usersTable).where(sql`${usersTable.id} IN (${sql.join([...employeeIds].map((id) => sql`${id}`), sql`, `)})`);

  const subByEmp = new Map(subs.map((s) => [s.employeeId, s]));
  const tokensByEmp = new Map<string, typeof tokens>();
  for (const t of tokens) {
    const arr = tokensByEmp.get(t.employeeId) ?? [];
    arr.push(t);
    tokensByEmp.set(t.employeeId, arr);
  }

  const items = users.map((u) => {
    const sub = subByEmp.get(u.id);
    const userTokens = (tokensByEmp.get(u.id) ?? []).slice().sort((a, b) => b.expiresAt.getTime() - a.expiresAt.getTime());
    const latestToken = userTokens[0];
    return {
      employeeId: u.id,
      firstName: u.firstName,
      lastName: u.lastName,
      email: u.email,
      status: sub ? "completed" : "pending",
      tokenExpiresAt: latestToken ? latestToken.expiresAt.toISOString() : null,
      submittedAt: sub ? sub.submittedAt.toISOString() : null,
      applicationId: latestToken?.applicationId ?? null,
    };
  }).filter((i) => !status || i.status === status);

  items.sort((a, b) => (a.status === b.status ? 0 : a.status === "pending" ? -1 : 1));
  res.json(items);
});

router.get("/admin/onboarding/:employeeId", requireAdmin, async (req, res): Promise<void> => {
  const employeeId = req.params.employeeId as string;
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, employeeId)).limit(1);
  if (!user) { res.status(404).json({ error: "Not Found", message: "Employee not found" }); return; }
  const [sub] = await db.select().from(onboardingSubmissionsTable).where(eq(onboardingSubmissionsTable.employeeId, employeeId)).limit(1);
  const tokens = await db.select().from(onboardingTokensTable).where(eq(onboardingTokensTable.employeeId, employeeId)).orderBy(desc(onboardingTokensTable.expiresAt));
  const latestToken = tokens[0];

  res.json({
    employeeId: user.id,
    firstName: user.firstName,
    lastName: user.lastName,
    email: user.email,
    status: sub ? "completed" : "pending",
    submission: sub ? {
      id: sub.id,
      employeeId: sub.employeeId,
      bankSortCode: sub.bankSortCode,
      bankAccountNumber: sub.bankAccountNumber,
      bankAccountName: sub.bankAccountName,
      niNumberConfirmed: sub.niNumberConfirmed,
      taxCode: sub.taxCode,
      p45DocKey: sub.p45DocKey,
      emergencyContactName: sub.emergencyContactName,
      emergencyContactRelationship: sub.emergencyContactRelationship,
      emergencyContactPhone: sub.emergencyContactPhone,
      uniformShirt: sub.uniformShirt,
      uniformTrousers: sub.uniformTrousers,
      uniformJacket: sub.uniformJacket,
      uniformBoots: sub.uniformBoots,
      siaLicenseDocKey: sub.siaLicenseDocKey,
      passportDocKey: sub.passportDocKey,
      directDepositConsent: sub.directDepositConsent,
      directDepositSignature: sub.directDepositSignature,
      acknowledgements: (sub.acknowledgements as AcknowledgementEntry[] | null) ?? null,
      submittedAt: sub.submittedAt.toISOString(),
    } : null,
    tokenExpiresAt: latestToken ? latestToken.expiresAt.toISOString() : null,
    applicationId: latestToken?.applicationId ?? null,
  });
});

router.post("/admin/onboarding/:employeeId/resend", requireAdmin, async (req, res): Promise<void> => {
  const employeeId = req.params.employeeId as string;
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, employeeId)).limit(1);
  if (!user) { res.status(404).json({ error: "Not Found", message: "Employee not found" }); return; }

  await db.update(onboardingTokensTable)
    .set({ consumedAt: new Date() })
    .where(and(eq(onboardingTokensTable.employeeId, employeeId), sql`${onboardingTokensTable.consumedAt} IS NULL`));

  const token = genToken();
  const expiresAt = new Date(Date.now() + ONBOARDING_TOKEN_TTL_DAYS * 86400_000);
  // Carry over the most recent applicationId if present.
  const [prev] = await db.select().from(onboardingTokensTable).where(eq(onboardingTokensTable.employeeId, employeeId)).orderBy(desc(onboardingTokensTable.createdAt)).limit(1);
  await db.insert(onboardingTokensTable).values({
    token, employeeId, applicationId: prev?.applicationId ?? null, expiresAt,
  });

  const onboardingUrl = buildOnboardingUrl(token);
  // Resend doesn't reset password; we don't include credentials in the email
  // (we don't have the plaintext anymore). Just the link.
  let emailSent = false;
  if (onboardingUrl) {
    const emailMsg = renderResendOnboardingEmail({
      firstName: user.firstName,
      onboardingUrl,
    });
    emailSent = await sendEmail({
      to: user.email,
      subject: emailMsg.subject,
      text: emailMsg.text,
      html: emailMsg.html,
    });
    if (emailSent) {
      req.log.info({ employeeId, to: user.email }, "Resent onboarding email sent");
    } else {
      req.log.info({ employeeId }, "Resent onboarding email not sent — admin must share link manually");
    }
  } else {
    req.log.error({ employeeId }, "Resend onboarding: APP_BASE_URL/REPLIT_DOMAINS unset; cannot build link");
  }

  res.json({
    onboardingUrl,
    onboardingToken: token,
    emailSent,
  });
});

export default router;
