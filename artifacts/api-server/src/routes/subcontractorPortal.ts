/**
 * Subcontractor self-service portal  /subcontractor-portal/*
 *
 * Lets an invited vendor contact log in, fill out their own company/contact
 * info, tax ID + W-9, Certificate(s) of Insurance, and banking details —
 * instead of an admin re-entering it every time. Mirrors the client-portal
 * pattern in clientPortal.ts (same invite/reactivate mechanics), with one
 * structural difference: a client's `clientsTable` row already exists when
 * the admin invites them, but a subcontractor's `subcontractorsTable` row
 * does NOT exist yet at invite time — the admin only supplies an email
 * address, and the vendor's own first profile submission creates the row
 * (see PUT /subcontractor-portal/profile below) and links it via
 * `users.subcontractorId`.
 *
 * Admin routes for sending/listing invites live here too: /admin/subcontractor-invites/*.
 * The audit log middleware already covers /admin/* paths automatically.
 *
 * Sensitive fields (bank account/routing number, tax ID): masked to last 4
 * characters on every read, never logged in the clear, and a masked value
 * echoed back on save is treated as "unchanged" rather than overwriting the
 * real stored value — see maskLast4 / isMaskedPlaceholder below.
 */
import { Router, type IRouter } from "express";
import { eq, desc } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import { z } from "zod/v4";
import {
  db,
  usersTable,
  subcontractorsTable,
  subcontractorCoisTable,
} from "@workspace/db";
import { requireAdmin, requireSubcontractor } from "../middlewares/auth";
import { sendEmail } from "../lib/email";
import { brand } from "../lib/brandConfig";

const router: IRouter = Router();

// ---------------------------------------------------------------------------
// Sensitive-field masking helpers
// ---------------------------------------------------------------------------

const MASK_PREFIX = "••••";

function maskLast4(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length <= 4) return MASK_PREFIX;
  return `${MASK_PREFIX}${trimmed.slice(-4)}`;
}

/** True when a submitted value is our own masked placeholder echoed back
 * unchanged by the client, rather than a real new value to save. */
function isMaskedPlaceholder(value: string | undefined): boolean {
  return typeof value === "string" && value.startsWith(MASK_PREFIX);
}

function maskProfile<T extends { taxId: string | null; bankAccountNumber: string | null; bankRoutingNumber: string | null }>(
  row: T,
): T {
  return {
    ...row,
    taxId: maskLast4(row.taxId),
    bankAccountNumber: maskLast4(row.bankAccountNumber),
    bankRoutingNumber: maskLast4(row.bankRoutingNumber),
  };
}

// ---------------------------------------------------------------------------
// Upload ownership helper (mirrors the /subcontractor-portal/storage/sign
// prefix check in routes/storage.ts — every document key this portal accepts
// must have come from this same user's own presigned-upload endpoint).
// ---------------------------------------------------------------------------

function assertOwnedUploadKeyOrThrow(key: string | undefined, userId: string): void {
  if (key === undefined) return;
  const ownedPrefix = `/objects/uploads/u/${userId}/`;
  if (key !== "" && !key.startsWith(ownedPrefix)) {
    throw new BadDocumentKeyError();
  }
}

class BadDocumentKeyError extends Error {
  constructor() {
    super("Document key must reference a file you uploaded yourself.");
  }
}

// ===========================================================================
// Self-service — GET /subcontractor-portal/me
// ===========================================================================

router.get("/subcontractor-portal/me", requireSubcontractor, async (req, res) => {
  const [user] = await db
    .select({
      id: usersTable.id,
      email: usersTable.email,
      firstName: usersTable.firstName,
      lastName: usersTable.lastName,
      subcontractorId: usersTable.subcontractorId,
    })
    .from(usersTable)
    .where(eq(usersTable.id, req.user!.userId))
    .limit(1);

  if (!user) {
    res.status(404).json({ error: "Not Found" });
    return;
  }

  if (!user.subcontractorId) {
    res.json({ user, profile: null, cois: [] });
    return;
  }

  const [profile] = await db
    .select()
    .from(subcontractorsTable)
    .where(eq(subcontractorsTable.id, user.subcontractorId))
    .limit(1);

  const cois = await db
    .select()
    .from(subcontractorCoisTable)
    .where(eq(subcontractorCoisTable.subcontractorId, user.subcontractorId))
    .orderBy(desc(subcontractorCoisTable.expiryDate));

  res.json({
    user,
    profile: profile ? maskProfile(profile) : null,
    cois,
  });
});

