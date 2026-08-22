import { GoogleGenAI, Type } from "@google/genai";
import type { Logger } from "pino";

/**
 * AI-assisted single-employee extraction from an uploaded PDF
 * (a resume / CV or a filled job-application form).
 *
 * Uses Replit's AI Integrations service (Gemini-compatible) — no project API
 * key is required; the client is configured from the auto-provisioned
 * `AI_INTEGRATIONS_GEMINI_*` env vars and billed to the deployment's credits.
 *
 * The model output is treated as UNTRUSTED: every field is run through a strict
 * normalizer (`normalizeEmployeeDraft`) that trims, validates and drops
 * anything malformed, surfacing human-readable `warnings` instead of trusting
 * the raw JSON. The same normalizer re-validates the admin-edited form on
 * commit, so there is exactly one validation contract for the draft shape.
 */

/** The editable shape the wizard renders and the commit route consumes. */
export type EmployeeDraft = {
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
  address?: string;
  /** ISO 8601 calendar date, `YYYY-MM-DD`. */
  dateOfBirth?: string;
  cityOfBirth?: string;
  stateOfBirth?: string;
  emergencyContactName?: string;
  emergencyContactRelationship?: string;
  emergencyContactPhone?: string;
  siaLicenseNumber?: string;
  /** Texas security license level, integer 1–4. */
  siaLicenseLevel?: number;
  /** ISO 8601 calendar date, `YYYY-MM-DD`. */
  siaLicenseExpiry?: string;
  previousExperience?: string;
  yearsExperience?: number;
};

export type ExtractResult = { draft: EmployeeDraft; warnings: string[] };

/** Keys whose values are free-text and only need trimming. */
const TEXT_KEYS = [
  "firstName",
  "lastName",
  "phone",
  "address",
  "cityOfBirth",
  "stateOfBirth",
  "emergencyContactName",
  "emergencyContactRelationship",
  "emergencyContactPhone",
  "siaLicenseNumber",
  "previousExperience",
] as const;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function cleanStr(v: unknown): string | undefined {
  if (typeof v !== "string") {
    if (typeof v === "number" && Number.isFinite(v)) return String(v);
    return undefined;
  }
  const t = v.trim();
  return t === "" || t.toLowerCase() === "null" ? undefined : t;
}

/** Validate (and canonicalise) a `YYYY-MM-DD` date, tolerating other parseable forms. */
function cleanIsoDate(v: unknown, label: string, warnings: string[]): string | undefined {
  const s = cleanStr(v);
  if (s === undefined) return undefined;
  let iso: string | undefined;
  if (ISO_DATE_RE.test(s)) {
    iso = s;
  } else {
    const d = new Date(s);
    if (!Number.isNaN(d.getTime())) iso = d.toISOString().slice(0, 10);
  }
  if (iso !== undefined) {
    // Round-trip guard: reject impossible calendar dates (e.g. "2024-02-31",
    // which `Date` silently rolls forward to March 2) so a malformed value
    // never reaches the Postgres `date` column.
    const d = new Date(`${iso}T00:00:00Z`);
    if (!Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === iso) return iso;
  }
  warnings.push(`${label} "${s}" was not a recognisable date and was left blank.`);
  return undefined;
}

function cleanInt(
  v: unknown,
  label: string,
  min: number,
  max: number,
  warnings: string[],
): number | undefined {
  const s = cleanStr(v);
  if (s === undefined) return undefined;
  const n = Number(s);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < min || n > max) {
    warnings.push(`${label} "${s}" was out of range and was left blank.`);
    return undefined;
  }
  return n;
}

/**
 * Normalize an arbitrary object (AI output OR admin-edited form fields) into a
 * clean `EmployeeDraft`. Invalid values are dropped with a warning rather than
 * trusted — never throws.
 */
export function normalizeEmployeeDraft(raw: unknown): ExtractResult {
  const warnings: string[] = [];
  const draft: EmployeeDraft = {};
  const obj = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;

  for (const k of TEXT_KEYS) {
    const v = cleanStr(obj[k]);
    if (v !== undefined) draft[k] = v;
  }

  const email = cleanStr(obj.email);
  if (email !== undefined) {
    const lower = email.toLowerCase();
    if (EMAIL_RE.test(lower)) draft.email = lower;
    else warnings.push(`Email "${email}" did not look valid and was left blank.`);
  }

  const dob = cleanIsoDate(obj.dateOfBirth, "Date of birth", warnings);
  if (dob !== undefined) draft.dateOfBirth = dob;

  const expiry = cleanIsoDate(obj.siaLicenseExpiry, "License expiry", warnings);
  if (expiry !== undefined) draft.siaLicenseExpiry = expiry;

  const level = cleanInt(obj.siaLicenseLevel, "License level", 1, 4, warnings);
  if (level !== undefined) draft.siaLicenseLevel = level;

  const years = cleanInt(obj.yearsExperience, "Years of experience", 0, 80, warnings);
  if (years !== undefined) draft.yearsExperience = years;

  return { draft, warnings };
}

