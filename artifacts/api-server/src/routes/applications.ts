import { Router, type IRouter, type Request, type Response } from "express";
import { eq, desc, ilike, or, sql, and } from "drizzle-orm";
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
} from "@workspace/db";
import {
  SubmitApplicationBody,
  SubmitOnboardingBody,
  AdminApproveApplicationBody,
  AdminMarkApplicationUnderReviewBody,
  AdminRejectApplicationBody,
} from "@workspace/api-zod";
import { requireAdmin } from "../middlewares/auth";
import { sendPushToUsers } from "../lib/push";

const router: IRouter = Router();

const ONBOARDING_TOKEN_TTL_DAYS = 14;

function genToken(): string {
  return randomBytes(24).toString("base64url");
}
function genTempPassword(): string {
  // Friendly: 8 chars from base64url, all alphanumeric.
  return randomBytes(9).toString("base64url").replace(/[^A-Za-z0-9]/g, "x").slice(0, 10);
}

function buildOnboardingUrl(req: Request, token: string): string {
  const proto = (req.headers["x-forwarded-proto"] as string) || req.protocol || "https";
  const host = (req.headers["x-forwarded-host"] as string) || req.headers.host || "";
  const base = host ? `${proto}://${host}` : "";
  return `${base}/admin-portal/onboard/${token}`;
}

// ---- helpers ---------------------------------------------------------------

function rowToApplication(r: any) {
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

router.post("/applications", async (req, res): Promise<void> => {
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
  const conds: any[] = [];
  if (status) conds.push(eq(applicationsTable.status, status));
  if (search) {
    const like = `%${search}%`;
    conds.push(or(
      ilike(applicationsTable.firstName, like),
      ilike(applicationsTable.lastName, like),
      ilike(applicationsTable.email, like),
      ilike(applicationsTable.phone, like),
    ));
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
  const notes = parsed.success ? parsed.data.notes : undefined;
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
  const notes = parsed.success ? parsed.data.notes : undefined;
  const [row] = await db.update(applicationsTable).set({
    status: "rejected",
    reviewerNotes: notes ?? null,
    reviewedBy: req.user!.userId,
    reviewedAt: new Date(),
  }).where(eq(applicationsTable.id, req.params.id as string)).returning();
  if (!row) { res.status(404).json({ error: "Not Found", message: "Application not found" }); return; }
  res.json(rowToApplication(row));
});

router.post("/admin/applications/:id/approve", requireAdmin, async (req, res): Promise<void> => {
  const parsed = AdminApproveApplicationBody.safeParse(req.body ?? {});
  const notes = parsed.success ? parsed.data.notes : undefined;
  const appId = req.params.id as string;
  const reviewerId = req.user!.userId;

  const tempPassword = genTempPassword();
  const passwordHash = await bcrypt.hash(tempPassword, 10);
  const token = genToken();
  const expiresAt = new Date(Date.now() + ONBOARDING_TOKEN_TTL_DAYS * 86400_000);

  let result: { updated: any; userId: string } | { error: { status: number; body: any } };
  try {
    result = await db.transaction(async (tx) => {
      // Lock the application row to prevent concurrent approves.
      const [app] = await tx.execute(
        sql`SELECT * FROM ${applicationsTable} WHERE id = ${appId} FOR UPDATE`,
      ).then((r: any) => r.rows ?? r);
      if (!app) {
        return { error: { status: 404, body: { error: "Not Found", message: "Application not found" } } };
      }
      if (app.status === "approved" && app.created_employee_id) {
        return { error: { status: 409, body: { error: "Conflict", message: "Application already approved" } } };
      }

      const email = (app.email as string).toLowerCase();

      // Reuse user if email exists; reset their password to the new temp one
      // so the credentials we return are guaranteed valid.
      let userId: string;
      const [existingUser] = await tx.select().from(usersTable).where(eq(usersTable.email, email)).limit(1);
      if (existingUser) {
        userId = existingUser.id;
        await tx.update(usersTable).set({
          passwordHash,
          firstName: app.first_name as string,
          lastName: app.last_name as string,
          status: "pending",
        }).where(eq(usersTable.id, userId));
      } else {
        const [u] = await tx.insert(usersTable).values({
          email,
          passwordHash,
          firstName: app.first_name as string,
          lastName: app.last_name as string,
          role: "employee",
          status: "pending",
        }).returning();
        userId = u.id;
      }

      const [existingEmployee] = await tx.select().from(employeesTable).where(eq(employeesTable.userId, userId)).limit(1);
      if (!existingEmployee) {
        await tx.insert(employeesTable).values({
          userId,
          phone: app.phone as string,
          address: app.address as string,
        });
      }

      if (app.sia_license_number && app.sia_license_expiry) {
        await tx.insert(licensesTable).values({
          employeeId: userId,
          type: "SIA",
          level: (app.sia_license_level as number) ?? null,
          licenseNumber: app.sia_license_number as string,
          issuingAuthority: "SIA",
          expiryDate: app.sia_license_expiry as string,
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
        reviewerNotes: notes ?? (app.reviewer_notes as string | null) ?? null,
        reviewedBy: reviewerId,
        reviewedAt: new Date(),
        createdEmployeeId: userId,
      }).where(eq(applicationsTable.id, appId)).returning();

      return { updated, userId };
    });
  } catch (err) {
    req.log.error({ err }, "Approve transaction failed");
    res.status(500).json({ error: "Internal Server Error", message: "Approval failed" });
    return;
  }

  if ("error" in result) { res.status(result.error.status).json(result.error.body); return; }

  res.json({
    application: rowToApplication(result.updated),
    onboardingUrl: buildOnboardingUrl(req, token),
    onboardingToken: token,
    employeeId: result.userId,
    tempPassword,
    emailSent: false,
  });
});

// ---- Public: onboarding token resolve / submit ----------------------------

async function resolveValidToken(token: string) {
  const [t] = await db.select().from(onboardingTokensTable).where(eq(onboardingTokensTable.token, token)).limit(1);
  if (!t) return { error: "Invalid onboarding link" } as const;
  if (t.consumedAt) return { error: "This onboarding link has already been used" } as const;
  if (t.expiresAt.getTime() < Date.now()) return { error: "This onboarding link has expired" } as const;
  return { token: t } as const;
}

router.get("/onboarding/:token", async (req, res): Promise<void> => {
  const result = await resolveValidToken(req.params.token as string);
  if ("error" in result) { res.status(404).json({ error: "Not Found", message: result.error }); return; }
  const t = result.token;

  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, t.employeeId)).limit(1);
  if (!user) { res.status(404).json({ error: "Not Found", message: "Employee not found" }); return; }
  const [employee] = await db.select().from(employeesTable).where(eq(employeesTable.userId, user.id)).limit(1);

  let app: any = null;
  if (t.applicationId) {
    const [a] = await db.select().from(applicationsTable).where(eq(applicationsTable.id, t.applicationId)).limit(1);
    app = a ?? null;
  }
  const [existing] = await db.select().from(onboardingSubmissionsTable).where(eq(onboardingSubmissionsTable.employeeId, user.id)).limit(1);

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
  });
});

