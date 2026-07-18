import { cloneElement, isValidElement, useEffect, useId, useRef, useState, type ReactElement, type ReactNode } from "react";
import { api, ApiError } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { BrandHeader } from "@/components/BrandHeader";
import { FileUploadField, MultiFileUploadField } from "@/components/FileUploadField";
import { uploadFileAnon, type UploadedFile } from "@/lib/upload";
import { CheckCircle2, ChevronLeft, ChevronRight } from "lucide-react";

// Match the server-side normalizer in artifacts/api-server/src/lib/phone.ts.
function normalizePhoneToE164(input: string): string | null {
  if (typeof input !== "string") return null;
  const trimmed = input.trim();
  if (!trimmed) return null;
  const hadPlus = trimmed.startsWith("+");
  const digits = trimmed.replace(/\D/g, "");
  if (!digits) return null;
  let candidate: string;
  if (hadPlus) candidate = `+${digits}`;
  else if (digits.length === 10) candidate = `+1${digits}`;
  else if (digits.length === 11 && digits.startsWith("1")) candidate = `+${digits}`;
  else return null;
  return /^\+\d{8,15}$/.test(candidate) ? candidate : null;
}

const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
const DAY_LABELS: Record<typeof DAYS[number], string> = {
  mon: "Monday", tue: "Tuesday", wed: "Wednesday", thu: "Thursday",
  fri: "Friday", sat: "Saturday", sun: "Sunday",
};
const PERIODS = ["morning", "afternoon", "evening", "overnight"] as const;
type Day = (typeof DAYS)[number];
type Period = (typeof PERIODS)[number];

type Reference = { name: string; relationship: string; phone: string; email: string };
type Form = {
  firstName: string; lastName: string; email: string; phone: string;
  address: string; city: string; state: string; zip: string;
  dateOfBirth: string; cityOfBirth: string; stateOfBirth: string; niNumber: string;
  i9Doc: UploadedFile | null;
  ssnCardDoc: UploadedFile | null;
  idDocType: "" | "drivers_license" | "passport";
  idDoc: UploadedFile | null;
  siaLicenseNumber: string;
  siaLicenseLevel: string;
  siaLicenseExpiry: string;
  previousExperience: string;
  yearsExperience: string;
  references: Reference[];
  photo: UploadedFile | null;
  cv: UploadedFile | null;
  trainingCertificates: UploadedFile[];
  availability: { day: Day; period: Period }[];
  customAnswers: Record<string, unknown>;
};

const CUSTOM_FIELD_TYPES = ["short_text", "long_text", "number", "date", "select", "multiselect", "yes_no"] as const;
type CustomFieldType = (typeof CUSTOM_FIELD_TYPES)[number];
type TemplateQuestion = {
  id: string;
  label: string;
  helpText: string | null;
  fieldType: CustomFieldType;
  required: boolean;
  options: string[] | null;
  sortOrder: number;
  enabled: boolean;
};

// Effective per-field config returned by GET /application-template (built-in
// fields only, already filtered to the visible ones and sorted section→order).
type EffectiveField = {
  key: string;
  section: number;
  label: string;
  helpText: string | null;
  required: boolean;
  hidden: boolean;
  sortOrder: number;
  locked: boolean;
};

// Client mirror of the server registry
// (artifacts/api-server/src/lib/applicationFields.ts). Used as the fallback
// when /application-template can't be reached, and to default each field's
// label/required when no override row exists.
const CLIENT_FIELD_DEFS: Array<{ key: string; section: number; defaultLabel: string; defaultHelp: string | null; defaultRequired: boolean; locked: boolean }> = [
  { key: "firstName", section: 0, defaultLabel: "First name", defaultHelp: null, defaultRequired: true, locked: true },
  { key: "lastName", section: 0, defaultLabel: "Last name", defaultHelp: null, defaultRequired: true, locked: true },
  { key: "email", section: 0, defaultLabel: "Email", defaultHelp: null, defaultRequired: true, locked: true },
  { key: "phone", section: 0, defaultLabel: "Phone", defaultHelp: null, defaultRequired: true, locked: true },
  { key: "address", section: 0, defaultLabel: "Street address", defaultHelp: null, defaultRequired: true, locked: true },
  { key: "city", section: 0, defaultLabel: "City", defaultHelp: null, defaultRequired: true, locked: false },
  { key: "state", section: 0, defaultLabel: "State", defaultHelp: null, defaultRequired: true, locked: false },
  { key: "zip", section: 0, defaultLabel: "ZIP code", defaultHelp: null, defaultRequired: true, locked: false },
  { key: "dateOfBirth", section: 0, defaultLabel: "Date of birth", defaultHelp: null, defaultRequired: true, locked: false },
  { key: "niNumber", section: 0, defaultLabel: "SSN (last 4)", defaultHelp: null, defaultRequired: true, locked: false },
  { key: "cityOfBirth", section: 0, defaultLabel: "City of birth", defaultHelp: null, defaultRequired: true, locked: false },
  { key: "stateOfBirth", section: 0, defaultLabel: "State / county of birth", defaultHelp: null, defaultRequired: true, locked: false },
  { key: "i9Doc", section: 1, defaultLabel: "Completed Form I-9 (PDF or photos of all pages)", defaultHelp: null, defaultRequired: true, locked: false },
  { key: "ssnCardDoc", section: 1, defaultLabel: "Social Security card (photo of front)", defaultHelp: null, defaultRequired: true, locked: false },
  { key: "idDocType", section: 1, defaultLabel: "Photo ID type", defaultHelp: null, defaultRequired: true, locked: false },
  { key: "idDoc", section: 1, defaultLabel: "Photo ID", defaultHelp: null, defaultRequired: true, locked: false },
  { key: "siaLicenseNumber", section: 2, defaultLabel: "TX security license number", defaultHelp: null, defaultRequired: true, locked: false },
  { key: "siaLicenseLevel", section: 2, defaultLabel: "License level", defaultHelp: null, defaultRequired: true, locked: false },
  { key: "siaLicenseExpiry", section: 2, defaultLabel: "License expiry", defaultHelp: null, defaultRequired: true, locked: false },
  { key: "yearsExperience", section: 2, defaultLabel: "Years of experience", defaultHelp: null, defaultRequired: true, locked: false },
  { key: "previousExperience", section: 2, defaultLabel: "Describe your previous security experience", defaultHelp: null, defaultRequired: true, locked: false },
  { key: "references", section: 3, defaultLabel: "References", defaultHelp: null, defaultRequired: true, locked: false },
  { key: "photo", section: 3, defaultLabel: "Head & shoulders photo", defaultHelp: null, defaultRequired: true, locked: false },
  { key: "cv", section: 3, defaultLabel: "Resume (PDF / DOC)", defaultHelp: null, defaultRequired: true, locked: false },
  { key: "trainingCertificates", section: 3, defaultLabel: "Training certificates", defaultHelp: null, defaultRequired: true, locked: false },
  { key: "availability", section: 4, defaultLabel: "Availability", defaultHelp: null, defaultRequired: true, locked: false },
];

const CLIENT_DEFAULT_FIELDS: EffectiveField[] = (() => {
  const counters = new Map<number, number>();
  return CLIENT_FIELD_DEFS.map((d) => {
    const n = counters.get(d.section) ?? 0;
    counters.set(d.section, n + 1);
    return {
      key: d.key, section: d.section, label: d.defaultLabel, helpText: d.defaultHelp,
      required: d.defaultRequired, hidden: false, sortOrder: n, locked: d.locked,
    };
  });
})();
const CLIENT_DEFAULTS_BY_KEY = new Map(CLIENT_DEFAULT_FIELDS.map((f) => [f.key, f]));

// Base wizard steps; an "Additional questions" step is spliced in before
// "Review" at runtime when the admin has defined custom questions.
const BASE_STEPS = ["Personal", "I-9 & Identity", "TX License & experience", "References & docs", "Availability"];

const I9_FORM_URL = "https://www.uscis.gov/sites/default/files/document/forms/i-9.pdf";