// ===========================================================================
// Self-service — PUT /subcontractor-portal/profile (upsert)
// ===========================================================================

const ProfileUpsertBody = z.object({
  companyName: z.string().trim().min(1, "Company name is required"),
  contactName: z.string().trim().optional(),
  contactEmail: z.string().trim().toLowerCase().email().optional().or(z.literal("")),
  contactPhone: z.string().trim().optional(),
  address: z.string().trim().optional(),
  taxId: z.string().trim().optional(),
  bankAccountName: z.string().trim().optional(),
  bankAccountNumber: z.string().trim().optional(),
  bankRoutingNumber: z.string().trim().optional(),
  directDepositConsent: z.boolean().optional(),
  w9DocKey: z.string().trim().optional(),
});

router.put("/subcontractor-portal/profile", requireSubcontractor, async (req, res): Promise<void> => {
  const parsed = ProfileUpsertBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Bad Request", issues: parsed.error.issues });
    return;
  }
  const body = parsed.data;

  try {
    assertOwnedUploadKeyOrThrow(body.w9DocKey, req.user!.userId);
  } catch (err) {
    if (err instanceof BadDocumentKeyError) {
      res.status(400).json({ error: "Bad Request", message: err.message });
      return;
    }
    throw err;
  }

  const [user] = await db
    .select({ id: usersTable.id, subcontractorId: usersTable.subcontractorId })
    .from(usersTable)
    .where(eq(usersTable.id, req.user!.userId))
    .limit(1);
  if (!user) {
    res.status(404).json({ error: "Not Found" });
    return;
  }

  // Sensitive fields: a masked placeholder echoed back means "leave as-is",
  // never overwrite the real stored value with the display mask.
  const values: Record<string, unknown> = {
    companyName: body.companyName,
    contactName: body.contactName ?? null,
    contactEmail: body.contactEmail || null,
    contactPhone: body.contactPhone ?? null,
    address: body.address ?? null,
    bankAccountName: body.bankAccountName ?? null,
    directDepositConsent: body.directDepositConsent ?? false,
  };
  if (!isMaskedPlaceholder(body.taxId)) values.taxId = body.taxId || null;
  if (!isMaskedPlaceholder(body.bankAccountNumber)) values.bankAccountNumber = body.bankAccountNumber || null;
  if (!isMaskedPlaceholder(body.bankRoutingNumber)) values.bankRoutingNumber = body.bankRoutingNumber || null;
  if (body.w9DocKey !== undefined) values.w9DocKey = body.w9DocKey || null;

  if (!user.subcontractorId) {
    // First-ever submission: create the vendor master record and link it.
    const [created] = await db.insert(subcontractorsTable).values(values as typeof subcontractorsTable.$inferInsert).returning();

    const userPatch: Record<string, unknown> = { subcontractorId: created.id };
    if (body.contactName) {
      const [first, ...rest] = body.contactName.trim().split(/\s+/);
      userPatch.firstName = first;
      userPatch.lastName = rest.join(" ") || first;
    }
    await db.update(usersTable).set(userPatch).where(eq(usersTable.id, user.id));

    res.status(201).json(maskProfile(created));
    return;
  }

  // Subsequent submissions: update ONLY the caller's own linked record —
  // scoping by user.subcontractorId (never a client-supplied id) keeps this
  // ownership-safe.
  const [updated] = await db
    .update(subcontractorsTable)
    .set(values)
    .where(eq(subcontractorsTable.id, user.subcontractorId))
    .returning();

  if (body.contactName) {
    const [first, ...rest] = body.contactName.trim().split(/\s+/);
    await db
      .update(usersTable)
      .set({ firstName: first, lastName: rest.join(" ") || first })
      .where(eq(usersTable.id, user.id));
  }

  res.json(maskProfile(updated));
});

