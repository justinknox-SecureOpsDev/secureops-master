import { Router, type IRouter, type Request, type Response } from "express";
import { eq, desc, asc, ilike, or, sql, and, isNull, type SQL } from "drizzle-orm";
import { sitesTable } from "@workspace/db";
import { haversineMiles } from "../lib/geofence";
import { geocodeUsAddress } from "../lib/geocode";
import bcrypt from "bcryptjs";
import { randomBytes } from "crypto";
import {
  db,
  applicationsTable,
  applicationQuestionsTable,
  applicationDraftsTable,
  usersTable,
  employeesTable,
  licensesTable,
  onboardingTokensTable,
  onboardingSubmissionsTable,
  applicationAmendmentTokensTable,
  applicationFieldConfigTable,
  policiesTable,
} from "@workspace/db";
import {
  APPLICATION_FIELD_REGISTRY,
  APPLICATION_FIELD_SECTIONS,
  mergeApplicationFields,
  isBuiltInApplicationField,
  type EffectiveApplicationField,
} from "../lib/applicationFields";
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
import { sendEmail, sendEmailDetailed, renderOnboardingEmail, renderResendOnboardingEmail, renderRejectionEmail, renderApplicationReceivedEmail, renderRequestInfoEmail, renderApplicationDraftResumeEmail, renderNewApplicationAdminEmail, renderOnboardingCompletedAdminEmail } from "../lib/email";
import { brand } from "../lib/brandConfig";
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
    customAnswers: r.customAnswers ?? null,
    trainingCertificateKeys: r.trainingCertificateKeys ?? null,
    availability: r.availability ?? null,
    reviewedAt: r.reviewedAt ? r.reviewedAt.toISOString() : null,
    firstApprovedBy: r.firstApprovedBy ?? null,
    firstApprovedAt: r.firstApprovedAt ? r.firstApprovedAt.toISOString() : null,
    secondApprovedBy: r.secondApprovedBy ?? null,
    secondApprovedAt: r.secondApprovedAt ? r.secondApprovedAt.toISOString() : null,
    onboardingEmailStatus: r.onboardingEmailStatus ?? null,
    onboardingEmailMessageId: r.onboardingEmailMessageId ?? null,
    onboardingEmailResponse: r.onboardingEmailResponse ?? null,
    onboardingEmailError: r.onboardingEmailError ?? null,
    onboardingEmailSentAt: r.onboardingEmailSentAt ? r.onboardingEmailSentAt.toISOString() : null,
    onboardingEmailAttemptedAt: r.onboardingEmailAttemptedAt ? r.onboardingEmailAttemptedAt.toISOString() : null,
    createdAt: r.createdAt.toISOString(),
  };
}

// ---- Custom application questions (form builder) -------------------------

const CUSTOM_FIELD_TYPES = [
  "short_text",
  "long_text",
  "number",
  "date",
  "select",
  "multiselect",
  "yes_no",
] as const;
type CustomFieldType = (typeof CUSTOM_FIELD_TYPES)[number];

type ApplicationQuestionRow = typeof applicationQuestionsTable.$inferSelect;

function customTypeNeedsOptions(t: CustomFieldType): boolean {
  return t === "select" || t === "multiselect";
}

function questionToApi(q: ApplicationQuestionRow) {
  return {
    id: q.id,
    label: q.label,
    helpText: q.helpText ?? null,
    fieldType: q.fieldType,
    required: q.required,
    options: q.options ?? null,
    sortOrder: q.sortOrder,
    enabled: q.enabled,
    createdAt: q.createdAt ? q.createdAt.toISOString() : null,
    updatedAt: q.updatedAt ? q.updatedAt.toISOString() : null,
  };
}

function isCustomAnswerPresent(v: unknown): boolean {
  if (v === null || v === undefined) return false;
  if (typeof v === "string") return v.trim().length > 0;
  if (Array.isArray(v)) return v.length > 0;
  return true;
}

/**
 * Coerce + validate a single submitted answer against its question definition.
 * Returns the normalized value to store (or null when not answered), and an
 * error string when the answer is required-but-missing or the wrong shape.
 */