/** JSON schema handed to Gemini so it returns a predictable object shape. */
const RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    firstName: { type: Type.STRING, nullable: true },
    lastName: { type: Type.STRING, nullable: true },
    email: { type: Type.STRING, nullable: true },
    phone: { type: Type.STRING, nullable: true },
    address: { type: Type.STRING, nullable: true },
    dateOfBirth: { type: Type.STRING, nullable: true, description: "ISO 8601 date YYYY-MM-DD" },
    cityOfBirth: { type: Type.STRING, nullable: true },
    stateOfBirth: { type: Type.STRING, nullable: true },
    emergencyContactName: { type: Type.STRING, nullable: true },
    emergencyContactRelationship: { type: Type.STRING, nullable: true },
    emergencyContactPhone: { type: Type.STRING, nullable: true },
    siaLicenseNumber: { type: Type.STRING, nullable: true },
    siaLicenseLevel: {
      type: Type.INTEGER,
      nullable: true,
      description: "Texas security license level 1-4 (2=unarmed, 3=armed, 4=PPO/manager)",
    },
    siaLicenseExpiry: { type: Type.STRING, nullable: true, description: "ISO 8601 date YYYY-MM-DD" },
    previousExperience: { type: Type.STRING, nullable: true },
    yearsExperience: { type: Type.INTEGER, nullable: true },
  },
} as const;

const PROMPT = [
  "You extract structured data for ONE person from the attached document, which is",
  "either a resume/CV or a filled-out job-application form for a private security",
  "company operating in Texas, USA.",
  "",
  "Return ONLY the fields you can find in the document. If a field is not present,",
  "return null for it — never invent or guess values.",
  "",
  "Guidance:",
  "- email: the applicant's own email address (lowercase).",
  "- phone / emergencyContactPhone: keep the digits as written; include country code if shown.",
  "- dateOfBirth, siaLicenseExpiry: format as YYYY-MM-DD.",
  "- siaLicenseLevel: integer 1-4 for the Texas security license (1=support staff,",
  "  2=unarmed, 3=armed, 4=PPO/manager). Use null if no security license is mentioned.",
  "- yearsExperience: whole number of years of security/relevant experience.",
  "- previousExperience: a short free-text summary of prior roles.",
].join("\n");

const MODEL = "gemini-3.6-flash";
const REQUEST_TIMEOUT_MS = 45_000;
const MAX_ATTEMPTS = 2;

let client: GoogleGenAI | null = null;

/**
 * Lazily build the Gemini client. Throws a `__serviceUnavailable`-tagged error
 * when the AI Integration env vars are absent so the route can answer 503
 * rather than 500.
 */
function getClient(): GoogleGenAI {
  const apiKey = process.env.AI_INTEGRATIONS_GEMINI_API_KEY;
  const baseUrl = process.env.AI_INTEGRATIONS_GEMINI_BASE_URL;
  if (!apiKey || !baseUrl) {
    throw Object.assign(
      new Error("AI extraction is not configured on this deployment."),
      { __serviceUnavailable: true },
    );
  }
  if (!client) {
    client = new GoogleGenAI({ apiKey, httpOptions: { apiVersion: "", baseUrl } });
  }
  return client;
}

/**
 * Run one Gemini request with an abort-signal timeout. Returns the raw JSON
 * text, or throws.
 */
async function callGemini(base64Pdf: string): Promise<string> {
  const ai = getClient();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await ai.models.generateContent({
      model: MODEL,
      contents: [
        {
          role: "user",
          parts: [
            { inlineData: { mimeType: "application/pdf", data: base64Pdf } },
            { text: PROMPT },
          ],
        },
      ],
      config: {
        responseMimeType: "application/json",
        responseSchema: RESPONSE_SCHEMA,
        temperature: 0,
        abortSignal: controller.signal,
      },
    });
    return response.text ?? "";
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Extract a single employee's fields from a PDF buffer. The returned draft is
 * already normalized/validated; `warnings` lists anything the model produced
 * that we could not trust plus any required fields it missed.
 */
export async function extractEmployeeFromPdf(
  pdfBuffer: Buffer,
  log?: Logger,
): Promise<ExtractResult> {
  const base64Pdf = pdfBuffer.toString("base64");

  let lastErr: unknown;
  let text = "";
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      text = await callGemini(base64Pdf);
      lastErr = undefined;
      break;
    } catch (err) {
      lastErr = err;
      log?.warn({ err, attempt }, "gemini PDF extraction attempt failed");
    }
  }
  if (lastErr !== undefined) {
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("The AI response was not valid JSON.");
  }

  const result = normalizeEmployeeDraft(parsed);

  // Surface the high-value gaps so the admin knows what to fill in before save.
  if (!result.draft.firstName || !result.draft.lastName) {
    result.warnings.push("Could not read a full name — please enter it before saving.");
  }
  if (!result.draft.email) {
    result.warnings.push("Could not read an email address — required to create or match an employee.");
  }

  return result;
}