// ===========================================================================
// Self-service — Certificates of Insurance
// ===========================================================================

async function requireOwnSubcontractorId(req: import("express").Request, res: import("express").Response): Promise<string | null> {
  const [user] = await db
    .select({ subcontractorId: usersTable.subcontractorId })
    .from(usersTable)
    .where(eq(usersTable.id, req.user!.userId))
    .limit(1);
  if (!user?.subcontractorId) {
    res.status(400).json({
      error: "Bad Request",
      message: "Complete your company profile before adding insurance documents.",
    });
    return null;
  }
  return user.subcontractorId;
}

router.get("/subcontractor-portal/cois", requireSubcontractor, async (req, res): Promise<void> => {
  const subcontractorId = await requireOwnSubcontractorId(req, res);
  if (!subcontractorId) return;

  const rows = await db
    .select()
    .from(subcontractorCoisTable)
    .where(eq(subcontractorCoisTable.subcontractorId, subcontractorId))
    .orderBy(desc(subcontractorCoisTable.expiryDate));
  res.json(rows);
});

const CoiUpsertBody = z.object({
  coverageType: z
    .enum(["general_liability", "workers_comp", "auto", "umbrella", "professional", "other"])
    .optional(),
  insurer: z.string().trim().optional(),
  policyNumber: z.string().trim().optional(),
  coverageAmount: z.union([z.string(), z.number()]).optional(),
  effectiveDate: z.string().trim().optional(),
  expiryDate: z.string().trim().min(1, "Expiry date is required"),
  documentKey: z.string().trim().optional(),
  notes: z.string().trim().optional(),
});

router.post("/subcontractor-portal/cois", requireSubcontractor, async (req, res): Promise<void> => {
  const subcontractorId = await requireOwnSubcontractorId(req, res);
  if (!subcontractorId) return;

  const parsed = CoiUpsertBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Bad Request", issues: parsed.error.issues });
    return;
  }
  const body = parsed.data;
  try {
    assertOwnedUploadKeyOrThrow(body.documentKey, req.user!.userId);
  } catch (err) {
    if (err instanceof BadDocumentKeyError) {
      res.status(400).json({ error: "Bad Request", message: err.message });
      return;
    }
    throw err;
  }

  const [created] = await db
    .insert(subcontractorCoisTable)
    .values({
      subcontractorId,
      coverageType: body.coverageType ?? "general_liability",
      insurer: body.insurer ?? null,
      policyNumber: body.policyNumber ?? null,
      coverageAmount: body.coverageAmount !== undefined ? String(body.coverageAmount) : null,
      effectiveDate: body.effectiveDate || null,
      expiryDate: body.expiryDate,
      documentKey: body.documentKey || null,
      notes: body.notes ?? null,
    })
    .returning();

  res.status(201).json(created);
});

router.put("/subcontractor-portal/cois/:id", requireSubcontractor, async (req, res): Promise<void> => {
  const id = String(req.params.id);
  const subcontractorId = await requireOwnSubcontractorId(req, res);
  if (!subcontractorId) return;

  const parsed = CoiUpsertBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Bad Request", issues: parsed.error.issues });
    return;
  }
  const body = parsed.data;
  try {
    assertOwnedUploadKeyOrThrow(body.documentKey, req.user!.userId);
  } catch (err) {
    if (err instanceof BadDocumentKeyError) {
      res.status(400).json({ error: "Bad Request", message: err.message });
      return;
    }
    throw err;
  }

  const [existing] = await db
    .select({ id: subcontractorCoisTable.id, subcontractorId: subcontractorCoisTable.subcontractorId })
    .from(subcontractorCoisTable)
    .where(eq(subcontractorCoisTable.id, id))
    .limit(1);
  // 404 (not 403) when the row belongs to someone else, so ownership can't be
  // probed by id.
  if (!existing || existing.subcontractorId !== subcontractorId) {
    res.status(404).json({ error: "Not Found" });
    return;
  }

  const [updated] = await db
    .update(subcontractorCoisTable)
    .set({
      coverageType: body.coverageType ?? "general_liability",
      insurer: body.insurer ?? null,
      policyNumber: body.policyNumber ?? null,
      coverageAmount: body.coverageAmount !== undefined ? String(body.coverageAmount) : null,
      effectiveDate: body.effectiveDate || null,
      expiryDate: body.expiryDate,
      documentKey: body.documentKey || null,
      notes: body.notes ?? null,
    })
    .where(eq(subcontractorCoisTable.id, id))
    .returning();

  res.json(updated);
});