router.post("/onboarding/:token", async (req, res): Promise<void> => {
  const result = await resolveValidToken(req.params.token as string);
  if ("error" in result) { res.status(404).json({ error: "Not Found", message: result.error }); return; }
  const t = result.token;

  const parsed = SubmitOnboardingBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Bad Request", message: parsed.error.message });
    return;
  }
  const d = parsed.data;

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
    acknowledgements: d.acknowledgements,
  };

  // Upsert by employeeId
  const [existing] = await db.select().from(onboardingSubmissionsTable).where(eq(onboardingSubmissionsTable.employeeId, t.employeeId)).limit(1);
  let row;
  if (existing) {
    [row] = await db.update(onboardingSubmissionsTable).set(values).where(eq(onboardingSubmissionsTable.employeeId, t.employeeId)).returning();
  } else {
    [row] = await db.insert(onboardingSubmissionsTable).values(values).returning();
  }

  // Persist bank info onto employee for payroll convenience.
  await db.update(employeesTable).set({
    bankAccountName: d.bankAccountName,
    bankAccountNumber: d.bankAccountNumber,
    bankBsb: d.bankSortCode,
    emergencyContactName: d.emergencyContactName,
    emergencyContactPhone: d.emergencyContactPhone,
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
    acknowledgements: row.acknowledgements,
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
      acknowledgements: sub.acknowledgements as any,
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

  res.json({
    onboardingUrl: buildOnboardingUrl(req, token),
    onboardingToken: token,
    emailSent: false,
  });
});

export default router;