// US states + DC as { code, name } for the State dropdown. A constrained
// select (rather than a free-text input) guarantees a valid 2-letter code
// reaches the server and removes the autofill / maxLength desync that let
// applicants believe they'd filled the field while React state stayed empty.
const US_STATES: ReadonlyArray<{ code: string; name: string }> = [
  { code: "AL", name: "Alabama" }, { code: "AK", name: "Alaska" },
  { code: "AZ", name: "Arizona" }, { code: "AR", name: "Arkansas" },
  { code: "CA", name: "California" }, { code: "CO", name: "Colorado" },
  { code: "CT", name: "Connecticut" }, { code: "DE", name: "Delaware" },
  { code: "DC", name: "District of Columbia" }, { code: "FL", name: "Florida" },
  { code: "GA", name: "Georgia" }, { code: "HI", name: "Hawaii" },
  { code: "ID", name: "Idaho" }, { code: "IL", name: "Illinois" },
  { code: "IN", name: "Indiana" }, { code: "IA", name: "Iowa" },
  { code: "KS", name: "Kansas" }, { code: "KY", name: "Kentucky" },
  { code: "LA", name: "Louisiana" }, { code: "ME", name: "Maine" },
  { code: "MD", name: "Maryland" }, { code: "MA", name: "Massachusetts" },
  { code: "MI", name: "Michigan" }, { code: "MN", name: "Minnesota" },
  { code: "MS", name: "Mississippi" }, { code: "MO", name: "Missouri" },
  { code: "MT", name: "Montana" }, { code: "NE", name: "Nebraska" },
  { code: "NV", name: "Nevada" }, { code: "NH", name: "New Hampshire" },
  { code: "NJ", name: "New Jersey" }, { code: "NM", name: "New Mexico" },
  { code: "NY", name: "New York" }, { code: "NC", name: "North Carolina" },
  { code: "ND", name: "North Dakota" }, { code: "OH", name: "Ohio" },
  { code: "OK", name: "Oklahoma" }, { code: "OR", name: "Oregon" },
  { code: "PA", name: "Pennsylvania" }, { code: "RI", name: "Rhode Island" },
  { code: "SC", name: "South Carolina" }, { code: "SD", name: "South Dakota" },
  { code: "TN", name: "Tennessee" }, { code: "TX", name: "Texas" },
  { code: "UT", name: "Utah" }, { code: "VT", name: "Vermont" },
  { code: "VA", name: "Virginia" }, { code: "WA", name: "Washington" },
  { code: "WV", name: "West Virginia" }, { code: "WI", name: "Wisconsin" },
  { code: "WY", name: "Wyoming" },
];

type FieldError = { field?: string; message: string };

const FIELD_TO_STEP: Record<string, number> = {
  firstName: 0, lastName: 0, email: 0, phone: 0,
  address: 0, city: 0, state: 0, zip: 0,
  dateOfBirth: 0, cityOfBirth: 0, stateOfBirth: 0, niNumber: 0,
  i9Doc: 1, ssnCardDoc: 1, idDocType: 1, idDoc: 1,
  siaLicenseNumber: 2, siaLicenseLevel: 2, siaLicenseExpiry: 2,
  yearsExperience: 2, previousExperience: 2,
  photo: 3, cv: 3, trainingCertificates: 3,
  availability: 4,
};
function stepForField(field: string | undefined): number {
  if (!field) return 5;
  if (field.startsWith("ref:")) return 3;
  return FIELD_TO_STEP[field] ?? 5;
}

function findFieldError(name: string | undefined, errors: FieldError[]): FieldError | undefined {
  if (!name) return undefined;
  return errors.find((e) => e.field === name);
}

const EMPTY_FORM: Form = {
  firstName: "", lastName: "", email: "", phone: "",
  address: "", city: "", state: "", zip: "",
  dateOfBirth: "", cityOfBirth: "", stateOfBirth: "", niNumber: "",
  i9Doc: null, ssnCardDoc: null, idDocType: "", idDoc: null,
  siaLicenseNumber: "", siaLicenseLevel: "", siaLicenseExpiry: "",
  previousExperience: "", yearsExperience: "",
  references: [
    { name: "", relationship: "", phone: "", email: "" },
    { name: "", relationship: "", phone: "", email: "" },
  ],
  photo: null, cv: null, trainingCertificates: [],
  availability: [],
  customAnswers: {},
};

// Defensive hydrator. Server stores the wizard state verbatim in jsonb,
// so we coerce each field back into the expected shape before priming
// React state — drops anything we don't recognize so a stale or
// tampered draft can't crash the form.
function hydrateForm(raw: unknown): Form {
  const d = (raw ?? {}) as Record<string, unknown>;
  const str = (k: string) => (typeof d[k] === "string" ? (d[k] as string) : "");
  const file = (k: string): UploadedFile | null => {
    const v = d[k];
    if (!v || typeof v !== "object") return null;
    const o = v as Partial<UploadedFile>;
    if (typeof o.objectPath !== "string" || typeof o.name !== "string") return null;
    return {
      name: o.name,
      objectPath: o.objectPath,
      contentType: typeof o.contentType === "string" ? o.contentType : "application/octet-stream",
      size: typeof o.size === "number" ? o.size : 0,
    };
  };
  const fileArray = (k: string): UploadedFile[] => {
    const v = d[k];
    if (!Array.isArray(v)) return [];
    return v
      .map((entry): UploadedFile | null => {
        if (!entry || typeof entry !== "object") return null;
        const o = entry as Partial<UploadedFile>;
        if (typeof o.objectPath !== "string" || typeof o.name !== "string") return null;
        return {
          name: o.name,
          objectPath: o.objectPath,
          contentType: typeof o.contentType === "string" ? o.contentType : "application/octet-stream",
          size: typeof o.size === "number" ? o.size : 0,
        };
      })
      .filter((x): x is UploadedFile => x !== null);
  };
  const refs = Array.isArray(d.references) ? d.references : [];
  const referenceRows: Reference[] = [0, 1].map((i) => {
    const r = (refs[i] ?? {}) as Partial<Reference>;
    return {
      name: typeof r.name === "string" ? r.name : "",
      relationship: typeof r.relationship === "string" ? r.relationship : "",
      phone: typeof r.phone === "string" ? r.phone : "",
      email: typeof r.email === "string" ? r.email : "",
    };
  });
  const availabilityRaw = Array.isArray(d.availability) ? d.availability : [];
  const availability = availabilityRaw
    .map((c): { day: Day; period: Period } | null => {
      if (!c || typeof c !== "object") return null;
      const o = c as { day?: unknown; period?: unknown };
      if (typeof o.day !== "string" || typeof o.period !== "string") return null;
      if (!DAYS.includes(o.day as Day)) return null;
      if (!PERIODS.includes(o.period as Period)) return null;
      return { day: o.day as Day, period: o.period as Period };
    })
    .filter((x): x is { day: Day; period: Period } => x !== null);
  const idDocTypeRaw = str("idDocType");
  return {
    firstName: str("firstName"), lastName: str("lastName"), email: str("email"), phone: str("phone"),
    address: str("address"), city: str("city"), state: str("state"), zip: str("zip"),
    dateOfBirth: str("dateOfBirth"), cityOfBirth: str("cityOfBirth"), stateOfBirth: str("stateOfBirth"),
    niNumber: str("niNumber"),
    i9Doc: file("i9Doc"), ssnCardDoc: file("ssnCardDoc"),
    idDocType: (idDocTypeRaw === "drivers_license" || idDocTypeRaw === "passport") ? idDocTypeRaw : "",
    idDoc: file("idDoc"),
    siaLicenseNumber: str("siaLicenseNumber"),
    siaLicenseLevel: str("siaLicenseLevel"),
    siaLicenseExpiry: str("siaLicenseExpiry"),
    previousExperience: str("previousExperience"),
    yearsExperience: str("yearsExperience"),
    references: referenceRows,
    photo: file("photo"), cv: file("cv"),
    trainingCertificates: fileArray("trainingCertificates"),
    availability,
    customAnswers: (d.customAnswers && typeof d.customAnswers === "object" && !Array.isArray(d.customAnswers))
      ? (d.customAnswers as Record<string, unknown>)
      : {},
  };
}