function coerceCustomAnswer(q: ApplicationQuestionRow, raw: unknown): { value: unknown; error?: string } {
  if (!isCustomAnswerPresent(raw)) {
    if (q.required) return { value: null, error: `"${q.label}" is required.` };
    return { value: null };
  }
  switch (q.fieldType as CustomFieldType) {
    case "short_text":
    case "long_text":
    case "date": {
      if (typeof raw !== "string") return { value: null, error: `"${q.label}" is invalid.` };
      return { value: raw.trim() };
    }
    case "number": {
      const n = typeof raw === "number" ? raw : Number(String(raw).trim());
      if (!Number.isFinite(n)) return { value: null, error: `"${q.label}" must be a number.` };
      return { value: n };
    }
    case "yes_no": {
      if (typeof raw === "boolean") return { value: raw };
      const s = String(raw).toLowerCase();
      if (s === "true" || s === "yes") return { value: true };
      if (s === "false" || s === "no") return { value: false };
      return { value: null, error: `"${q.label}" must be yes or no.` };
    }
    case "select": {
      if (typeof raw !== "string" || !(q.options ?? []).includes(raw)) {
        return { value: null, error: `"${q.label}" has an invalid selection.` };
      }
      return { value: raw };
    }
    case "multiselect": {
      if (!Array.isArray(raw)) return { value: null, error: `"${q.label}" is invalid.` };
      const opts = q.options ?? [];
      const vals = raw.filter((x): x is string => typeof x === "string" && opts.includes(x));
      if (q.required && vals.length === 0) return { value: null, error: `"${q.label}" is required.` };
      return { value: vals };
    }
    default:
      return { value: null };
  }
}

const CreateQuestionBody = z.object({
  label: z.string().trim().min(1).max(300),
  helpText: z.string().trim().max(1000).nullish(),
  fieldType: z.enum(CUSTOM_FIELD_TYPES),
  required: z.boolean().optional(),
  options: z.array(z.string().trim().min(1).max(200)).max(50).nullish(),
  enabled: z.boolean().optional(),
});
const UpdateQuestionBody = CreateQuestionBody.partial();
const ReorderQuestionsBody = z.object({ ids: z.array(z.string().uuid()).max(200) });

// ---- Built-in field config (form builder for hardcoded fields) -----------

// PATCH body for a single built-in field override. `undefined` (omitted) keys
// leave the stored override untouched; the explicit nulls below let an admin
// revert an override to the registry default.
const UpdateApplicationFieldBody = z.object({
  labelOverride: z.string().trim().max(300).nullish(),
  helpTextOverride: z.string().trim().max(1000).nullish(),
  requiredOverride: z.boolean().nullish(),
  hidden: z.boolean().optional(),
});
const ReorderApplicationFieldsBody = z.object({
  section: z.number().int().min(0).max(APPLICATION_FIELD_SECTIONS.length - 1),
  keys: z.array(z.string().min(1).max(100)).min(1).max(100),
});

