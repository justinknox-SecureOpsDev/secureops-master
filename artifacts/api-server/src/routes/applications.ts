import { Router, type IRouter, type Request, type Response } from "express";
import { eq, desc, ilike, or, sql, and, isNull, type SQL } from "drizzle-orm";
import { sitesTable } from "@workspace/db";
import { haversineMiles } from "../lib/geofence";
import { geocodeUsAddress } from "../lib/geocode";
import bcrypt from "bcryptjs";
import { randomBytes } from "crypto";
import {
  db,
  applicationsTable,
  applicationDraftsTable,
  usersTable,
  employeesTable,
  licensesTable,
  onboardingTokensTable,
  onboardingSubmissionsTable,
  applicationAmendmentTokensTable,
  policiesTable,
} from "@workspace/db";
import { publicApplicationLimiter, tokenLookupLimiter, applicationDraftIpLimiter, applicationDraftEmailLimiter } from "../middlewares/rateLimit";
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
import { sendEmail, sendEmailDetailed, renderOnboardingEmail, renderResendOnboardingEmail, renderRejectionEmail, renderApplicationReceivedEmail, renderRequestInfoEmail, renderApplicationDraftResumeEmail } from "../lib/email";
import { sendSmsToPhoneNumber } from "../lib/sms";
import { normalizePhoneToE164 } from "../lib/phone";

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
  address:             { column: "address",              type: "textarea", label: "Street address" },
  city:                { column: "city",                 type: "text",     label: "City" },
  state:               { column: "state",                type: "text",     label: "State" },
  zip:                 { column: "zip",                  type: "text",     label: "ZIP code" },
  dateOfBirth:         { column: "dateOfBirth",          type: "date",     label: "Date of birth" },
  cityOfBirth:         { column: "cityOfBirth",          type: "text",     label: "City of birth" },
  stateOfBirth:        { column: "stateOfBirth",         type: "text",     label: "State of birth" },
  niNumber:            { column: "niNumber",             type: "text",     label: "SSN (last 4 digits)" },
  rightToWorkStatus:   { column: "rightToWorkStatus",    type: "text",     label: "Right-to-work status" },
  rightToWorkDoc:      { column: "rightToWorkDocKey",    type: "file",     label: "Right-to-work document" },
  i9Doc:               { column: "i9DocKey",             type: "file",     label: "Completed Form I-9" },
  ssnCardDoc:          { column: "ssnCardDocKey",        type: "file",     label: "Social Security card" },
  idDocType:           { column: "idDocType",            type: "text",     label: "Photo ID type (drivers_license or passport)" },
  idDoc:               { column: "idDocKey",             type: "file",     label: "Photo ID (DL or passport)" },
  siaLicenseNumber:    { column: "siaLicenseNumber",     type: "text",     label: "TX security license number" },
  siaLicenseLevel:     { column: "siaLicenseLevel",      type: "number",   label: "License level (2, 3, or 4)" },
  siaLicenseExpiry:    { column: "siaLicenseExpiry",     type: "date",     label: "License expiry date" },
  previousExperience:  { column: "previousExperience",   type: "textarea", label: "Previous security experience" },
  yearsExperience:     { column: "yearsExperience",      type: "number",   label: "Years of experience" },
  photo:               { column: "photoKey",             type: "file",     label: "Profile photo" },
  cv:                  { column: "cvKey",                type: "file",     label: "Resume" },
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

/**
 * Validate that an object path submitted by an applicant/onboarding user was
 * minted by the anonymous application-upload endpoint rather than by an
 * authenticated user's upload session.
 *
 * Authenticated uploads land at /objects/uploads/u/<userId>/... — a
 * user-scoped prefix that encodes the uploader's identity. Anonymous
 * application uploads land at /objects/uploads/<uuid> — no /u/ segment.
 *
 * Accepting a user-scoped path in an anonymous flow would allow an attacker
 * to plant another user's private document key into an application record,
 * where it could later be copied to an employee row and redeemed for a
 * signed download URL.
 */