type SaveState =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "sent"; emailSent: boolean; toEmail: string }
  | { kind: "error"; message: string };

export function ApplyPage() {
  const [step, setStep] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<FieldError[]>([]);
  const [generalError, setGeneralError] = useState<string | null>(null);
  const [resumeLoading, setResumeLoading] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return new URLSearchParams(window.location.search).has("resume");
  });
  const [resumeError, setResumeError] = useState<string | null>(null);
  const [resumed, setResumed] = useState(false);
  const [draftToken, setDraftToken] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<SaveState>({ kind: "idle" });
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  // Skip focusing the heading on the initial mount so first-time visitors
  // aren't yanked past the brand header. After any subsequent step change
  // we focus the new heading and announce it.
  const initialMount = useRef(true);

  const [form, setForm] = useState<Form>(EMPTY_FORM);
  const [questions, setQuestions] = useState<TemplateQuestion[]>([]);
  // Effective built-in field config. Starts as the static defaults so the form
  // renders immediately; replaced by the admin's overrides once the template
  // loads. Hidden fields are absent from this list (the server filters them).
  const [fields, setFields] = useState<EffectiveField[]>(CLIENT_DEFAULT_FIELDS);

  // ---- Built-in field config helpers --------------------------------------
  const fieldMap = new Map(fields.map((f) => [f.key, f]));
  // A built-in field is visible iff it's present in the effective config
  // (the server omits hidden fields from the template response).
  const visibleField = (key: string): boolean => fieldMap.has(key);
  const cfgOf = (key: string): EffectiveField =>
    fieldMap.get(key) ?? CLIENT_DEFAULTS_BY_KEY.get(key)!;
  const labelOf = (key: string): string => cfgOf(key).label;
  const helpOf = (key: string): string | null => cfgOf(key).helpText;
  // Required only matters for visible fields; a hidden field is never enforced.
  const isReq = (key: string): boolean => visibleField(key) && cfgOf(key).required;
  // Whether the admin renamed a field away from its default label (used to
  // decide if a dynamic default label like the photo-ID prompt still applies).
  const isRelabeled = (key: string): boolean =>
    cfgOf(key).label !== (CLIENT_DEFAULTS_BY_KEY.get(key)?.label ?? "");
  const orderedKeys = (section: number): string[] =>
    [...fields]
      .filter((f) => f.section === section)
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map((f) => f.key);

  // Admin-defined custom questions get their own step before Review.
  const hasCustom = questions.length > 0;
  const STEPS = hasCustom ? [...BASE_STEPS, "Additional questions", "Review"] : [...BASE_STEPS, "Review"];
  const CUSTOM_STEP = BASE_STEPS.length; // 5
  const REVIEW_STEP = STEPS.length - 1;
  // Map a (possibly server-sent) field name to its wizard step. Custom-answer
  // errors come back as "custom:<questionId>".
  const localStepForField = (field?: string): number => {
    if (field && field.startsWith("custom:")) return hasCustom ? CUSTOM_STEP : REVIEW_STEP;
    const b = stepForField(field);
    return b === 5 ? REVIEW_STEP : b;
  };

  // Load the admin-defined custom questions. Non-fatal: the form still works
  // (built-in fields only) if this fails or returns nothing.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const out = await api<{ questions?: TemplateQuestion[]; fieldConfig?: EffectiveField[] } | TemplateQuestion[]>(
          "/application-template",
        );
        if (cancelled) return;
        // New shape: { questions, fieldConfig }. Tolerate the legacy array shape.
        if (Array.isArray(out)) {
          setQuestions(out);
        } else {
          if (Array.isArray(out.questions)) setQuestions(out.questions);
          if (Array.isArray(out.fieldConfig) && out.fieldConfig.length > 0) {
            setFields(out.fieldConfig);
          }
        }
      } catch {
        /* ignore — keep default field config + no custom questions */
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // On mount, if the URL has ?resume=<token>, fetch the saved draft
  // and rehydrate the wizard at the step the applicant left off on.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const token = params.get("resume");
    if (!token) return;
    let cancelled = false;
    (async () => {
      try {
        const out = await api<{ email: string; step: number; data: unknown; expiresAt: string }>(
          `/applications/draft/${encodeURIComponent(token)}`,
        );
        if (cancelled) return;
        setForm(hydrateForm(out.data));
        const targetStep = Number.isFinite(out.step) ? Math.max(0, Math.min(STEPS.length - 1, Math.floor(out.step))) : 0;
        setStep(targetStep);
        setDraftToken(token);
        setResumed(true);
      } catch (e) {
        if (cancelled) return;
        if (e instanceof ApiError && (e.status === 404 || e.status === 410)) {
          setResumeError("This resume link is no longer valid. You can start a new application below.");
        } else {
          setResumeError("We couldn't load your saved application. You can start a new one below.");
        }
      } finally {
        if (!cancelled) setResumeLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (initialMount.current) {
      initialMount.current = false;
      return;
    }
    // Move keyboard focus to the new step heading so assistive tech
    // announces the change instead of leaving focus on the Continue button.
    headingRef.current?.focus();
  }, [step, submitted]);

  function set<K extends keyof Form>(k: K, v: Form[K]) {
    setForm((f) => ({ ...f, [k]: v }));
  }
  function setCustom(qid: string, v: unknown) {
    setForm((f) => ({ ...f, customAnswers: { ...f.customAnswers, [qid]: v } }));
  }
  function setRef(i: number, k: keyof Reference, v: string) {
    setForm((f) => {
      const refs = [...f.references];
      refs[i] = { ...refs[i], [k]: v };
      return { ...f, references: refs };
    });
  }
  function toggleAvail(day: Day, period: Period) {
    setForm((f) => {
      const has = f.availability.some((c) => c.day === day && c.period === period);
      return {
        ...f,
        availability: has
          ? f.availability.filter((c) => !(c.day === day && c.period === period))
          : [...f.availability, { day, period }],
      };
    });
  }

  function validateStep(stepIndex: number = step): FieldError | null {
    // Required checks are gated on the field's effective config (isReq returns
    // false for hidden or admin-optional fields). Format checks (phone) only
    // run when the field is visible and the applicant entered a value.
    if (stepIndex === 0) {
      if (isReq("firstName") && !form.firstName) return { field: "firstName", message: `${labelOf("firstName")} is required.` };
      if (isReq("lastName") && !form.lastName) return { field: "lastName", message: `${labelOf("lastName")} is required.` };
      if (isReq("email") && !form.email) return { field: "email", message: `${labelOf("email")} is required.` };
      if (isReq("phone") && !form.phone) return { field: "phone", message: `${labelOf("phone")} is required.` };
      if (visibleField("phone") && form.phone && !normalizePhoneToE164(form.phone)) {
        return { field: "phone", message: "Phone number is invalid. Please enter a valid US phone number (e.g. (214) 555-1234) or include the country code (e.g. +44 20 1234 5678)." };
      }
      if (isReq("address") && !form.address) return { field: "address", message: `${labelOf("address")} is required.` };
      if (isReq("city") && !form.city) return { field: "city", message: `${labelOf("city")} is required.` };
      if (isReq("state") && !form.state) return { field: "state", message: `${labelOf("state")} is required.` };
      if (isReq("zip") && !form.zip) return { field: "zip", message: `${labelOf("zip")} is required.` };
      if (isReq("dateOfBirth") && !form.dateOfBirth) return { field: "dateOfBirth", message: `${labelOf("dateOfBirth")} is required.` };
      if (isReq("niNumber") && !form.niNumber.trim()) return { field: "niNumber", message: `${labelOf("niNumber")} is required.` };
      if (isReq("cityOfBirth") && !form.cityOfBirth.trim()) return { field: "cityOfBirth", message: `${labelOf("cityOfBirth")} is required.` };
      if (isReq("stateOfBirth") && !form.stateOfBirth.trim()) return { field: "stateOfBirth", message: `${labelOf("stateOfBirth")} is required.` };
    }
    if (stepIndex === 1) {
      if (isReq("i9Doc") && !form.i9Doc) return { field: "i9Doc", message: "Please upload your completed Form I-9." };
      if (isReq("ssnCardDoc") && !form.ssnCardDoc) return { field: "ssnCardDoc", message: "Please upload a photo of your Social Security card." };
      if (isReq("idDocType") && !form.idDocType) return { field: "idDocType", message: "Please select your photo ID type (driver's license or passport)." };
      if (isReq("idDoc") && !form.idDoc) return { field: "idDoc", message: "Please upload a photo of your driver's license or passport." };
    }
    if (stepIndex === 2) {
      if (isReq("siaLicenseNumber") && !form.siaLicenseNumber.trim()) return { field: "siaLicenseNumber", message: `${labelOf("siaLicenseNumber")} is required.` };
      if (isReq("siaLicenseLevel") && !form.siaLicenseLevel) return { field: "siaLicenseLevel", message: `${labelOf("siaLicenseLevel")} is required.` };
      if (isReq("siaLicenseExpiry") && !form.siaLicenseExpiry) return { field: "siaLicenseExpiry", message: `${labelOf("siaLicenseExpiry")} is required.` };
      if (isReq("yearsExperience") && !form.yearsExperience.trim()) return { field: "yearsExperience", message: `${labelOf("yearsExperience")} is required.` };
      if (isReq("previousExperience") && !form.previousExperience.trim()) return { field: "previousExperience", message: "Please describe your previous security experience." };
    }
    if (stepIndex === 3) {
      if (visibleField("references")) {
        const filled = form.references.filter(
          (r) => r.name.trim() && r.relationship.trim() && r.phone.trim(),
        );
        if (isReq("references") && filled.length === 0) {
          return { field: "ref:0:name", message: "Please provide at least one reference with name, relationship, and phone." };
        }
        // Data-quality: a partially filled reference row must be completed.
        for (let i = 0; i < form.references.length; i++) {
          const r = form.references[i];
          const anyTouched = r.name.trim() || r.relationship.trim() || r.phone.trim() || r.email.trim();
          if (anyTouched) {
            if (!r.name.trim()) return { field: `ref:${i}:name`, message: `Reference #${i + 1} name is required.` };
            if (!r.relationship.trim()) return { field: `ref:${i}:relationship`, message: `Reference #${i + 1} relationship is required.` };
            if (!r.phone.trim()) return { field: `ref:${i}:phone`, message: `Reference #${i + 1} phone is required.` };
          }
          if (r.phone.trim() && !normalizePhoneToE164(r.phone)) {
            return { field: `ref:${i}:phone`, message: `Reference #${i + 1} phone is invalid. Please enter a valid US phone number (e.g. (214) 555-1234) or include the country code (e.g. +44 20 1234 5678).` };
          }
        }
      }
      if (isReq("photo") && !form.photo) return { field: "photo", message: "Please upload a head & shoulders photo." };
      if (isReq("cv") && !form.cv) return { field: "cv", message: "Please upload your resume." };
      if (isReq("trainingCertificates") && form.trainingCertificates.length === 0) {
        return { field: "trainingCertificates", message: "Please upload at least one training certificate." };
      }
    }
    if (stepIndex === 4) {
      if (isReq("availability") && form.availability.length === 0) {
        return { field: "availability", message: "Please select at least one availability slot." };
      }
    }
    if (hasCustom && stepIndex === CUSTOM_STEP) {
      for (const q of questions) {
        if (!q.required) continue;
        const v = form.customAnswers[q.id];
        const present = Array.isArray(v)
          ? v.length > 0
          : typeof v === "string"
            ? v.trim().length > 0
            : v !== null && v !== undefined;
        if (!present) return { field: `custom:${q.id}`, message: `"${q.label}" is required.` };
      }
    }
    return null;
  }

  function validateAllSteps(): { stepIndex: number; error: FieldError } | null {
    for (let s = 0; s < REVIEW_STEP; s++) {
      const err = validateStep(s);
      if (err) return { stepIndex: s, error: err };
    }
    return null;
  }

  async function saveDraft() {
    setSaveState({ kind: "saving" });
    setGeneralError(null);
    const email = form.email.trim();
    if (!email) {
      setSaveState({ kind: "error", message: "Please enter your email on step 1 first — we need it to send your resume link." });
      setStep(0);
      setFieldErrors([{ field: "email", message: "Required to save your progress." }]);
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setSaveState({ kind: "error", message: "That email doesn't look valid. Please fix it on step 1 before saving." });
      setStep(0);
      setFieldErrors([{ field: "email", message: "Enter a valid email so we can send your resume link." }]);
      return;
    }
    try {
      const body: Record<string, unknown> = { email, step, data: form };
      if (draftToken) body.token = draftToken;
      const out = await api<{ ok: boolean; emailSent: boolean; expiresAt: string }>(
        "/applications/draft",
        { method: "POST", body },
      );
      setSaveState({ kind: "sent", emailSent: out.emailSent, toEmail: email });
    } catch (e) {
      const msg = e instanceof ApiError
        ? (e.status === 429
          ? "You've saved a lot in a short time — please wait a few minutes before saving again."
          : e.message)
        : (e as Error).message;
      setSaveState({ kind: "error", message: msg });
    }
  }

  async function submit() {
    setSubmitting(true);
    setGeneralError(null);

    const clientErr = validateAllSteps();
    if (clientErr) {
      setFieldErrors([clientErr.error]);
      setStep(clientErr.stepIndex);
      setSubmitting(false);
      return;
    }
    setFieldErrors([]);
    try {
      // Build the payload from the effective field config. Hidden fields are
      // omitted entirely (the server also nulls them), and optional fields that
      // were left blank are omitted so they don't violate the optional Zod
      // shapes (e.g. enum/number/file fields can't accept ""/0/null).
      const body: Record<string, unknown> = {
        firstName: form.firstName,
        lastName: form.lastName,
        email: form.email,
        phone: form.phone,
        address: form.address,
      };
      const putStr = (key: string, value: string) => {
        if (visibleField(key) && value.trim() !== "") body[key] = value;
      };
      const putFile = (key: string, value: UploadedFile | null) => {
        if (visibleField(key) && value) body[key] = value;
      };
      putStr("city", form.city);
      putStr("state", form.state);
      putStr("zip", form.zip);
      putStr("dateOfBirth", form.dateOfBirth);
      putStr("cityOfBirth", form.cityOfBirth);
      putStr("stateOfBirth", form.stateOfBirth);
      putStr("niNumber", form.niNumber);
      putFile("i9Doc", form.i9Doc);
      putFile("ssnCardDoc", form.ssnCardDoc);
      if (visibleField("idDocType") && form.idDocType) body.idDocType = form.idDocType;
      putFile("idDoc", form.idDoc);
      putStr("siaLicenseNumber", form.siaLicenseNumber);
      if (visibleField("siaLicenseLevel") && form.siaLicenseLevel) {
        body.siaLicenseLevel = Number(form.siaLicenseLevel);
      }
      putStr("siaLicenseExpiry", form.siaLicenseExpiry);
      putStr("previousExperience", form.previousExperience);
      if (visibleField("yearsExperience") && form.yearsExperience.trim() !== "") {
        body.yearsExperience = Number(form.yearsExperience);
      }
      if (visibleField("references")) {
        const refs = form.references
          .filter((r) => r.name.trim() && r.relationship.trim() && r.phone.trim())
          .map((r) => ({
            name: r.name,
            relationship: r.relationship,
            phone: r.phone,
            email: r.email || undefined,
          }));
        if (refs.length > 0) body.references = refs;
      }
      putFile("photo", form.photo);
      putFile("cv", form.cv);
      if (visibleField("trainingCertificates") && form.trainingCertificates.length > 0) {
        body.trainingCertificates = form.trainingCertificates;
      }
      if (visibleField("availability")) body.availability = form.availability;
      body.customAnswers = questions
        .map((q) => ({ questionId: q.id, value: form.customAnswers[q.id] }))
        .filter((a) => {
          const v = a.value;
          if (v === null || v === undefined) return false;
          if (typeof v === "string") return v.trim().length > 0;
          if (Array.isArray(v)) return v.length > 0;
          return true;
        });
      await api("/applications", { method: "POST", body });
      setSubmitted(true);
    } catch (e) {
      if (e instanceof ApiError && e.data && typeof e.data === "object") {
        const data = e.data as { fieldErrors?: Array<{ field?: string; message?: string }>; message?: string };
        const serverFieldErrors: FieldError[] = Array.isArray(data.fieldErrors)
          ? data.fieldErrors
              .filter((fe): fe is { field: string; message: string } =>
                typeof fe?.field === "string" && typeof fe?.message === "string")
              .map((fe) => ({ field: fe.field, message: fe.message }))
          : [];
        if (serverFieldErrors.length > 0) {
          setFieldErrors(serverFieldErrors);
          setGeneralError(null);
          const earliest = serverFieldErrors
            .map((fe) => localStepForField(fe.field))
            .reduce((a, b) => Math.min(a, b), REVIEW_STEP);
          setStep(Math.min(earliest, REVIEW_STEP));
        } else {
          setFieldErrors([]);
          setGeneralError(data.message ?? e.message);
        }
      } else {
        setFieldErrors([]);
        setGeneralError((e as Error).message);
      }
    } finally {
      setSubmitting(false);
    }
  }

  if (submitted) {
    return (
      <div className="min-h-screen bg-background">
        <BrandHeader subtitle="Officer Application" />
        <main className="max-w-3xl mx-auto px-6 py-16 text-center space-y-4">
          <CheckCircle2 className="w-16 h-16 text-emerald-700 mx-auto" aria-hidden="true" />
          <h1 className="brand-wordmark text-3xl" tabIndex={-1} ref={headingRef}>Thank you!</h1>
          <p className="text-muted-foreground">
            Your application has been received. Our HR team will review it and reach out
            shortly via email if you're shortlisted.
          </p>
        </main>
      </div>
    );
  }

  if (resumeLoading) {
    return (
      <div className="min-h-screen bg-background">
        <BrandHeader subtitle="Officer Application" />
        <main className="max-w-3xl mx-auto px-6 py-16 text-center space-y-4">
          <h1 className="brand-wordmark text-2xl" tabIndex={-1} ref={headingRef}>Loading your saved application…</h1>
          <p className="text-muted-foreground">Restoring your answers and documents.</p>
        </main>
      </div>
    );
  }

  const stepLabel = STEPS[step];
  const errOnStep = (name: string) => findFieldError(name, fieldErrors)?.message;

  // Render help text beneath a file upload (FileUploadField has no help slot).
  const fileHelp = (key: string): ReactNode => {
    const h = helpOf(key);
    return h?.trim() ? <p className="text-xs text-muted-foreground">{h.trim()}</p> : null;
  };

  // Render a single built-in field by key, honouring its effective label /
  // required / help config. Returns null when the field is hidden.
  function renderField(key: string): { node: ReactNode; width: "half" | "full" } | null {
    if (!visibleField(key)) return null;
    const req = isReq(key);
    const label = labelOf(key);
    const help = helpOf(key);
    switch (key) {
      case "firstName":
        return { width: "half", node: <Field label={label} help={help} required={req} name="firstName" error={fieldErrors}><Input autoComplete="given-name" value={form.firstName} onChange={(e) => set("firstName", e.target.value)} /></Field> };
      case "lastName":
        return { width: "half", node: <Field label={label} help={help} required={req} name="lastName" error={fieldErrors}><Input autoComplete="family-name" value={form.lastName} onChange={(e) => set("lastName", e.target.value)} /></Field> };
      case "email":
        return { width: "half", node: <Field label={label} help={help} required={req} name="email" error={fieldErrors}><Input type="email" autoComplete="email" value={form.email} onChange={(e) => set("email", e.target.value)} /></Field> };
      case "phone":
        return { width: "half", node: <Field label={label} help={help} required={req} name="phone" error={fieldErrors}><Input type="tel" autoComplete="tel" value={form.phone} onChange={(e) => set("phone", e.target.value)} /></Field> };
      case "address":
        return { width: "full", node: <Field label={label} help={help} required={req} name="address" error={fieldErrors}><Textarea rows={2} autoComplete="street-address" value={form.address} onChange={(e) => set("address", e.target.value)} placeholder="Street, apt/unit" /></Field> };
      case "city":
        return { width: "half", node: <Field label={label} help={help} required={req} name="city" error={fieldErrors}><Input autoComplete="address-level2" value={form.city} onChange={(e) => set("city", e.target.value)} /></Field> };
      case "state":
        return { width: "half", node: (
          <Field label={label} help={help} required={req} name="state" error={fieldErrors}>
            <select
              className="w-full border rounded h-10 px-3 bg-background focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              autoComplete="address-level1"
              value={form.state}
              onChange={(e) => set("state", e.target.value)}
            >
              <option value="">Select…</option>
              {US_STATES.map((s) => (
                <option key={s.code} value={s.code}>{s.name} ({s.code})</option>
              ))}
            </select>
          </Field>
        ) };
      case "zip":
        return { width: "half", node: <Field label={label} help={help} required={req} name="zip" error={fieldErrors}><Input autoComplete="postal-code" value={form.zip} onChange={(e) => set("zip", e.target.value)} placeholder="75001" /></Field> };
      case "dateOfBirth":
        return { width: "half", node: <Field label={label} help={help} required={req} name="dateOfBirth" error={fieldErrors}><Input type="date" autoComplete="bday" value={form.dateOfBirth} onChange={(e) => set("dateOfBirth", e.target.value)} /></Field> };
      case "niNumber":
        return { width: "half", node: <Field label={label} help={help} required={req} name="niNumber" error={fieldErrors}><Input inputMode="numeric" value={form.niNumber} onChange={(e) => set("niNumber", e.target.value)} /></Field> };
      case "cityOfBirth":
        return { width: "half", node: <Field label={label} help={help} required={req} name="cityOfBirth" error={fieldErrors}><Input value={form.cityOfBirth} onChange={(e) => set("cityOfBirth", e.target.value)} /></Field> };
      case "stateOfBirth":
        return { width: "half", node: <Field label={label} help={help} required={req} name="stateOfBirth" error={fieldErrors}><Input value={form.stateOfBirth} onChange={(e) => set("stateOfBirth", e.target.value)} /></Field> };
      case "i9Doc":
        return { width: "full", node: (
          <div className="space-y-1">
            <FileUploadField label={label} required={req} accept="image/*,.pdf" value={form.i9Doc} onChange={(v) => set("i9Doc", v)} uploadFn={uploadFileAnon} error={errOnStep("i9Doc")} />
            {fileHelp("i9Doc")}
          </div>
        ) };
      case "ssnCardDoc":
        return { width: "full", node: (
          <div className="space-y-1">
            <FileUploadField label={label} required={req} accept="image/*,.pdf" value={form.ssnCardDoc} onChange={(v) => set("ssnCardDoc", v)} uploadFn={uploadFileAnon} error={errOnStep("ssnCardDoc")} />
            {fileHelp("ssnCardDoc")}
          </div>
        ) };
      case "idDocType":
        return { width: "full", node: (
          <Field label={label} help={help} required={req} name="idDocType" error={fieldErrors}>
            <select
              className="w-full border rounded h-10 px-3 bg-background focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              value={form.idDocType}
              onChange={(e) => set("idDocType", e.target.value as Form["idDocType"])}
            >
              <option value="">Select…</option>
              <option value="drivers_license">Driver's License</option>
              <option value="passport">Passport</option>
            </select>
          </Field>
        ) };
      case "idDoc": {
        // Default label is dynamic (depends on the chosen ID type); an admin
        // rename overrides it, otherwise fall back to the contextual prompt.
        const dyn =
          form.idDocType === "passport"
            ? "Passport (photo of ID page)"
            : form.idDocType === "drivers_license"
            ? "Driver's License (photo of front)"
            : "Photo ID (select type above first)";
        const idLabel = isRelabeled("idDoc") ? label : dyn;
        return { width: "full", node: (
          <div className="space-y-1">
            <FileUploadField label={idLabel} required={req} accept="image/*,.pdf" value={form.idDoc} onChange={(v) => set("idDoc", v)} uploadFn={uploadFileAnon} error={errOnStep("idDoc")} />
            {fileHelp("idDoc")}
          </div>
        ) };
      }
      case "siaLicenseNumber":
        return { width: "half", node: <Field label={label} help={help} required={req} name="siaLicenseNumber" error={fieldErrors}><Input value={form.siaLicenseNumber} onChange={(e) => set("siaLicenseNumber", e.target.value)} /></Field> };
      case "siaLicenseLevel":
        return { width: "half", node: (
          <Field label={label} help={help} required={req} name="siaLicenseLevel" error={fieldErrors}>
            <select className="w-full border rounded h-10 px-3 bg-background focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              value={form.siaLicenseLevel} onChange={(e) => set("siaLicenseLevel", e.target.value)}>
              <option value="">Select…</option>
              <option value="2">L2 — Unarmed</option>
              <option value="3">L3 — Armed</option>
              <option value="4">L4 — PPO</option>
            </select>
          </Field>
        ) };
      case "siaLicenseExpiry":
        return { width: "half", node: <Field label={label} help={help} required={req} name="siaLicenseExpiry" error={fieldErrors}><Input type="date" value={form.siaLicenseExpiry} onChange={(e) => set("siaLicenseExpiry", e.target.value)} /></Field> };
      case "yearsExperience":
        return { width: "half", node: <Field label={label} help={help} required={req} name="yearsExperience" error={fieldErrors}><Input type="number" min={0} value={form.yearsExperience} onChange={(e) => set("yearsExperience", e.target.value)} /></Field> };
      case "previousExperience":
        return { width: "full", node: (
          <Field label={label} help={help} required={req} name="previousExperience" error={fieldErrors}>
            <Textarea rows={5} value={form.previousExperience} onChange={(e) => set("previousExperience", e.target.value)} />
          </Field>
        ) };
      case "references":
        return { width: "full", node: (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              {help?.trim()
                ? help.trim()
                : req
                  ? "At least one complete reference is required (name, relationship, and phone)."
                  : "Add any professional references (name, relationship, and phone)."}
            </p>
            {form.references.map((r, i) => (
              <fieldset key={i} className="p-3 border rounded space-y-2 bg-muted/30">
                <legend className="text-xs uppercase tracking-wide opacity-70 px-1">
                  Reference {i + 1}{i === 0 ? (req ? " (required)" : " (optional)") : " (optional)"}
                </legend>
                <Two>
                  <Field label="Name" required={req && i === 0} name={`ref:${i}:name`} error={fieldErrors}><Input value={r.name} onChange={(e) => setRef(i, "name", e.target.value)} /></Field>
                  <Field label="Relationship" required={req && i === 0} name={`ref:${i}:relationship`} error={fieldErrors}><Input value={r.relationship} onChange={(e) => setRef(i, "relationship", e.target.value)} /></Field>
                </Two>
                <Two>
                  <Field label="Phone" required={req && i === 0} name={`ref:${i}:phone`} error={fieldErrors}><Input type="tel" value={r.phone} onChange={(e) => setRef(i, "phone", e.target.value)} /></Field>
                  <Field label="Email"><Input type="email" value={r.email} onChange={(e) => setRef(i, "email", e.target.value)} /></Field>
                </Two>
              </fieldset>
            ))}
          </div>
        ) };
      case "photo":
        return { width: "half", node: (
          <div className="space-y-1">
            <FileUploadField label={label} required={req} accept="image/*" value={form.photo} onChange={(v) => set("photo", v)} uploadFn={uploadFileAnon} error={errOnStep("photo")} />
            {fileHelp("photo")}
          </div>
        ) };
      case "cv":
        return { width: "half", node: (
          <div className="space-y-1">
            <FileUploadField label={label} required={req} accept=".pdf,.doc,.docx" value={form.cv} onChange={(v) => set("cv", v)} uploadFn={uploadFileAnon} error={errOnStep("cv")} />
            {fileHelp("cv")}
          </div>
        ) };
      case "trainingCertificates":
        return { width: "full", node: (
          <div className="space-y-1">
            <MultiFileUploadField
              label={label}
              required={req}
              accept="image/*,.pdf"
              value={form.trainingCertificates}
              onChange={(v) => set("trainingCertificates", v)}
              uploadFn={uploadFileAnon}
              error={errOnStep("trainingCertificates")}
            />
            {fileHelp("trainingCertificates")}
          </div>
        ) };
      default:
        return null;
    }
  }

  // Lay out a section's visible fields in config order, pairing consecutive
  // half-width fields into two-column rows and giving full-width fields a row.
  function renderSection(section: number): ReactNode {
    const out: ReactNode[] = [];
    let pending: ReactNode | null = null;
    let pendingKey = "";
    const flush = () => {
      if (pending !== null) {
        out.push(<Two key={`pair-${pendingKey}`}>{pending}<div /></Two>);
        pending = null;
      }
    };
    for (const key of orderedKeys(section)) {
      const r = renderField(key);
      if (!r) continue;
      if (r.width === "half") {
        if (pending !== null) {
          out.push(<Two key={`pair-${pendingKey}-${key}`}>{pending}{r.node}</Two>);
          pending = null;
        } else {
          pending = r.node;
          pendingKey = key;
        }
      } else {
        flush();
        out.push(<div key={key}>{r.node}</div>);
      }
    }
    flush();
    return <>{out}</>;
  }

  return (
    <div className="min-h-screen bg-background">
      <BrandHeader subtitle="Officer Application" />
      <main className="max-w-3xl mx-auto px-6 py-8">
        {/* Polite announcement of step changes so screen readers say
            "Step 2 of 6: I-9 & Identity" without us yanking visual focus. */}
        <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">
          Step {step + 1} of {STEPS.length}: {stepLabel}
        </div>
        <Stepper step={step} steps={STEPS} />
        {resumed && (
          <div role="status" className="mt-4 text-sm rounded border border-emerald-200 bg-emerald-50 text-emerald-900 p-3">
            Welcome back — we've restored your saved application. You can keep filling it out below.
          </div>
        )}
        {resumeError && (
          <div role="alert" className="mt-4 text-sm rounded border border-amber-200 bg-amber-50 text-amber-900 p-3">
            {resumeError}
          </div>
        )}
        {saveState.kind === "sent" && (
          <div role="status" className="mt-4 text-sm rounded border border-emerald-200 bg-emerald-50 text-emerald-900 p-3">
            {saveState.emailSent
              ? <>Your progress is saved. We just emailed a resume link to <strong>{saveState.toEmail}</strong> — it's good for 14 days. You can close this tab and come back any time.</>
              : <>Your progress is saved for 14 days. We weren't able to email you a resume link right now — please contact our HR team if you need help getting back in.</>}
          </div>
        )}
        {saveState.kind === "error" && (
          <div role="alert" className="mt-4 text-sm rounded border border-destructive/30 bg-destructive/5 text-destructive p-3">
            {saveState.message}
          </div>
        )}
        <form
          noValidate
          onSubmit={(e) => e.preventDefault()}
          aria-label={`Officer application, step ${step + 1} of ${STEPS.length}: ${stepLabel}`}
          className="mt-6 bg-card rounded-lg shadow-sm border p-6 space-y-5"
        >
          {step === 0 && (
            <>
              <h2 ref={headingRef} tabIndex={-1} className="brand-wordmark text-xl focus:outline-none">Personal details</h2>
              {renderSection(0)}
            </>
          )}
          {step === 1 && (
            <>
              <h2 ref={headingRef} tabIndex={-1} className="brand-wordmark text-xl focus:outline-none">I-9 Employment Eligibility</h2>
              {orderedKeys(1).length > 0 && (
                <>
                  <p className="text-sm text-muted-foreground">
                    Federal law requires every new hire to complete a Form I-9 and present
                    identity + work-authorization documents. Download the blank form, fill in
                    Section 1, sign it, and upload it below — plus a photo of your Social
                    Security card and either your driver's license or passport.
                  </p>
                  <div className="p-3 border rounded bg-amber-50 text-sm">
                    <a
                      href={I9_FORM_URL}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="font-semibold underline text-amber-900"
                    >
                      Download blank Form I-9 (USCIS, opens in a new tab)
                    </a>
                    <div className="text-xs text-amber-900/80 mt-1">
                      Print, complete Section 1, sign and date, then scan or photograph all pages.
                    </div>
                  </div>
                </>
              )}
              {renderSection(1)}
            </>
          )}
          {step === 2 && (
            <>
              <h2 ref={headingRef} tabIndex={-1} className="brand-wordmark text-xl focus:outline-none">TX security license &amp; experience</h2>
              {renderSection(2)}
            </>
          )}
          {step === 3 && (
            <>
              <h2 ref={headingRef} tabIndex={-1} className="brand-wordmark text-xl focus:outline-none">References &amp; documents</h2>
              {renderSection(3)}
            </>
          )}
          {step === 4 && (
            visibleField("availability") ? (
              <AvailabilityGrid
                headingRef={headingRef}
                value={form.availability}
                onToggle={toggleAvail}
                error={errOnStep("availability")}
                label={labelOf("availability")}
                required={isReq("availability")}
                help={helpOf("availability")}
              />
            ) : (
              <h2 ref={headingRef} tabIndex={-1} className="brand-wordmark text-xl focus:outline-none">
                {labelOf("availability")}
              </h2>
            )
          )}
          {hasCustom && step === CUSTOM_STEP && (
            <CustomAnswersStep
              headingRef={headingRef}
              questions={questions}
              values={form.customAnswers}
              onChange={setCustom}
              fieldErrors={fieldErrors}
            />
          )}
          {step === REVIEW_STEP && (
            <>
              <h2 ref={headingRef} tabIndex={-1} className="brand-wordmark text-xl focus:outline-none">Review &amp; submit</h2>
              <p className="text-sm text-muted-foreground">Please verify your details before sending.</p>
              <dl className="text-sm grid grid-cols-2 gap-x-4 gap-y-1">
                <Sum k="Name" v={`${form.firstName} ${form.lastName}`} />
                <Sum k="Email" v={form.email} />
                <Sum k="Phone" v={form.phone} />
                <Sum k="DOB" v={form.dateOfBirth || "—"} />
                <Sum k="SSN (last 4)" v={form.niNumber || "—"} />
                <Sum k="I-9 form" v={form.i9Doc ? form.i9Doc.name : "—"} />
                <Sum k="SSN card" v={form.ssnCardDoc ? form.ssnCardDoc.name : "—"} />
                <Sum k="Photo ID" v={form.idDoc ? `${form.idDocType === "passport" ? "Passport" : "DL"}: ${form.idDoc.name}` : "—"} />
                <Sum k="TX license" v={form.siaLicenseNumber ? `${form.siaLicenseNumber} (L${form.siaLicenseLevel || "?"})` : "—"} />
                <Sum k="Experience" v={form.yearsExperience ? `${form.yearsExperience} yrs` : "—"} />
                <Sum k="Photo" v={form.photo ? form.photo.name : "—"} />
                <Sum k="Resume" v={form.cv ? form.cv.name : "—"} />
                <Sum k="Certificates" v={String(form.trainingCertificates.length)} />
                <Sum k="Availability slots" v={String(form.availability.length)} />
              </dl>
              {generalError && (
                <div role="alert" className="text-sm text-destructive bg-destructive/5 p-2 rounded border border-destructive/20">
                  {generalError}
                </div>
              )}
              {fieldErrors.length > 0 && (
                <div role="alert" className="text-sm text-destructive bg-destructive/5 p-3 rounded border border-destructive/20 space-y-1">
                  <div className="font-semibold">Please fix the following before submitting:</div>
                  <ul className="list-disc pl-5">
                    {fieldErrors.map((fe, i) => (
                      <li key={i}>
                        <button
                          type="button"
                          className="underline hover:opacity-80 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring rounded"
                          onClick={() => fe.field && setStep(localStepForField(fe.field))}
                        >
                          {fe.message}
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          )}

          <div className="flex flex-wrap items-center justify-between gap-3 pt-4 border-t">
            <Button type="button" variant="ghost" disabled={step === 0 || submitting}
              onClick={() => setStep((s) => Math.max(0, s - 1))}>
              <ChevronLeft className="w-4 h-4 mr-1" aria-hidden="true" /> Back
            </Button>
            <div className="flex items-center gap-2 ml-auto">
              <Button
                type="button"
                variant="outline"
                disabled={submitting || saveState.kind === "saving"}
                onClick={saveDraft}
                title="Email yourself a link to come back and finish this application later."
              >
                {saveState.kind === "saving" ? "Saving…" : "Save & finish later"}
              </Button>
            {step < STEPS.length - 1 ? (
              <Button
                type="button"
                className="bg-brand-navy hover:opacity-90 text-white"
                onClick={() => {
                  const err = validateStep();
                  if (err) { setFieldErrors([err]); setGeneralError(null); return; }
                  setFieldErrors([]);
                  setGeneralError(null);
                  setStep((s) => Math.min(STEPS.length - 1, s + 1));
                }}
              >Continue <ChevronRight className="w-4 h-4 ml-1" aria-hidden="true" /></Button>
            ) : (
              <Button type="submit" disabled={submitting}
                className="bg-brand-navy hover:opacity-90 text-white"
                onClick={submit}>
                {submitting ? "Submitting…" : "Submit application"}
              </Button>
            )}
            </div>
          </div>
        </form>
        <p className="text-[11px] text-muted-foreground text-center pt-6">
          By submitting you agree to our{" "}
          <a href={`${import.meta.env.BASE_URL}terms`} className="underline hover:text-foreground">Terms</a>{" "}
          and acknowledge our{" "}
          <a href={`${import.meta.env.BASE_URL}privacy`} className="underline hover:text-foreground">Privacy Policy</a>.{" "}
          See your{" "}
          <a href={`${import.meta.env.BASE_URL}data-rights`} className="underline hover:text-foreground">data rights</a>.
        </p>
      </main>
    </div>
  );
}

function AvailabilityGrid({
  headingRef, value, onToggle, error, label, required, help,
}: {
  headingRef: React.Ref<HTMLHeadingElement>;
  value: { day: Day; period: Period }[];
  onToggle: (d: Day, p: Period) => void;
  error?: string;
  label: string;
  required: boolean;
  help?: string | null;
}) {
  const errorId = useId();
  return (
    <>
      <h2 ref={headingRef} tabIndex={-1} className="brand-wordmark text-xl focus:outline-none">
        {label}
        {required && (
          <>
            {" "}<span className="text-destructive" aria-hidden="true">*</span>
            <span className="sr-only"> (required)</span>
          </>
        )}
      </h2>
      <p className="text-sm text-muted-foreground">
        {help?.trim()
          ? help.trim()
          : required
            ? "Select each shift period you can usually work. At least one slot is required."
            : "Select each shift period you can usually work."}
      </p>
      {error && (
        <div id={errorId} role="alert" className="text-xs text-destructive">
          {error}
        </div>
      )}
      <div className="overflow-x-auto" aria-describedby={error ? errorId : undefined}>
        <table className="w-full text-sm">
          <caption className="sr-only">Weekly availability grid. Each cell toggles a single shift period.</caption>
          <thead>
            <tr>
              <th scope="col"><span className="sr-only">Shift period</span></th>
              {DAYS.map((d) => (
                <th key={d} scope="col" className="px-2 py-1 capitalize">{d}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {PERIODS.map((p) => (
              <tr key={p}>
                <th scope="row" className="capitalize text-xs uppercase tracking-wide opacity-70 pr-2 text-left font-medium">{p}</th>
                {DAYS.map((d) => {
                  const on = value.some((c) => c.day === d && c.period === p);
                  return (
                    <td key={d} className="p-1">
                      <button
                        type="button"
                        onClick={() => onToggle(d, p)}
                        aria-pressed={on}
                        aria-label={`${DAY_LABELS[d]} ${p}`}
                        className={`w-full h-8 rounded border text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring ${on ? "bg-brand-navy text-white border-brand-navy" : "bg-background hover:bg-accent/40"}`}
                      >
                        <span aria-hidden="true">{on ? "✓" : ""}</span>
                      </button>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function Stepper({ step, steps }: { step: number; steps: string[] }) {
  return (
    <ol className="flex flex-wrap gap-2 text-xs" aria-label="Application progress">
      {steps.map((s, i) => (
        <li key={s}
          aria-current={i === step ? "step" : undefined}
          className={`px-2 py-1 rounded border ${
            i === step ? "bg-brand-navy text-white border-brand-navy" :
            i < step ? "bg-accent/60 border-accent" : "bg-background opacity-60"
          }`}>
          <span className="sr-only">{i < step ? "Completed: " : i === step ? "Current step: " : ""}</span>
          {i + 1}. {s}
        </li>
      ))}
    </ol>
  );
}

function Field({
  label, name, error, children, required, help,
}: {
  label: string;
  name?: string;
  error?: FieldError[];
  children: ReactNode;
  required?: boolean;
  help?: string | null;
}) {
  const fieldId = useId();
  const errorId = useId();
  const helpId = useId();
  const match = findFieldError(name, error ?? []);
  const helpText = help?.trim() ? help.trim() : null;
  const describedBy = [match ? errorId : null, helpText ? helpId : null].filter(Boolean).join(" ") || undefined;
  // Wire the visual <Label> to the underlying control, and pipe both the
  // error message and aria-invalid into the control via cloneElement so
  // every input/select/textarea is properly labelled and validated for AT.
  // If the child already has its own id, keep it and point htmlFor at the
  // same id so label association stays correct even for custom controls.
  let control = children;
  let controlId = fieldId;
  if (isValidElement(children)) {
    const el = children as ReactElement<{
      id?: string;
      "aria-describedby"?: string;
      "aria-invalid"?: boolean | "true" | "false";
      "aria-required"?: boolean | "true" | "false";
      required?: boolean;
    }>;
    controlId = el.props.id ?? fieldId;
    control = cloneElement(el, {
      id: controlId,
      "aria-describedby": describedBy ?? el.props["aria-describedby"],
      "aria-invalid": match ? true : el.props["aria-invalid"],
      "aria-required": required ? true : el.props["aria-required"],
    });
  }
  return (
    <div className="space-y-1">
      <Label htmlFor={controlId} className="text-xs uppercase font-semibold text-foreground/80">
        {label}
        {required && (
          <>
            <span className="text-destructive ml-0.5" aria-hidden="true">*</span>
            <span className="sr-only"> (required)</span>
          </>
        )}
      </Label>
      {helpText && <div id={helpId} className="text-xs text-muted-foreground">{helpText}</div>}
      {control}
      {match && (
        <div id={errorId} role="alert" className="text-xs text-destructive">{match.message}</div>
      )}
    </div>
  );
}

function Two({ children }: { children: ReactNode }) {
  return <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">{children}</div>;
}
function Sum({ k, v }: { k: string; v: string }) {
  return (<><dt className="text-muted-foreground">{k}</dt><dd className="font-medium truncate">{v}</dd></>);
}

const CUSTOM_INPUT_CLASS =
  "w-full border rounded h-10 px-3 bg-background focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

function CustomAnswersStep({
  headingRef, questions, values, onChange, fieldErrors,
}: {
  headingRef: React.Ref<HTMLHeadingElement>;
  questions: TemplateQuestion[];
  values: Record<string, unknown>;
  onChange: (qid: string, v: unknown) => void;
  fieldErrors: FieldError[];
}) {
  return (
    <>
      <h2 ref={headingRef} tabIndex={-1} className="brand-wordmark text-xl focus:outline-none">Additional questions</h2>
      <p className="text-sm text-muted-foreground">A few more questions from our hiring team.</p>
      {questions.map((q) => (
        <CustomQuestionField
          key={q.id}
          q={q}
          value={values[q.id]}
          onChange={(v) => onChange(q.id, v)}
          errorMsg={findFieldError(`custom:${q.id}`, fieldErrors)?.message}
        />
      ))}
    </>
  );
}

function CustomQuestionField({
  q, value, onChange, errorMsg,
}: {
  q: TemplateQuestion;
  value: unknown;
  onChange: (v: unknown) => void;
  errorMsg?: string;
}) {
  const fieldId = useId();
  const errorId = useId();
  const helpId = useId();
  const help = q.helpText?.trim();
  const describedBy = [errorMsg ? errorId : null, help ? helpId : null].filter(Boolean).join(" ") || undefined;
  const invalid = errorMsg ? true : undefined;
  const requiredMark = q.required ? (
    <><span className="text-destructive ml-0.5" aria-hidden="true">*</span><span className="sr-only"> (required)</span></>
  ) : null;
  const helpNode = help ? <div id={helpId} className="text-xs text-muted-foreground">{help}</div> : null;
  const errorNode = errorMsg ? <div id={errorId} role="alert" className="text-xs text-destructive">{errorMsg}</div> : null;
  const strVal = typeof value === "string" ? value : "";

  if (q.fieldType === "multiselect") {
    const arr = Array.isArray(value) ? (value as unknown[]).filter((x): x is string => typeof x === "string") : [];
    return (
      <fieldset className="space-y-1">
        <legend className="text-xs uppercase font-semibold text-foreground/80">{q.label}{requiredMark}</legend>
        {helpNode}
        <div className="space-y-1.5 pt-1" aria-describedby={describedBy}>
          {(q.options ?? []).map((opt) => {
            const checked = arr.includes(opt);
            return (
              <label key={opt} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  className="h-4 w-4"
                  checked={checked}
                  onChange={(e) => onChange(e.target.checked ? [...arr, opt] : arr.filter((x) => x !== opt))}
                />
                {opt}
              </label>
            );
          })}
        </div>
        {errorNode}
      </fieldset>
    );
  }

  let control: ReactNode;
  switch (q.fieldType) {
    case "long_text":
      control = <Textarea id={fieldId} rows={3} aria-describedby={describedBy} aria-invalid={invalid} aria-required={q.required || undefined} value={strVal} onChange={(e) => onChange(e.target.value)} />;
      break;
    case "number":
      control = <Input id={fieldId} type="number" inputMode="decimal" aria-describedby={describedBy} aria-invalid={invalid} aria-required={q.required || undefined} value={strVal} onChange={(e) => onChange(e.target.value)} />;
      break;
    case "date":
      control = <Input id={fieldId} type="date" aria-describedby={describedBy} aria-invalid={invalid} aria-required={q.required || undefined} value={strVal} onChange={(e) => onChange(e.target.value)} />;
      break;
    case "select":
      control = (
        <select id={fieldId} className={CUSTOM_INPUT_CLASS} aria-describedby={describedBy} aria-invalid={invalid} aria-required={q.required || undefined} value={strVal} onChange={(e) => onChange(e.target.value)}>
          <option value="">Select…</option>
          {(q.options ?? []).map((opt) => <option key={opt} value={opt}>{opt}</option>)}
        </select>
      );
      break;
    case "yes_no": {
      const yn = value === true ? "yes" : value === false ? "no" : "";
      control = (
        <select id={fieldId} className={CUSTOM_INPUT_CLASS} aria-describedby={describedBy} aria-invalid={invalid} aria-required={q.required || undefined} value={yn} onChange={(e) => onChange(e.target.value === "yes" ? true : e.target.value === "no" ? false : null)}>
          <option value="">Select…</option>
          <option value="yes">Yes</option>
          <option value="no">No</option>
        </select>
      );
      break;
    }
    case "short_text":
    default:
      control = <Input id={fieldId} aria-describedby={describedBy} aria-invalid={invalid} aria-required={q.required || undefined} value={strVal} onChange={(e) => onChange(e.target.value)} />;
      break;
  }
  return (
    <div className="space-y-1">
      <Label htmlFor={fieldId} className="text-xs uppercase font-semibold text-foreground/80">{q.label}{requiredMark}</Label>
      {helpNode}
      {control}
      {errorNode}
    </div>
  );
}