/** Load all override rows and merge them with the registry. */
async function loadEffectiveApplicationFields(): Promise<EffectiveApplicationField[]> {
  const rows = await db.select().from(applicationFieldConfigTable);
  return mergeApplicationFields(rows);
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
  // Load the admin's per-field config and enforce required/hidden dynamically.
  // The contract only mandates the five locked core fields; every other
  // built-in field is required (or not) according to application_field_config.
  const effectiveFields = await loadEffectiveApplicationFields();
  const fieldCfg = new Map(effectiveFields.map((f) => [f.key, f]));
  const isFieldHidden = (key: string): boolean => fieldCfg.get(key)?.hidden ?? false;
  // Whether the applicant actually supplied a value for a built-in field.
  const fieldPresent = (key: string): boolean => {
    switch (key) {
      case "city": return !!d.city?.trim();
      case "state": return !!d.state?.trim();
      case "zip": return !!d.zip?.trim();
      case "dateOfBirth": return !!d.dateOfBirth?.trim();
      case "cityOfBirth": return !!d.cityOfBirth?.trim();
      case "stateOfBirth": return !!d.stateOfBirth?.trim();
      case "niNumber": return !!d.niNumber?.trim();
      case "i9Doc": return !!d.i9Doc?.objectPath;
      case "ssnCardDoc": return !!d.ssnCardDoc?.objectPath;
      case "idDocType": return !!d.idDocType;
      case "idDoc": return !!d.idDoc?.objectPath;
      case "siaLicenseNumber": return !!d.siaLicenseNumber?.trim();
      case "siaLicenseLevel": return d.siaLicenseLevel !== undefined && d.siaLicenseLevel !== null;
      case "siaLicenseExpiry": return !!d.siaLicenseExpiry?.trim();
      case "previousExperience": return !!d.previousExperience?.trim();
      case "yearsExperience": return d.yearsExperience !== undefined && d.yearsExperience !== null;
      case "references": return Array.isArray(d.references) && d.references.length > 0;
      case "photo": return !!d.photo?.objectPath;
      case "cv": return !!d.cv?.objectPath;
      case "trainingCertificates": return Array.isArray(d.trainingCertificates) && d.trainingCertificates.length > 0;
      case "availability": return Array.isArray(d.availability) && d.availability.length > 0;
      default: return true;
    }
  };
  for (const f of effectiveFields) {
    if (f.locked || f.hidden || !f.required) continue;
    if (!fieldPresent(f.key)) {
      const message = `${f.label} is required.`;
      sendApplicationValidationError(res, [{ field: f.key, message }], message);
      return;
    }
  }
  // Validate + denormalize answers to admin-defined custom questions. We store
  // [{ questionId, label, fieldType, value }] so HR can read historical answers
  // even after a question is later edited or deleted.
  let storedCustomAnswers: Array<Record<string, unknown>> | null = null;
  {
    const questions = await db
      .select()
      .from(applicationQuestionsTable)
      .where(eq(applicationQuestionsTable.enabled, true));
    if (questions.length > 0) {
      const submitted = new Map<string, unknown>();
      if (Array.isArray(d.customAnswers)) {
        for (const a of d.customAnswers as Array<{ questionId?: unknown; value?: unknown }>) {
          if (a && typeof a.questionId === "string") submitted.set(a.questionId, a.value);
        }
      }
      const out: Array<Record<string, unknown>> = [];
      for (const q of questions) {
        const { value, error } = coerceCustomAnswer(q, submitted.get(q.id));
        if (error) {
          sendApplicationValidationError(res, [{ field: `custom:${q.id}`, message: error }], error);
          return;
        }
        if (value !== null && value !== undefined) {
          out.push({ questionId: q.id, label: q.label, fieldType: q.fieldType, value });
        }
      }
      storedCustomAnswers = out;
    }
  }
  try {
    const [row] = await db.insert(applicationsTable).values({
      firstName: d.firstName,
      lastName: d.lastName,
      email: d.email.toLowerCase(),
      phone: normalizedPhone,
      address: d.address,
      // Hidden built-in fields are stored as null even if a value slips through
      // (e.g. a stale client). Otherwise persist whatever the applicant gave.
      city: isFieldHidden("city") ? null : (d.city ?? null),
      state: isFieldHidden("state") ? null : (d.state ?? null),
      zip: isFieldHidden("zip") ? null : (d.zip ?? null),
      dateOfBirth: isFieldHidden("dateOfBirth") ? null : (d.dateOfBirth ?? null),
      cityOfBirth: isFieldHidden("cityOfBirth") ? null : (d.cityOfBirth ?? null),
      stateOfBirth: isFieldHidden("stateOfBirth") ? null : (d.stateOfBirth ?? null),
      niNumber: isFieldHidden("niNumber") ? null : (d.niNumber ?? null),
      rightToWorkStatus: d.rightToWorkStatus ?? null,
      rightToWorkDocKey: d.rightToWorkDoc?.objectPath ?? null,
      i9DocKey: isFieldHidden("i9Doc") ? null : (d.i9Doc?.objectPath ?? null),
      ssnCardDocKey: isFieldHidden("ssnCardDoc") ? null : (d.ssnCardDoc?.objectPath ?? null),
      idDocType: isFieldHidden("idDocType") ? null : (d.idDocType ?? null),
      idDocKey: isFieldHidden("idDoc") ? null : (d.idDoc?.objectPath ?? null),
      siaLicenseNumber: isFieldHidden("siaLicenseNumber") ? null : (d.siaLicenseNumber ?? null),
      siaLicenseLevel: isFieldHidden("siaLicenseLevel") ? null : (d.siaLicenseLevel ?? null),
      siaLicenseExpiry: isFieldHidden("siaLicenseExpiry") ? null : (d.siaLicenseExpiry ?? null),
      previousExperience: isFieldHidden("previousExperience") ? null : (d.previousExperience ?? null),
      yearsExperience: isFieldHidden("yearsExperience") ? null : (d.yearsExperience ?? null),
      references: isFieldHidden("references") ? null : (normalizedReferences ?? d.references ?? null),
      customAnswers: storedCustomAnswers,
      photoKey: isFieldHidden("photo") ? null : (d.photo?.objectPath ?? null),
      cvKey: isFieldHidden("cv") ? null : (d.cv?.objectPath ?? null),
      trainingCertificateKeys: isFieldHidden("trainingCertificates") ? null : (d.trainingCertificates?.map((f) => f.objectPath) ?? null),
      availability: isFieldHidden("availability") ? null : (d.availability ?? null),
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
    // Notify the dedicated admin inbox of the new submission. No-op when
    // SMTP isn't configured; never blocks the applicant response.
    try {
      const base = process.env.APP_BASE_URL
        || (process.env.REPLIT_DOMAINS ? `https://${process.env.REPLIT_DOMAINS.split(",")[0]}` : "");
      const tmpl = renderNewApplicationAdminEmail({
        applicantName: `${row.firstName} ${row.lastName}`,
        applicantEmail: row.email,
        applicantPhone: row.phone ?? undefined,
        reviewUrl: base ? `${base}/admin-portal/hr/applications` : undefined,
      });
      void sendEmail({ to: brand.adminNotifyEmail, subject: tmpl.subject, text: tmpl.text, html: tmpl.html })
        .catch((err) => req.log.warn({ err, applicationId: row.id }, "new-application admin email failed"));
    } catch (mailErr) {
      req.log.warn({ err: mailErr, applicationId: row.id }, "Failed to send new-application admin email");
    }
    res.status(201).json(rowToApplication(row));
  } catch (err) {
    req.log.error({ err }, "Failed to submit application");
    res.status(500).json({ error: "Internal Server Error", message: "Could not submit application" });
  }
});

// ---- Form builder: custom question CRUD ----------------------------------

/**
 * Public: the full Apply form template — built-in field config (labels, help,
 * required, hidden, order) plus enabled admin-defined custom questions.
 */
router.get("/application-template", async (_req, res): Promise<void> => {
  const [rows, fieldConfig] = await Promise.all([
    db
      .select()
      .from(applicationQuestionsTable)
      .where(eq(applicationQuestionsTable.enabled, true))
      .orderBy(asc(applicationQuestionsTable.sortOrder), asc(applicationQuestionsTable.id)),
    loadEffectiveApplicationFields(),
  ]);
  // Hidden built-in fields are not surfaced to the public form at all.
  const visible = fieldConfig.filter((f) => !f.hidden);
  res.json({ questions: rows.map(questionToApi), fieldConfig: visible });
});

// ---- Admin: built-in field config CRUD -----------------------------------

/** Admin: effective config for every built-in field (incl. hidden + locked). */
router.get("/admin/application-fields", requireAdmin, async (_req, res): Promise<void> => {
  res.json(await loadEffectiveApplicationFields());
});

// Registered before the :key route so it isn't shadowed by the path param.
router.post("/admin/application-fields/reorder", requireAdmin, async (req, res): Promise<void> => {
  const parsed = ReorderApplicationFieldsBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Bad Request", message: parsed.error.message });
    return;
  }
  const { section, keys } = parsed.data;
  // The submitted keys must be exactly the built-in fields in this section —
  // a complete permutation — so stale clients can't gap or duplicate orders.
  const sectionKeys = APPLICATION_FIELD_REGISTRY.filter((f) => f.section === section).map((f) => f.key);
  const sameSet = keys.length === sectionKeys.length
    && new Set(keys).size === keys.length
    && keys.every((k) => sectionKeys.includes(k));
  if (!sameSet) {
    res.status(409).json({ error: "Conflict", message: "Field set changed; reload and try again." });
    return;
  }
  await db.transaction(async (tx) => {
    for (let i = 0; i < keys.length; i++) {
      await tx
        .insert(applicationFieldConfigTable)
        .values({ fieldKey: keys[i], sortOrder: i })
        .onConflictDoUpdate({
          target: applicationFieldConfigTable.fieldKey,
          set: { sortOrder: i, updatedAt: new Date() },
        });
    }
  });
  res.json(await loadEffectiveApplicationFields());
});