function isApplicationObjectPath(path: string): boolean {
  // Require the path to be under the anonymous-upload namespace only.
  // The application-upload endpoint mints paths at /objects/uploads/<uuid>.
  // User-scoped authenticated uploads land at /objects/uploads/u/<userId>/...
  // and must never be accepted from anonymous/token-based flows.
  // Any other /objects/... namespace is also rejected to prevent out-of-band
  // object references from being planted into application records.
  if (!path.startsWith("/objects/uploads/")) return false;
  if (path.startsWith("/objects/uploads/u/")) return false;
  return true;
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

function rowToApplication(r: ApplicationRow, distanceMiles: number | null = null) {
  return {
    ...r,
    city: r.city ?? null,
    state: r.state ?? null,
    zip: r.zip ?? null,
    // numeric() columns come back as strings; expose them as numbers (or null) to the API
    locationLat: r.locationLat != null ? Number(r.locationLat) : null,
    locationLng: r.locationLng != null ? Number(r.locationLng) : null,
    distanceMiles,
    dateOfBirth: r.dateOfBirth ?? null,
    siaLicenseExpiry: r.siaLicenseExpiry ?? null,
    references: r.references ?? null,
    trainingCertificateKeys: r.trainingCertificateKeys ?? null,
    availability: r.availability ?? null,
    reviewedAt: r.reviewedAt ? r.reviewedAt.toISOString() : null,
    onboardingEmailStatus: r.onboardingEmailStatus ?? null,
    onboardingEmailMessageId: r.onboardingEmailMessageId ?? null,
    onboardingEmailResponse: r.onboardingEmailResponse ?? null,
    onboardingEmailError: r.onboardingEmailError ?? null,
    onboardingEmailSentAt: r.onboardingEmailSentAt ? r.onboardingEmailSentAt.toISOString() : null,
    onboardingEmailAttemptedAt: r.onboardingEmailAttemptedAt ? r.onboardingEmailAttemptedAt.toISOString() : null,
    createdAt: r.createdAt.toISOString(),
  };
}

/**
 * Fire-and-forget background geocode. Writes location_lat/lng to the row
 * if Census returns a match. Errors are logged but never propagated —
 * geocoding is best-effort, applicants never wait on it.
 */
function geocodeApplicationInBackground(
  appId: string,
  parts: { street: string; city: string | null; state: string | null; zip: string | null },
  log: { error: (o: object, m?: string) => void; info: (o: object, m?: string) => void },
): void {
  // Kill switch — applicant home address is PII. Geocoding sends street/city/
  // state/zip to the US Census Bureau geocoder. Operator must explicitly opt
  // in via env so the data flow is documented and auditable. When disabled,
  // city filter still works (text-only); only the distance filter is unfed.
  if (process.env.GEOCODING_ENABLED !== "true") return;
  void (async () => {
    try {
      const result = await geocodeUsAddress({
        street: parts.street,
        city: parts.city,
        state: parts.state,
        zip: parts.zip,
      });
      if (!result) {
        log.info({ applicationId: appId }, "Geocode: no match for application address");
        return;
      }
      await db.update(applicationsTable).set({
        locationLat: String(result.lat),
        locationLng: String(result.lng),
      }).where(eq(applicationsTable.id, appId));
    } catch (err) {
      log.error({ err, applicationId: appId }, "Background geocode failed");
    }
  })();
}

// ---- Public: submit application -------------------------------------------

// Human-readable labels for every field the Apply form posts. Used to turn
// Zod's terse "Required" / "Invalid input" messages into something the
// applicant can actually act on ("Date of birth is required.").
const APPLICATION_FIELD_LABELS: Record<string, string> = {
  firstName: "First name",
  lastName: "Last name",
  email: "Email",
  phone: "Phone number",
  address: "Street address",
  city: "City",
  state: "State",
  zip: "ZIP code",
  dateOfBirth: "Date of birth",
  cityOfBirth: "City of birth",
  stateOfBirth: "State of birth",
  niNumber: "SSN (last 4)",
  i9Doc: "Completed Form I-9",
  ssnCardDoc: "Social Security card",
  idDocType: "Photo ID type",
  idDoc: "Photo ID",
  siaLicenseNumber: "TX security license number",
  siaLicenseLevel: "License level",
  siaLicenseExpiry: "License expiry date",
  previousExperience: "Previous security experience",
  yearsExperience: "Years of experience",
  photo: "Head & shoulders photo",
  cv: "Resume",
  trainingCertificates: "Training certificates",
  availability: "Availability",
};

type ApplicationFieldError = { field: string; message: string };

/**
 * Map a Zod issue path (e.g. ["references", 0, "phone"]) to the form field
 * token the Apply page uses (e.g. "ref:0:phone"). Returns null when the
 * path falls outside the known submit surface so we can fall back to the
 * raw Zod message instead of inventing a field that won't highlight.
 */
function applicationFieldFromPath(path: ReadonlyArray<PropertyKey>): { field: string; label: string } | null {
  if (path.length === 0) return null;
  const head = path[0];
  if (head === "references") {
    const idx = typeof path[1] === "number" ? path[1] : 0;
    const sub = typeof path[2] === "string" ? path[2] : "name";
    const subLabel = sub === "phone" ? "phone" : sub === "relationship" ? "relationship" : sub === "email" ? "email" : "name";
    return { field: `ref:${idx}:${sub}`, label: `Reference #${idx + 1} ${subLabel}` };
  }
  if (typeof head !== "string") return null;
  // File fields like i9Doc/photo can fail at the parent or on a child key
  // (objectPath). Always collapse to the parent — that's what the form
  // shows the inline error against.
  if (head in APPLICATION_FIELD_LABELS) {
    return { field: head, label: APPLICATION_FIELD_LABELS[head]! };
  }
  return null;
}

function applicationFieldErrorMessage(issue: z.core.$ZodIssue, label: string): string {
  // Cover the common shapes a missing/empty value produces in zod/v4.
  if (issue.code === "invalid_type") return `${label} is required.`;
  if (issue.code === "too_small") {
    const ts = issue as z.core.$ZodIssueTooSmall;
    if (ts.origin === "array") return `Please add at least one ${label.toLowerCase()}.`;
    if (ts.origin === "string") return `${label} is required.`;
  }
  if (issue.code === "invalid_value" || issue.code === "invalid_format") {
    return `${label} is not valid.`;
  }
  // Fallback — still readable, just less branded.
  return `${label}: ${issue.message}`;
}

function toApplicationFieldErrors(error: { issues: ReadonlyArray<z.core.$ZodIssue> }): ApplicationFieldError[] {
  const seen = new Set<string>();
  const out: ApplicationFieldError[] = [];
  for (const issue of error.issues) {
    const mapped = applicationFieldFromPath(issue.path);
    if (!mapped) continue;
    if (seen.has(mapped.field)) continue;
    seen.add(mapped.field);
    out.push({ field: mapped.field, message: applicationFieldErrorMessage(issue, mapped.label) });
  }
  return out;
}

function sendApplicationValidationError(res: Response, fieldErrors: ApplicationFieldError[], fallbackMessage: string): void {
  const message = fieldErrors[0]?.message ?? fallbackMessage;
  res.status(400).json({ error: "Bad Request", message, fieldErrors });
}

router.post("/applications", publicApplicationLimiter, async (req, res): Promise<void> => {
  const parsed = SubmitApplicationBody.safeParse(req.body);
  if (!parsed.success) {
    const fieldErrors = toApplicationFieldErrors({ issues: parsed.error.issues as unknown as ReadonlyArray<z.core.$ZodIssue> });
    sendApplicationValidationError(res, fieldErrors, parsed.error.message);
    return;
  }
  const d = parsed.data;
  // Normalize phone to E.164 so the SMS fallback on approve actually
  // reaches US applicants who typed "(214) 555-1234" etc. Default country
  // is US/+1 when no country code is present.
  const normalizedPhone = normalizePhoneToE164(d.phone);
  if (!normalizedPhone) {
    const message = "Phone number is invalid. Please enter a valid US phone number (e.g. (214) 555-1234) or include the country code (e.g. +44 20 1234 5678).";
    sendApplicationValidationError(res, [{ field: "phone", message }], message);
    return;
  }
  // Normalize each reference contact phone (if provided) so future
  // reference-check SMS/voice flows can text them without per-row
  // string-massaging. Empty/missing phone is allowed (references aren't
  // strictly required to have a phone), but a non-empty unparseable
  // value is rejected with a clear error pointing at the row.
  let normalizedReferences: Array<Record<string, unknown>> | null = null;
  if (Array.isArray(d.references)) {
    normalizedReferences = [];
    for (let i = 0; i < d.references.length; i++) {
      const ref = { ...(d.references[i] as Record<string, unknown>) };
      const rawPhone = ref.phone;
      if (typeof rawPhone === "string" && rawPhone.trim()) {
        const norm = normalizePhoneToE164(rawPhone);
        if (!norm) {
          const message = `Reference #${i + 1} phone number is invalid. Please enter a valid US phone number (e.g. (214) 555-1234) or include the country code (e.g. +44 20 1234 5678).`;
          sendApplicationValidationError(res, [{ field: `ref:${i}:phone`, message }], message);
          return;
        }
        ref.phone = norm;
      }
      normalizedReferences.push(ref);
    }
  }
  // Reject any submitted document path that was minted by an authenticated
  // upload session (i.e. starts with /objects/uploads/u/). Only anonymous
  // application-upload paths are accepted in this unauthenticated flow.
  const applicationFilePaths: (string | undefined)[] = [
    d.i9Doc?.objectPath,
    d.ssnCardDoc?.objectPath,
    d.idDoc?.objectPath,
    d.rightToWorkDoc?.objectPath,
    d.photo?.objectPath,
    d.cv?.objectPath,
    ...(d.trainingCertificates?.map((f) => f.objectPath) ?? []),
  ];
  for (const p of applicationFilePaths) {
    if (p !== undefined && !isApplicationObjectPath(p)) {
      res.status(400).json({ error: "Bad Request", message: "Invalid document path." });
      return;
    }
  }
  try {
    const [row] = await db.insert(applicationsTable).values({
      firstName: d.firstName,
      lastName: d.lastName,
      email: d.email.toLowerCase(),
      phone: normalizedPhone,
      address: d.address,
      city: d.city ?? null,
      state: d.state ?? null,
      zip: d.zip ?? null,
      dateOfBirth: d.dateOfBirth ?? null,
      cityOfBirth: d.cityOfBirth ?? null,
      stateOfBirth: d.stateOfBirth ?? null,
      niNumber: d.niNumber ?? null,
      rightToWorkStatus: d.rightToWorkStatus ?? null,
      rightToWorkDocKey: d.rightToWorkDoc?.objectPath ?? null,
      i9DocKey: d.i9Doc.objectPath,
      ssnCardDocKey: d.ssnCardDoc.objectPath,
      idDocType: d.idDocType,
      idDocKey: d.idDoc.objectPath,
      siaLicenseNumber: d.siaLicenseNumber,
      siaLicenseLevel: d.siaLicenseLevel,
      siaLicenseExpiry: d.siaLicenseExpiry,
      previousExperience: d.previousExperience,
      yearsExperience: d.yearsExperience,
      references: normalizedReferences ?? d.references,
      photoKey: d.photo.objectPath,
      cvKey: d.cv.objectPath,
      trainingCertificateKeys: d.trainingCertificates.map((f) => f.objectPath),
      availability: d.availability,
    }).returning();
    // Best-effort background geocode so admins can filter by distance later.
    // Never blocks the applicant response.
    geocodeApplicationInBackground(
      row.id,
      { street: row.address, city: row.city, state: row.state, zip: row.zip },
      req.log,
    );
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

// ---- Public: save / resume application draft ------------------------------

const APPLICATION_DRAFT_TTL_DAYS = 14;
// Cap the serialized payload at 1 MB so a malicious client can't blow up
// the drafts table. Real wizards serialize to well under 50 KB.
const APPLICATION_DRAFT_MAX_BYTES = 1024 * 1024;

const SaveDraftBody = z.object({
  token: z.string().min(20).max(128).optional(),
  email: z.email(),
  step: z.number().int().min(0).max(20),
  data: z.record(z.string(), z.unknown()),
});

function buildResumeUrl(token: string): string | null {
  const base = getTrustedBaseUrl();
  return base ? `${base}/admin-portal/apply?resume=${encodeURIComponent(token)}` : null;
}

/**
 * POST /applications/draft
 *
 * Save (or update) an in-progress application wizard and email the
 * applicant a magic resume link. Public + rate-limited. The opaque
 * token returned is the only credential needed to reload the draft,
 * so it MUST stay high-entropy and is delivered only via email.
 */
router.post("/applications/draft", applicationDraftIpLimiter, applicationDraftEmailLimiter, async (req, res): Promise<void> => {
  const parsed = SaveDraftBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Bad Request", message: parsed.error.message });
    return;
  }
  const { email: rawEmail, step, data } = parsed.data;
  const email = rawEmail.toLowerCase().trim();

  // Cap the payload size — we don't want to let an unauthenticated
  // caller dump arbitrary blobs into our drafts table.
  const serialized = JSON.stringify(data);
  if (serialized.length > APPLICATION_DRAFT_MAX_BYTES) {
    res.status(413).json({ error: "Payload Too Large", message: "Draft is too large to save." });
    return;
  }

  const now = new Date();
  const expiresAt = new Date(now.getTime() + APPLICATION_DRAFT_TTL_DAYS * 86400_000);

  // If the client sent an existing token, update that draft only if the
  // token AND email match (defense in depth — prevents someone with a
  // guessed token from overwriting another applicant's draft and
  // hijacking the resume email destination).
  let token: string | null = null;
  if (parsed.data.token) {
    const [existing] = await db
      .select()
      .from(applicationDraftsTable)
      .where(eq(applicationDraftsTable.token, parsed.data.token))
      .limit(1);
    if (existing && existing.email === email && existing.expiresAt > now) {
      await db.update(applicationDraftsTable).set({
        step,
        data,
        expiresAt,
        lastSentAt: now,
      }).where(eq(applicationDraftsTable.id, existing.id));
      token = existing.token;
    }
  }
  if (!token) {
    token = randomBytes(32).toString("base64url");
    await db.insert(applicationDraftsTable).values({
      token,
      email,
      step,
      data,
      lastSentAt: now,
      expiresAt,
    });
  }

  const resumeUrl = buildResumeUrl(token);
  let emailSent = false;
  if (resumeUrl) {
    const firstName = typeof (data as { firstName?: unknown }).firstName === "string"
      ? ((data as { firstName?: string }).firstName ?? null)
      : null;
    try {
      const msg = renderApplicationDraftResumeEmail({
        firstName,
        resumeUrl,
        expiresInDays: APPLICATION_DRAFT_TTL_DAYS,
      });
      emailSent = await sendEmail({ to: email, subject: msg.subject, text: msg.text, html: msg.html });
      if (!emailSent) {
        req.log.info({ to: email }, "Draft resume email not sent (SMTP not configured or send failed)");
      }
    } catch (err) {
      req.log.error({ err }, "Failed to send application draft resume email");
    }
  } else {
    req.log.warn("APP_BASE_URL / REPLIT_DOMAINS unset — cannot build resume URL for application draft");
  }

  // Never echo the token or URL in the response — the magic link must
  // only be deliverable via the email channel the applicant supplied.
  // Surfacing it in the JSON response would let anyone who can see the
  // network tab grab another person's resume link.
  res.json({
    ok: true,
    emailSent,
    expiresAt: expiresAt.toISOString(),
  });
});

/**
 * GET /applications/draft/:token
 *
 * Public lookup — fetches the saved wizard state for a resume link.
 * Token is high-entropy and the only credential needed; we still gate
 * with the shared token-lookup rate limiter to slow blind guessing.
 */
router.get("/applications/draft/:token", tokenLookupLimiter, async (req, res): Promise<void> => {
  const token = String(req.params.token ?? "");
  if (!token) {
    res.status(404).json({ error: "Not Found", message: "Draft not found." });
    return;
  }
  const [row] = await db
    .select()
    .from(applicationDraftsTable)
    .where(eq(applicationDraftsTable.token, token))
    .limit(1);
  if (!row) {
    res.status(404).json({ error: "Not Found", message: "Draft not found or expired." });
    return;
  }
  if (row.expiresAt <= new Date()) {
    res.status(410).json({ error: "Gone", message: "This resume link has expired." });
    return;
  }
  res.json({
    email: row.email,
    step: row.step,
    data: row.data,
    expiresAt: row.expiresAt.toISOString(),
  });
});

// ---- Admin: list / get / review / reject / approve ------------------------

router.get("/admin/applications", requireAdmin, async (req, res): Promise<void> => {
  const status = (req.query.status as string | undefined)?.trim();
  const search = (req.query.search as string | undefined)?.trim();
  const city = (req.query.city as string | undefined)?.trim();
  const nearSiteId = (req.query.nearSiteId as string | undefined)?.trim();
  const maxMilesRaw = (req.query.maxMiles as string | undefined)?.trim();
  const maxMiles = maxMilesRaw ? parseFloat(maxMilesRaw) : NaN;

  const conds: SQL[] = [];
  if (status) conds.push(eq(applicationsTable.status, status));
  if (city) conds.push(ilike(applicationsTable.city, `%${city}%`));
  if (search) {
    const like = `%${search}%`;
    const searchOr = or(
      ilike(applicationsTable.firstName, like),
      ilike(applicationsTable.lastName, like),
      ilike(applicationsTable.email, like),
      ilike(applicationsTable.phone, like),
      ilike(applicationsTable.city, like),
    );
    if (searchOr) conds.push(searchOr);
  }
  const rows = await db
    .select()
    .from(applicationsTable)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(applicationsTable.createdAt));

  // Distance filter (post-query). Only applied when both nearSiteId and a
  // positive maxMiles are provided AND the site itself has coordinates.
  // Applicants without a geocoded address are dropped from the result set
  // when the filter is active — they have no way to satisfy the predicate.
  if (nearSiteId && Number.isFinite(maxMiles) && maxMiles > 0) {
    const [site] = await db.select().from(sitesTable).where(eq(sitesTable.id, nearSiteId)).limit(1);
    if (!site || site.locationLat == null || site.locationLng == null) {
      res.status(400).json({
        error: "Bad Request",
        message: "Selected site has no coordinates on file; cannot filter by distance.",
      });
      return;
    }
    const siteLat = Number(site.locationLat);
    const siteLng = Number(site.locationLng);
    const enriched = rows
      .map((r) => {
        if (r.locationLat == null || r.locationLng == null) return null;
        const d = haversineMiles(siteLat, siteLng, Number(r.locationLat), Number(r.locationLng));
        if (d > maxMiles) return null;
        return rowToApplication(r, Math.round(d * 10) / 10);
      })
      .filter((x): x is NonNullable<typeof x> => x !== null)
      .sort((a, b) => (a.distanceMiles ?? 0) - (b.distanceMiles ?? 0));
    res.json(enriched);
    return;
  }

  res.json(rows.map((r) => rowToApplication(r)));
});

router.get("/admin/applications/:id", requireAdmin, async (req, res): Promise<void> => {
  const [row] = await db.select().from(applicationsTable).where(eq(applicationsTable.id, req.params.id as string)).limit(1);
  if (!row) { res.status(404).json({ error: "Not Found", message: "Application not found" }); return; }
  res.json(rowToApplication(row));
});

/**
 * POST /admin/applications/geocode-missing
 *
 * Bulk backfill the home-address coordinates that drive the
 * "Within distance of site" filter on the Applications page. Walks every
 * application that has a street address but no location_lat/lng and runs
 * the same Census Bureau geocoder used at submission time. Idempotent —
 * only touches rows still missing coords — and paced to stay polite with
 * the free public API.
 *
 * Honors GEOCODING_ENABLED so an admin can't accidentally start sending
 * PII to a third party without the operator-level opt-in being on.
 */
let applicantsGeocodeBackfillRunning = false;
router.post("/admin/applications/geocode-missing", requireAdmin, async (req, res): Promise<void> => {
  if (process.env.GEOCODING_ENABLED !== "true") {
    res.status(503).json({
      error: "Geocoding Disabled",
      message:
        "Set GEOCODING_ENABLED=true on the server to enable applicant address geocoding (sends street/city/state/zip to the US Census Bureau geocoder).",
    });
    return;
  }
  if (applicantsGeocodeBackfillRunning) {
    res.status(409).json({
      error: "Already Running",
      message: "An applicant address backfill is already in progress. Wait for it to finish and try again.",
    });
    return;
  }
  applicantsGeocodeBackfillRunning = true;
  try {
    const hasAddress = sql`length(trim(coalesce(${applicationsTable.address}, ''))) > 0`;
    const missingCoord = or(isNull(applicationsTable.locationLat), isNull(applicationsTable.locationLng));
    const rows = await db
      .select({
        id: applicationsTable.id,
        address: applicationsTable.address,
        city: applicationsTable.city,
        state: applicationsTable.state,
        zip: applicationsTable.zip,
      })
      .from(applicationsTable)
      .where(and(missingCoord, hasAddress));

    let resolved = 0;
    let skippedRace = 0;
    const unresolved: Array<{ id: string }> = [];
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const match = await geocodeUsAddress({
        street: r.address,
        city: r.city,
        state: r.state,
        zip: r.zip,
      });
      if (match) {
        const updated = await db
          .update(applicationsTable)
          .set({ locationLat: String(match.lat), locationLng: String(match.lng) })
          .where(and(
            eq(applicationsTable.id, r.id),
            or(isNull(applicationsTable.locationLat), isNull(applicationsTable.locationLng)),
          ))
          .returning({ id: applicationsTable.id });
        if (updated.length > 0) resolved++;
        else skippedRace++;
      } else {
        unresolved.push({ id: r.id });
      }
      if (i < rows.length - 1) await new Promise((rs) => setTimeout(rs, 200));
    }

    res.json({
      candidates: rows.length,
      resolved,
      skippedRace,
      unresolved: unresolved.length,
    });
  } finally {
    applicantsGeocodeBackfillRunning = false;
  }
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
  const appId = req.params.id as string;

  // Invalidate any outstanding amendment tokens so that an old amendment link
  // cannot reopen a rejected application.
  await db.update(applicationAmendmentTokensTable)
    .set({ consumedAt: new Date() })
    .where(and(
      eq(applicationAmendmentTokensTable.applicationId, appId),
      sql`${applicationAmendmentTokensTable.consumedAt} IS NULL`,
    ));

  const [row] = await db.update(applicationsTable).set({
    status: "rejected",
    reviewerNotes: notes ?? null,
    reviewedBy: req.user!.userId,
    reviewedAt: new Date(),
  }).where(eq(applicationsTable.id, appId)).returning();
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

router.delete("/admin/applications/:id", requireAdmin, async (req, res): Promise<void> => {
  const appId = req.params.id as string;
  const [app] = await db.select().from(applicationsTable).where(eq(applicationsTable.id, appId)).limit(1);
  if (!app) { res.status(404).json({ error: "Not Found", message: "Application not found" }); return; }
  if (app.status === "approved") {
    res.status(409).json({ error: "Conflict", message: "Approved applications cannot be deleted. Manage the employee record instead." });
    return;
  }
  await db.delete(applicationAmendmentTokensTable).where(eq(applicationAmendmentTokensTable.applicationId, appId));
  await db.delete(applicationsTable).where(eq(applicationsTable.id, appId));
  res.status(204).end();
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
          // Mirror the applicant's (already E.164-normalized) phone onto the
          // account record so the new officer is SMS-reachable and shows a
          // phone in the account profile, not just the employee file.
          phoneNumber: app.phone,
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
          // Mirror the applicant's (already E.164-normalized) phone onto the
          // account record so the new officer is SMS-reachable and shows a
          // phone in the account profile, not just the employee file.
          phoneNumber: app.phone,
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
        // Mirror the applicant's geocoded home coords so the mobile
        // open-shifts "distance from home" sort works on day one for
        // newly-provisioned officers (no need to wait for them to re-save
        // their profile to trigger a fresh geocode).
        homeLat: app.locationLat ?? null,
        homeLng: app.locationLng ?? null,
        lastGeocodedAddress: app.locationLat != null ? app.address : null,
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

      // Invalidate any outstanding amendment tokens so that an old amendment
      // link cannot reopen an already-approved application and create
      // divergence between the employee record and the application record.
      await tx.update(applicationAmendmentTokensTable)
        .set({ consumedAt: new Date() })
        .where(and(
          eq(applicationAmendmentTokensTable.applicationId, appId),
          sql`${applicationAmendmentTokensTable.consumedAt} IS NULL`,
        ));

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
  let smsStatus: "sent" | "skipped" | "failed" = "skipped";
  let updatedApp = result.updated;
  if (onboardingUrl) {
    const emailMsg = renderOnboardingEmail({
      firstName: app.firstName,
      onboardingUrl,
      email: app.email,
      tempPassword: result.tempPasswordPlain,
    });
    const delivery = await sendEmailDetailed({
      to: app.email,
      subject: emailMsg.subject,
      text: emailMsg.text,
      html: emailMsg.html,
    });
    emailSent = delivery.ok;
    const now = new Date();
    const [persisted] = await db.update(applicationsTable).set({
      onboardingEmailStatus: delivery.status,
      onboardingEmailMessageId: delivery.messageId,
      onboardingEmailResponse: delivery.response,
      onboardingEmailError: delivery.status === "bounced"
        ? `Recipient(s) rejected: ${delivery.rejected.join(", ")}${delivery.response ? ` — ${delivery.response}` : ""}`
        : delivery.error,
      onboardingEmailAttemptedAt: now,
      onboardingEmailSentAt: delivery.ok ? now : null,
    }).where(eq(applicationsTable.id, appId)).returning();
    if (persisted) updatedApp = persisted;
    if (delivery.ok) {
      req.log.info({ employeeId: result.userId, to: app.email, messageId: delivery.messageId }, "Onboarding approval email sent");
    } else if (delivery.status === "bounced") {
      req.log.warn({ employeeId: result.userId, to: app.email, rejected: delivery.rejected, response: delivery.response }, "Onboarding email bounced");
    } else if (delivery.status === "failed") {
      req.log.warn({ employeeId: result.userId, to: app.email, error: delivery.error }, "Onboarding email send failed");
    } else {
      req.log.info({ employeeId: result.userId }, "Onboarding email not sent — SMTP not configured");
    }

    // SMS fallback: text the onboarding link to the applicant's phone so
    // they're reachable even if the email bounces or hits spam. The
    // applicant gave us this phone on the application form — implied
    // consent for onboarding-related comms. No-op when Twilio isn't
    // connected or the number isn't valid E.164.
    const smsBody =
      `WCSG: Hi ${app.firstName}, your application is approved. ` +
      `Complete onboarding here (expires in 14 days): ${onboardingUrl}`;
    smsStatus = await sendSmsToPhoneNumber(app.phone, smsBody);
    if (smsStatus === "sent") {
      req.log.info({ employeeId: result.userId }, "Onboarding approval SMS sent");
    } else if (smsStatus === "failed") {
      req.log.warn({ employeeId: result.userId }, "Onboarding approval SMS delivery failed");
    }
  } else {
    req.log.error({ employeeId: result.userId }, "Approve: APP_BASE_URL/REPLIT_DOMAINS unset; cannot build onboarding link");
  }

  res.json({
    application: rowToApplication(updatedApp),
    onboardingUrl,
    onboardingToken: token,
    employeeId: result.userId,
    tempPassword: result.tempPasswordPlain,
    emailSent,
    smsStatus,
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
      const objectPath = (raw as { objectPath: string }).objectPath;
      if (!isApplicationObjectPath(objectPath)) {
        res.status(400).json({ error: "Bad Request", message: `Invalid document path for field "${k}".` });
        return;
      }
      updates[def.column] = objectPath;
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
      if (k === "phone") {
        const normalized = normalizePhoneToE164(raw);
        if (!normalized) {
          res.status(400).json({
            error: "Bad Request",
            message: "Phone number is invalid. Please enter a valid US phone number (e.g. (214) 555-1234) or include the country code (e.g. +44 20 1234 5678).",
          });
          return;
        }
        updates[def.column] = normalized;
      } else {
        updates[def.column] = raw;
      }
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
  const txResult = await db.transaction(async (tx) => {
    const [tokenRow] = await tx.select().from(applicationAmendmentTokensTable)
      .where(eq(applicationAmendmentTokensTable.id, t.id)).for("update").limit(1);
    if (!tokenRow || tokenRow.consumedAt) return { conflict: "already_used" } as const;

    // Defense-in-depth: re-check the application status inside the transaction.
    // Approve/reject invalidate tokens proactively, but this guard ensures
    // correctness even under races or future code paths that skip invalidation.
    const [appRow] = await tx.select({ status: applicationsTable.status })
      .from(applicationsTable)
      .where(eq(applicationsTable.id, t.applicationId))
      .for("update")
      .limit(1);
    if (!appRow || appRow.status !== "info_requested") {
      return { conflict: "not_editable" } as const;
    }

    if (Object.keys(updates).length > 0) {
      await tx.update(applicationsTable).set(updates).where(eq(applicationsTable.id, t.applicationId));
    }
    // Bump back to under_review so admin sees it ready to re-evaluate.
    await tx.update(applicationsTable).set({ status: "under_review" })
      .where(eq(applicationsTable.id, t.applicationId));
    await tx.update(applicationAmendmentTokensTable).set({ consumedAt: new Date() })
      .where(eq(applicationAmendmentTokensTable.id, t.id));
    const [row] = await tx.select().from(applicationsTable).where(eq(applicationsTable.id, t.applicationId)).limit(1);
    return { row } as const;
  });
  if ("conflict" in txResult) {
    if (txResult.conflict === "already_used") {
      res.status(409).json({ error: "Conflict", message: "This link has already been used." });
    } else {
      res.status(409).json({ error: "Conflict", message: "This application has already been reviewed and is no longer accepting amendments." });
    }
    return;
  }
  const updated = txResult.row;

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

  // Normalize the emergency-contact phone to E.164 (same default-to-US
  // rule as applicant phone) so SMS-style features (emergency notify-next-
  // of-kin, future reference checks, admin "text emergency contact" tools)
  // can dispatch without per-call string-massaging. Required field — a
  // non-parseable value is rejected with a clear error.
  const normalizedEmergencyPhone = normalizePhoneToE164(d.emergencyContactPhone);
  if (!normalizedEmergencyPhone) {
    res.status(400).json({
      error: "Bad Request",
      message: "Emergency contact phone is invalid. Please enter a valid US phone number (e.g. (214) 555-1234) or include the country code (e.g. +44 20 1234 5678).",
    });
    return;
  }

  // Reject any submitted document path that was minted by an authenticated
  // upload session (i.e. starts with /objects/uploads/u/). Only anonymous
  // application-upload paths are valid in this token-based flow.
  const onboardingFilePaths: (string | undefined)[] = [
    d.p45Doc?.objectPath,
    d.siaLicenseDoc?.objectPath,
    d.passportDoc?.objectPath,
  ];
  for (const p of onboardingFilePaths) {
    if (p !== undefined && !isApplicationObjectPath(p)) {
      res.status(400).json({ error: "Bad Request", message: "Invalid document path." });
      return;
    }
  }

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
    emergencyContactPhone: normalizedEmergencyPhone,
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
    emergencyContactPhone: normalizedEmergencyPhone,
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
  let deliveryStatus: string | null = null;
  let deliveryError: string | null = null;
  if (onboardingUrl) {
    const emailMsg = renderResendOnboardingEmail({
      firstName: user.firstName,
      onboardingUrl,
    });
    const delivery = await sendEmailDetailed({
      to: user.email,
      subject: emailMsg.subject,
      text: emailMsg.text,
      html: emailMsg.html,
    });
    emailSent = delivery.ok;
    deliveryStatus = delivery.status;
    deliveryError = delivery.status === "bounced"
      ? `Recipient(s) rejected: ${delivery.rejected.join(", ")}${delivery.response ? ` — ${delivery.response}` : ""}`
      : delivery.error;
    // Mirror delivery state onto the originating application row (if any) so
    // the Applications list reflects the latest known state, not just the
    // outcome of the original approve email.
    if (prev?.applicationId) {
      const now = new Date();
      await db.update(applicationsTable).set({
        onboardingEmailStatus: delivery.status,
        onboardingEmailMessageId: delivery.messageId,
        onboardingEmailResponse: delivery.response,
        onboardingEmailError: deliveryError,
        onboardingEmailAttemptedAt: now,
        onboardingEmailSentAt: delivery.ok ? now : null,
      }).where(eq(applicationsTable.id, prev.applicationId));
    }
    if (delivery.ok) {
      req.log.info({ employeeId, to: user.email, messageId: delivery.messageId }, "Resent onboarding email sent");
    } else if (delivery.status === "bounced") {
      req.log.warn({ employeeId, to: user.email, rejected: delivery.rejected, response: delivery.response }, "Resent onboarding email bounced");
    } else if (delivery.status === "failed") {
      req.log.warn({ employeeId, to: user.email, error: delivery.error }, "Resent onboarding email failed");
    } else {
      req.log.info({ employeeId }, "Resent onboarding email not sent — SMTP not configured");
    }
  } else {
    req.log.error({ employeeId }, "Resend onboarding: APP_BASE_URL/REPLIT_DOMAINS unset; cannot build link");
  }

  res.json({
    onboardingUrl,
    onboardingToken: token,
    emailSent,
    emailDeliveryStatus: deliveryStatus,
    emailDeliveryError: deliveryError,
  });
});

export default router;