router.delete("/subcontractor-portal/cois/:id", requireSubcontractor, async (req, res): Promise<void> => {
  const id = String(req.params.id);
  const subcontractorId = await requireOwnSubcontractorId(req, res);
  if (!subcontractorId) return;

  const [existing] = await db
    .select({ id: subcontractorCoisTable.id, subcontractorId: subcontractorCoisTable.subcontractorId })
    .from(subcontractorCoisTable)
    .where(eq(subcontractorCoisTable.id, id))
    .limit(1);
  if (!existing || existing.subcontractorId !== subcontractorId) {
    res.status(404).json({ error: "Not Found" });
    return;
  }

  await db.delete(subcontractorCoisTable).where(eq(subcontractorCoisTable.id, id));
  res.status(204).end();
});

// ===========================================================================
// ADMIN — subcontractor portal invites
// ===========================================================================

function getTrustedBaseUrl(): string | null {
  const explicit = process.env.APP_BASE_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/, "");
  const replitDomain = process.env.REPLIT_DOMAINS?.split(",")[0]?.trim();
  if (replitDomain) return `https://${replitDomain}`;
  return null;
}

function generateTempPassword(): string {
  const CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789!@#";
  const bytes = randomBytes(10);
  return Array.from(bytes)
    .map((b) => CHARS[b % CHARS.length])
    .join("");
}

async function sendSubcontractorInviteEmail(opts: {
  email: string;
  tempPassword: string;
  loginUrl: string | null;
}): Promise<boolean> {
  const { email, tempPassword, loginUrl } = opts;
  if (!loginUrl) return false;

  const companyName = brand.companyName;
  const subject = `Vendor portal access — ${companyName}`;
  const text = [
    `Hello,`,
    "",
    `You've been invited to set up your company profile in the ${companyName} vendor portal.`,
    "There you can enter your company & contact info, tax ID/W-9, certificate of insurance, and banking details yourself.",
    "",
    `Sign in at: ${loginUrl}`,
    `Email: ${email}`,
    `Temporary password: ${tempPassword}`,
    "",
    "You will be asked to change your password on first login.",
    "",
    companyName,
  ].join("\n");

  const html = `
    <div style="font-family:Georgia,serif;max-width:560px;margin:0 auto;color:#0c0a08">
      <div style="background:#0c0a08;padding:20px 24px;border-radius:4px 4px 0 0">
        <h2 style="color:#c9a04a;margin:0;font-size:18px">${companyName}</h2>
        <p style="color:#f0e4c0;margin:4px 0 0;font-size:12px;letter-spacing:0.05em">VENDOR PORTAL ACCESS</p>
      </div>
      <div style="border:1px solid #ddd;border-top:none;padding:24px;border-radius:0 0 4px 4px">
        <p>Hello,</p>
        <p>You've been invited to set up your company profile in the <strong>${companyName}</strong> vendor portal. There you can enter your company &amp; contact info, tax ID/W-9, certificate of insurance, and banking details yourself.</p>
        <div style="background:#f6f1e1;padding:14px 16px;border-left:3px solid #c9a04a;margin:18px 0;border-radius:4px">
          <div style="margin-bottom:6px"><strong>Sign-in URL:</strong> <a href="${loginUrl}" style="color:#0c0a08">${loginUrl}</a></div>
          <div style="margin-bottom:6px"><strong>Email:</strong> ${email}</div>
          <div><strong>Temporary password:</strong> <code style="background:#fff;padding:2px 6px;border-radius:3px;border:1px solid #ccc">${tempPassword}</code></div>
        </div>
        <p style="color:#555;font-size:13px">You will be asked to set a new password when you first sign in. If you did not expect this invitation, please disregard this email.</p>
        <hr style="border:none;border-top:2px solid #c9a04a;margin:20px 0"/>
        <p style="color:#0c0a08;font-weight:bold;margin:0;font-size:13px">${companyName}</p>
      </div>
    </div>
  `;

  return sendEmail({ to: email, subject, text, html });
}