router.patch("/admin/application-fields/:key", requireAdmin, async (req, res): Promise<void> => {
  const key = Array.isArray(req.params.key) ? req.params.key[0] : req.params.key;
  if (!isBuiltInApplicationField(key)) {
    res.status(404).json({ error: "Not Found", message: "Unknown application field." });
    return;
  }
  const parsed = UpdateApplicationFieldBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Bad Request", message: parsed.error.message });
    return;
  }
  const d = parsed.data;
  const def = APPLICATION_FIELD_REGISTRY.find((f) => f.key === key)!;
  // Locked core fields (firstName, lastName, email, phone, address) may only be
  // relabelled — never made optional or hidden. Silently drop those overrides.
  const update: Partial<typeof applicationFieldConfigTable.$inferInsert> = { fieldKey: key };
  if (d.labelOverride !== undefined) update.labelOverride = d.labelOverride ?? null;
  if (d.helpTextOverride !== undefined) update.helpTextOverride = d.helpTextOverride ?? null;
  if (!def.locked) {
    if (d.requiredOverride !== undefined) update.requiredOverride = d.requiredOverride ?? null;
    if (d.hidden !== undefined) update.hidden = d.hidden;
  }
  update.updatedAt = new Date();
  await db
    .insert(applicationFieldConfigTable)
    .values(update as typeof applicationFieldConfigTable.$inferInsert)
    .onConflictDoUpdate({ target: applicationFieldConfigTable.fieldKey, set: update });
  const merged = await loadEffectiveApplicationFields();
  res.json(merged.find((f) => f.key === key));
});

/** Admin: full list (enabled + disabled) in display order. */
router.get("/admin/application-questions", requireAdmin, async (_req, res): Promise<void> => {
  const rows = await db
    .select()
    .from(applicationQuestionsTable)
    .orderBy(asc(applicationQuestionsTable.sortOrder), asc(applicationQuestionsTable.id));
  res.json(rows.map(questionToApi));
});

router.post("/admin/application-questions", requireAdmin, async (req, res): Promise<void> => {
  const parsed = CreateQuestionBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Bad Request", message: parsed.error.message });
    return;
  }
  const d = parsed.data;
  if (customTypeNeedsOptions(d.fieldType) && (!d.options || d.options.length < 1)) {
    res.status(400).json({ error: "Bad Request", message: "Dropdown and multi-select questions need at least one option." });
    return;
  }
  const [{ maxSort }] = await db
    .select({ maxSort: sql<number>`coalesce(max(${applicationQuestionsTable.sortOrder}), -1)` })
    .from(applicationQuestionsTable);
  const [row] = await db
    .insert(applicationQuestionsTable)
    .values({
      label: d.label,
      helpText: d.helpText ?? null,
      fieldType: d.fieldType,
      required: d.required ?? false,
      options: customTypeNeedsOptions(d.fieldType) ? (d.options ?? []) : null,
      enabled: d.enabled ?? true,
      sortOrder: (maxSort ?? -1) + 1,
    })
    .returning();
  res.status(201).json(questionToApi(row));
});

// Registered before the :id routes so it isn't shadowed by path params.
router.post("/admin/application-questions/reorder", requireAdmin, async (req, res): Promise<void> => {
  const parsed = ReorderQuestionsBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Bad Request", message: parsed.error.message });
    return;
  }
  const { ids } = parsed.data;
  if (new Set(ids).size !== ids.length) {
    res.status(400).json({ error: "Bad Request", message: "ids must not contain duplicates" });
    return;
  }
  const conflict = await db.transaction(async (tx) => {
    const existing = await tx.select({ id: applicationQuestionsTable.id }).from(applicationQuestionsTable);
    const existingIds = new Set(existing.map((r) => r.id));
    // ids must be a complete permutation of the current question set, or stale
    // clients could create duplicate/gapped sort orders.
    if (ids.length !== existingIds.size || ids.some((id) => !existingIds.has(id))) {
      return true;
    }
    for (let i = 0; i < ids.length; i++) {
      await tx
        .update(applicationQuestionsTable)
        .set({ sortOrder: i })
        .where(eq(applicationQuestionsTable.id, ids[i]));
    }
    return false;
  });
  if (conflict) {
    res.status(409).json({ error: "Conflict", message: "Question set changed; reload and try again" });
    return;
  }
  const rows = await db
    .select()
    .from(applicationQuestionsTable)
    .orderBy(asc(applicationQuestionsTable.sortOrder), asc(applicationQuestionsTable.id));
  res.json(rows.map(questionToApi));
});