router.get("/admin/subcontractor-invites", requireAdmin, async (_req, res) => {
  const rows = await db
    .select({
      id: usersTable.id,
      email: usersTable.email,
      status: usersTable.status,
      mustChangePassword: usersTable.mustChangePassword,
      invitedAt: usersTable.invitedAt,
      createdAt: usersTable.createdAt,
      lastLoginAt: usersTable.lastLoginAt,
      subcontractorId: usersTable.subcontractorId,
      companyName: subcontractorsTable.companyName,
    })
    .from(usersTable)
    .leftJoin(subcontractorsTable, eq(usersTable.subcontractorId, subcontractorsTable.id))
    .where(eq(usersTable.role, "subcontractor"))
    .orderBy(desc(usersTable.createdAt));
  res.json(rows);
});

const InviteSubcontractorBody = z.object({
  email: z.string().trim().toLowerCase().email("A valid email is required"),
});

router.post("/admin/subcontractor-invites", requireAdmin, async (req, res): Promise<void> => {
  const parsed = InviteSubcontractorBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Bad Request", issues: parsed.error.issues });
    return;
  }
  const { email } = parsed.data;

  const [existing] = await db.select().from(usersTable).where(eq(usersTable.email, email)).limit(1);

  const baseUrl = getTrustedBaseUrl();
  const loginUrl = baseUrl ? `${baseUrl}/admin-portal/subcontractor` : null;

  if (existing) {
    if (existing.role !== "subcontractor" || (existing.status !== "pending" && existing.status !== "inactive")) {
      res.status(409).json({
        error: "Conflict",
        message: "A user with this email already exists and cannot be re-provisioned as a vendor.",
      });
      return;
    }
    const tempPassword = generateTempPassword();
    const passwordHash = await bcrypt.hash(tempPassword, 10);
    const [updated] = await db
      .update(usersTable)
      .set({
        passwordHash,
        tempPasswordPlain: tempPassword,
        tempPasswordSetAt: new Date(),
        mustChangePassword: true,
        status: "active",
        invitedAt: new Date(),
        tokensValidAfter: new Date(),
      })
      .where(eq(usersTable.id, existing.id))
      .returning();

    const emailSent = await sendSubcontractorInviteEmail({ email: updated.email, tempPassword, loginUrl });

    res.status(200).json({ id: updated.id, email: updated.email, status: "reinvited", emailSent, loginUrl, tempPassword });
    return;
  }

  const tempPassword = generateTempPassword();
  const passwordHash = await bcrypt.hash(tempPassword, 10);
  const [user] = await db
    .insert(usersTable)
    .values({
      email,
      // Placeholder identity — the vendor's real contact name is captured
      // on their first profile submission and mirrored onto these columns
      // then (see PUT /subcontractor-portal/profile above).
      firstName: "New",
      lastName: "Vendor",
      passwordHash,
      role: "subcontractor",
      status: "active",
      mustChangePassword: true,
      tempPasswordPlain: tempPassword,
      tempPasswordSetAt: new Date(),
      invitedAt: new Date(),
    })
    .returning();

  const emailSent = await sendSubcontractorInviteEmail({ email: user.email, tempPassword, loginUrl });

  res.status(201).json({ id: user.id, email: user.email, status: "invited", emailSent, loginUrl, tempPassword });
});

export default router;