router.patch("/admin/application-questions/:id", requireAdmin, async (req, res): Promise<void> => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const parsed = UpdateQuestionBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Bad Request", message: parsed.error.message });
    return;
  }
  const [existing] = await db
    .select()
    .from(applicationQuestionsTable)
    .where(eq(applicationQuestionsTable.id, id))
    .limit(1);
  if (!existing) {
    res.status(404).json({ error: "Not Found", message: "Question not found" });
    return;
  }
  const d = parsed.data;
  const nextType = (d.fieldType ?? existing.fieldType) as CustomFieldType;
  const nextOptions = customTypeNeedsOptions(nextType)
    ? (d.options !== undefined ? (d.options ?? []) : (existing.options ?? []))
    : null;
  if (customTypeNeedsOptions(nextType) && (nextOptions === null || nextOptions.length < 1)) {
    res.status(400).json({ error: "Bad Request", message: "Dropdown and multi-select questions need at least one option." });
    return;
  }
  const update: Partial<typeof applicationQuestionsTable.$inferInsert> = { options: nextOptions };
  if (d.label !== undefined) update.label = d.label;
  if (d.helpText !== undefined) update.helpText = d.helpText ?? null;
  if (d.fieldType !== undefined) update.fieldType = d.fieldType;
  if (d.required !== undefined) update.required = d.required;
  if (d.enabled !== undefined) update.enabled = d.enabled;
  const [row] = await db
    .update(applicationQuestionsTable)
    .set(update)
    .where(eq(applicationQuestionsTable.id, id))
    .returning();
  res.json(questionToApi(row));
});

router.delete("/admin/application-questions/:id", requireAdmin, async (req, res): Promise<void> => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const [row] = await db
    .delete(applicationQuestionsTable)
    .where(eq(applicationQuestionsTable.id, id))
    .returning();
  if (!row) {
    res.status(404).json({ error: "Not Found", message: "Question not found" });
    return;
  }
  res.json({ ok: true });
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
    | { kind: "first"; updated: ApplicationRow }
    | { kind: "second"; updated: ApplicationRow; userId: string; tempPasswordPlain: string }
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

      // ---------------------------- FIRST APPROVAL ----------------------------
      // Any non-approved application that is NOT yet awaiting a second sign-off
      // gets its first approval recorded here. We deliberately provision
      // NOTHING (no user account, no onboarding link, no email) until a second,
      // distinct admin signs off. Always (re)write firstApprovedBy and clear any
      // stale second-approval columns so the two-admin gate restarts cleanly
      // even if the row carried leftover values from an earlier cycle.
      if (app.status !== "awaiting_second_approval") {
        const [updated] = await tx.update(applicationsTable).set({
          status: "awaiting_second_approval",
          reviewerNotes: notes ?? app.reviewerNotes ?? null,
          reviewedBy: reviewerId,
          reviewedAt: new Date(),
          firstApprovedBy: reviewerId,
          firstApprovedAt: new Date(),
          secondApprovedBy: null,
          secondApprovedAt: null,
        }).where(eq(applicationsTable.id, appId)).returning();
        return { kind: "first", updated };
      }

      // --------------------------- SECOND APPROVAL ----------------------------
      // The application already carries one approval. The second approval MUST
      // come from a different admin — a single admin cannot approve the same
      // application twice to satisfy the gate on their own (separation of duty).
      if (app.firstApprovedBy && app.firstApprovedBy === reviewerId) {
        return {
          error: {
            status: 409,
            body: {
              error: "Conflict",
              message:
                "You already gave the first approval. A second, different admin must give the final approval.",
            },
          },
        };
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

      // NOTE: the Employee profile row and License row are intentionally NOT
      // created here. Per product policy the full employee profile is only
      // materialized when the candidate COMPLETES onboarding
      // (POST /onboarding/:token), which builds the employee row from the
      // application data + the onboarding submission in one place. Final
      // approval only creates the login account (status=pending) so the
      // candidate appears in Personnel and can be issued an onboarding link.

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
        secondApprovedBy: reviewerId,
        secondApprovedAt: new Date(),
        createdEmployeeId: userId,
      }).where(eq(applicationsTable.id, appId)).returning();

      return { kind: "second", updated, userId, tempPasswordPlain };
    });
  } catch (err) {
    req.log.error({ err }, "Approve transaction failed");
    res.status(500).json({ error: "Internal Server Error", message: "Approval failed" });
    return;
  }

  if ("error" in result) { res.status(result.error.status).json(result.error.body); return; }

  // First approval recorded — no provisioning, no onboarding email yet. Return
  // the updated application so the admin UI can reflect "awaiting second
  // approval" and surface who gave the first sign-off.
  if (result.kind === "first") {
    res.json({
      application: rowToApplication(result.updated),
      awaitingSecondApproval: true,
      firstApprovedBy: result.updated.firstApprovedBy,
    });
    return;
  }

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
    // Sending the application back for more info resets the two-admin approval
    // gate — any prior approvals are no longer valid once the applicant's data
    // can change, so both admins must re-approve the updated submission.
    firstApprovedBy: null,
    firstApprovedAt: null,
    secondApprovedBy: null,
    secondApprovedAt: null,
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
    // Bump back to under_review so admin sees it ready to re-evaluate, and
    // reset the two-admin approval gate: the applicant just changed their data,
    // so any prior approvals are stale and both admins must re-approve.
    await tx.update(applicationsTable).set({
      status: "under_review",
      firstApprovedBy: null,
      firstApprovedAt: null,
      secondApprovedBy: null,
      secondApprovedAt: null,
    }).where(eq(applicationsTable.id, t.applicationId));
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

  // Build the full employee profile now — onboarding completion is the FIRST
  // time the employee row is materialized (creation is deferred from approval
  // per product policy). We merge the application-sourced profile (phone,
  // address, licence details, geocoded home coords, etc.) with the onboarding
  // submission fields so admins see the complete profile in the Employees grid.
  let app: ApplicationRow | null = null;
  if (t.applicationId) {
    const [a] = await db.select().from(applicationsTable).where(eq(applicationsTable.id, t.applicationId)).limit(1);
    app = a ?? null;
  }

  const employeeFields = {
    // ---- application-sourced profile (previously written at approval time) ----
    phone: app?.phone ?? null,
    address: app?.address ?? null,
    dateOfBirth: app?.dateOfBirth ?? null,
    cityOfBirth: app?.cityOfBirth ?? null,
    stateOfBirth: app?.stateOfBirth ?? null,
    rightToWorkStatus: app?.rightToWorkStatus ?? null,
    rightToWorkDocKey: app?.rightToWorkDocKey ?? null,
    siaLicenseNumber: app?.siaLicenseNumber ?? null,
    siaLicenseLevel: app?.siaLicenseLevel ?? null,
    siaLicenseExpiry: app?.siaLicenseExpiry ?? null,
    previousExperience: app?.previousExperience ?? null,
    yearsExperience: app?.yearsExperience ?? null,
    references: app?.references ?? null,
    photoKey: app?.photoKey ?? null,
    cvKey: app?.cvKey ?? null,
    trainingCertificateKeys: app?.trainingCertificateKeys ?? null,
    availability: app?.availability ?? null,
    applicationId: app?.id ?? null,
    // Mirror the applicant's geocoded home coords so the mobile open-shifts
    // "distance from home" sort works on day one for the new officer.
    homeLat: app?.locationLat ?? null,
    homeLng: app?.locationLng ?? null,
    lastGeocodedAddress: app && app.locationLat != null ? app.address : null,
    // ---- onboarding-submission fields ----
    bankAccountName: d.bankAccountName,
    bankAccountNumber: d.bankAccountNumber,
    bankBsb: d.bankSortCode,
    // Prefer the NI/SSN value the applicant reconfirmed during onboarding;
    // fall back to what they supplied on the application so we don't blank it.
    niNumber: d.niNumberConfirmed ?? app?.niNumber ?? null,
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
  };

  // Create-or-update: for the normal flow the employee row does not exist yet,
  // but a re-onboard of a previously-active officer may already have one.
  const [existingEmployee] = await db.select().from(employeesTable).where(eq(employeesTable.userId, t.employeeId)).limit(1);
  if (existingEmployee) {
    await db.update(employeesTable).set(employeeFields).where(eq(employeesTable.userId, t.employeeId));
  } else {
    await db.insert(employeesTable).values({ userId: t.employeeId, ...employeeFields });
  }

  // Materialize the licence row from the applicant's declared TX licence info.
  // This was previously created at approval; it now lives here so the employee
  // profile + licence appear together only once onboarding completes. Guarded
  // by an existence check so a re-onboard does not create duplicate licences.
  // Missing fields are stored as a 30-day placeholder so admin sees an
  // "expiring soon" row to verify and complete.
  const hasAnyLicenceInfo =
    !!app?.siaLicenseNumber || app?.siaLicenseLevel != null || !!app?.siaLicenseExpiry;
  if (hasAnyLicenceInfo) {
    const [existingLicense] = await db.select().from(licensesTable).where(eq(licensesTable.employeeId, t.employeeId)).limit(1);
    if (!existingLicense) {
      const placeholderExpiry = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
        .toISOString().slice(0, 10);
      await db.insert(licensesTable).values({
        employeeId: t.employeeId,
        type: "SIA",
        level: app?.siaLicenseLevel ?? null,
        licenseNumber: app?.siaLicenseNumber || "PENDING-VERIFICATION",
        issuingAuthority: "SIA",
        expiryDate: app?.siaLicenseExpiry || placeholderExpiry,
      });
    }
  }

  // Activate user, mark token consumed
  await db.update(usersTable).set({ status: "active" }).where(eq(usersTable.id, t.employeeId));
  await db.update(onboardingTokensTable).set({ consumedAt: new Date() }).where(eq(onboardingTokensTable.id, t.id));

  // Notify the dedicated admin inbox that onboarding is complete.
  try {
    const [completedUser] = await db
      .select({ firstName: usersTable.firstName, lastName: usersTable.lastName, email: usersTable.email })
      .from(usersTable)
      .where(eq(usersTable.id, t.employeeId))
      .limit(1);
    const officerName = completedUser
      ? ([completedUser.firstName, completedUser.lastName].filter(Boolean).join(" ") || completedUser.email || "An employee")
      : "An employee";
    const base = process.env.APP_BASE_URL
      || (process.env.REPLIT_DOMAINS ? `https://${process.env.REPLIT_DOMAINS.split(",")[0]}` : "");
    const tmpl = renderOnboardingCompletedAdminEmail({
      officerName,
      reviewUrl: base ? `${base}/admin-portal/hr/onboarding` : undefined,
    });
    void sendEmail({ to: brand.adminNotifyEmail, subject: tmpl.subject, text: tmpl.text, html: tmpl.html })
      .catch((err) => req.log.warn({ err, employeeId: t.employeeId }, "onboarding-completed admin email failed"));
  } catch (mailErr) {
    req.log.warn({ err: mailErr, employeeId: t.employeeId }, "Failed to send onboarding-completed admin email");
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

// Delete a person who is still in onboarding. Restricted to accounts that are
// genuinely onboarding-stage: role must be `employee` and status must still be
// `pending` (onboarding completion flips the user to `active`). Anything else
// is refused with 409 — active staff must be deactivated/managed through the
// Personnel tables, never silently erased from the onboarding list. The user
// row is the cascade root: deleting it removes the employees row, onboarding
// tokens, and any onboarding submission (all FK ON DELETE CASCADE); other
// users-referencing tables are cascade or SET NULL, so the delete cannot
// strand orphans.
router.delete("/admin/onboarding/:employeeId", requireAdmin, async (req, res): Promise<void> => {
  const employeeId = req.params.employeeId as string;
  if (!z.string().uuid().safeParse(employeeId).success) {
    res.status(404).json({ error: "Not Found", message: "Employee not found" });
    return;
  }
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, employeeId)).limit(1);
  if (!user) { res.status(404).json({ error: "Not Found", message: "Employee not found" }); return; }

  if (user.role !== "employee") {
    res.status(409).json({
      error: "Conflict",
      message: "Only onboarding-stage employee accounts can be deleted here. Manage other accounts from the Personnel tables.",
    });
    return;
  }
  if (user.status !== "pending") {
    res.status(409).json({
      error: "Conflict",
      message: `This account is ${user.status}, not pending onboarding. Deactivate or manage it from the Personnel tables instead.`,
    });
    return;
  }

  // Leave a self-contained audit trail: once the row is gone, the URL's UUID
  // alone would be meaningless.
  res.locals["auditMetadata"] = {
    deletedUser: { id: user.id, email: user.email, firstName: user.firstName, lastName: user.lastName, role: user.role, status: user.status },
  };

  await db.transaction(async (tx) => {
    // Un-strand the originating application (applications.created_employee_id
    // has no FK, so it would dangle): clear the employee link, both two-admin
    // sign-offs, and the onboarding-email delivery state, and send the row
    // back to `under_review` so HR can re-approve or reject it later instead
    // of it being frozen as "approved" for a person who no longer exists.
    const reset = await tx.update(applicationsTable).set({
      status: "under_review",
      createdEmployeeId: null,
      firstApprovedBy: null,
      firstApprovedAt: null,
      secondApprovedBy: null,
      secondApprovedAt: null,
      onboardingEmailStatus: null,
      onboardingEmailMessageId: null,
      onboardingEmailResponse: null,
      onboardingEmailError: null,
      onboardingEmailSentAt: null,
      onboardingEmailAttemptedAt: null,
    }).where(eq(applicationsTable.createdEmployeeId, employeeId))
      .returning({ id: applicationsTable.id });
    if (reset.length > 0) {
      (res.locals["auditMetadata"] as Record<string, unknown>)["resetApplicationIds"] = reset.map((r) => r.id);
    }
    await tx.delete(usersTable).where(eq(usersTable.id, employeeId));
  });
  req.log.info({ employeeId, email: user.email }, "Deleted pending-onboarding employee");
  res.status(204).end();
});

export default router;
