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
};

const STEPS = ["Personal", "I-9 & Identity", "TX License & experience", "References & docs", "Availability", "Review"];

const I9_FORM_URL = "https://www.uscis.gov/sites/default/files/document/forms/i-9.pdf";

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

export function ApplyPage() {
  const [step, setStep] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<FieldError[]>([]);
  const [generalError, setGeneralError] = useState<string | null>(null);
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  // Skip focusing the heading on the initial mount so first-time visitors
  // aren't yanked past the brand header. After any subsequent step change
  // we focus the new heading and announce it.
  const initialMount = useRef(true);

  const [form, setForm] = useState<Form>({
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
  });

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
    if (stepIndex === 0) {
      if (!form.firstName) return { field: "firstName", message: "First name is required." };
      if (!form.lastName) return { field: "lastName", message: "Last name is required." };
      if (!form.email) return { field: "email", message: "Email is required." };
      if (!form.phone) return { field: "phone", message: "Phone is required." };
      if (!normalizePhoneToE164(form.phone)) {
        return { field: "phone", message: "Phone number is invalid. Please enter a valid US phone number (e.g. (214) 555-1234) or include the country code (e.g. +44 20 1234 5678)." };
      }
      if (!form.address) return { field: "address", message: "Street address is required." };
      if (!form.city) return { field: "city", message: "City is required." };
      if (!form.state) return { field: "state", message: "State is required." };
      if (!form.zip) return { field: "zip", message: "ZIP code is required." };
      if (!form.dateOfBirth) return { field: "dateOfBirth", message: "Date of birth is required." };
      if (!form.niNumber.trim()) return { field: "niNumber", message: "SSN (last 4) is required." };
      if (!form.cityOfBirth.trim()) return { field: "cityOfBirth", message: "City of birth is required." };
      if (!form.stateOfBirth.trim()) return { field: "stateOfBirth", message: "State of birth is required." };
    }
    if (stepIndex === 1) {
      if (!form.i9Doc) return { field: "i9Doc", message: "Please upload your completed Form I-9." };
      if (!form.ssnCardDoc) return { field: "ssnCardDoc", message: "Please upload a photo of your Social Security card." };
      if (!form.idDocType) return { field: "idDocType", message: "Please select your photo ID type (driver's license or passport)." };
      if (!form.idDoc) return { field: "idDoc", message: "Please upload a photo of your driver's license or passport." };
    }
    if (stepIndex === 2) {
      if (!form.siaLicenseNumber.trim()) return { field: "siaLicenseNumber", message: "TX security license number is required." };
      if (!form.siaLicenseLevel) return { field: "siaLicenseLevel", message: "License level is required." };
      if (!form.siaLicenseExpiry) return { field: "siaLicenseExpiry", message: "License expiry date is required." };
      if (!form.yearsExperience.trim()) return { field: "yearsExperience", message: "Years of experience is required." };
      if (!form.previousExperience.trim()) return { field: "previousExperience", message: "Please describe your previous security experience." };
    }
    if (stepIndex === 3) {
      const filled = form.references.filter(
        (r) => r.name.trim() && r.relationship.trim() && r.phone.trim(),
      );
      if (filled.length === 0) {
        return { field: "ref:0:name", message: "Please provide at least one reference with name, relationship, and phone." };
      }
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
      if (!form.photo) return { field: "photo", message: "Please upload a head & shoulders photo." };
      if (!form.cv) return { field: "cv", message: "Please upload your CV." };
      if (form.trainingCertificates.length === 0) {
        return { field: "trainingCertificates", message: "Please upload at least one training certificate." };
      }
    }
    if (stepIndex === 4) {
      if (form.availability.length === 0) {
        return { field: "availability", message: "Please select at least one availability slot." };
      }
    }
    return null;
  }

  function validateAllSteps(): { stepIndex: number; error: FieldError } | null {
    for (let s = 0; s <= 4; s++) {
      const err = validateStep(s);
      if (err) return { stepIndex: s, error: err };
    }
    return null;
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
      const body = {
        firstName: form.firstName,
        lastName: form.lastName,
        email: form.email,
        phone: form.phone,
        address: form.address,
        city: form.city,
        state: form.state,
        zip: form.zip,
        dateOfBirth: form.dateOfBirth,
        cityOfBirth: form.cityOfBirth,
        stateOfBirth: form.stateOfBirth,
        niNumber: form.niNumber,
        i9Doc: form.i9Doc,
        ssnCardDoc: form.ssnCardDoc,
        idDocType: form.idDocType,
        idDoc: form.idDoc,
        siaLicenseNumber: form.siaLicenseNumber,
        siaLicenseLevel: Number(form.siaLicenseLevel),
        siaLicenseExpiry: form.siaLicenseExpiry,
        previousExperience: form.previousExperience,
        yearsExperience: Number(form.yearsExperience),
        references: form.references
          .filter((r) => r.name.trim() && r.relationship.trim() && r.phone.trim())
          .map((r) => ({
            name: r.name,
            relationship: r.relationship,
            phone: r.phone,
            email: r.email || undefined,
          })),
        photo: form.photo,
        cv: form.cv,
        trainingCertificates: form.trainingCertificates,
        availability: form.availability,
      };
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
            .map((fe) => stepForField(fe.field))
            .reduce((a, b) => Math.min(a, b), 5);
          setStep(Math.min(earliest, 5));
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

  const stepLabel = STEPS[step];
  const errOnStep = (name: string) => findFieldError(name, fieldErrors)?.message;

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
        <form
          noValidate
          onSubmit={(e) => e.preventDefault()}
          aria-label={`Officer application, step ${step + 1} of ${STEPS.length}: ${stepLabel}`}
          className="mt-6 bg-card rounded-lg shadow-sm border p-6 space-y-5"
        >
          {step === 0 && (
            <>
              <h2 ref={headingRef} tabIndex={-1} className="brand-wordmark text-xl focus:outline-none">Personal details</h2>
              <Two>
                <Field label="First name" required name="firstName" error={fieldErrors}><Input autoComplete="given-name" value={form.firstName} onChange={(e) => set("firstName", e.target.value)} /></Field>
                <Field label="Last name" required name="lastName" error={fieldErrors}><Input autoComplete="family-name" value={form.lastName} onChange={(e) => set("lastName", e.target.value)} /></Field>
              </Two>
              <Two>
                <Field label="Email" required name="email" error={fieldErrors}><Input type="email" autoComplete="email" value={form.email} onChange={(e) => set("email", e.target.value)} /></Field>
                <Field label="Phone" required name="phone" error={fieldErrors}><Input type="tel" autoComplete="tel" value={form.phone} onChange={(e) => set("phone", e.target.value)} /></Field>
              </Two>
              <Field label="Street address" required name="address" error={fieldErrors}><Textarea rows={2} autoComplete="street-address" value={form.address} onChange={(e) => set("address", e.target.value)} placeholder="Street, apt/unit" /></Field>
              <Two>
                <Field label="City" required name="city" error={fieldErrors}><Input autoComplete="address-level2" value={form.city} onChange={(e) => set("city", e.target.value)} /></Field>
                <Field label="State" required name="state" error={fieldErrors}><Input autoComplete="address-level1" value={form.state} onChange={(e) => set("state", e.target.value.toUpperCase().slice(0, 2))} placeholder="TX" maxLength={2} /></Field>
              </Two>
              <Two>
                <Field label="ZIP code" required name="zip" error={fieldErrors}><Input autoComplete="postal-code" value={form.zip} onChange={(e) => set("zip", e.target.value)} placeholder="75001" /></Field>
                <div />
              </Two>
              <Two>
                <Field label="Date of birth" required name="dateOfBirth" error={fieldErrors}><Input type="date" autoComplete="bday" value={form.dateOfBirth} onChange={(e) => set("dateOfBirth", e.target.value)} /></Field>
                <Field label="SSN (last 4)" required name="niNumber" error={fieldErrors}><Input inputMode="numeric" value={form.niNumber} onChange={(e) => set("niNumber", e.target.value)} /></Field>
              </Two>
              <Two>
                <Field label="City of birth" required name="cityOfBirth" error={fieldErrors}><Input value={form.cityOfBirth} onChange={(e) => set("cityOfBirth", e.target.value)} /></Field>
                <Field label="State / county of birth" required name="stateOfBirth" error={fieldErrors}><Input value={form.stateOfBirth} onChange={(e) => set("stateOfBirth", e.target.value)} /></Field>
              </Two>
            </>
          )}
          {step === 1 && (
            <>
              <h2 ref={headingRef} tabIndex={-1} className="brand-wordmark text-xl focus:outline-none">I-9 Employment Eligibility</h2>
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
              <FileUploadField
                label="Completed Form I-9 (PDF or photos of all pages)"
                required
                accept="image/*,.pdf"
                value={form.i9Doc}
                onChange={(v) => set("i9Doc", v)}
                uploadFn={uploadFileAnon}
                error={errOnStep("i9Doc")}
              />
              <FileUploadField
                label="Social Security card (photo of front)"
                required
                accept="image/*,.pdf"
                value={form.ssnCardDoc}
                onChange={(v) => set("ssnCardDoc", v)}
                uploadFn={uploadFileAnon}
                error={errOnStep("ssnCardDoc")}
              />
              <Field label="Photo ID type" required name="idDocType" error={fieldErrors}>
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
              <FileUploadField
                label={
                  form.idDocType === "passport"
                    ? "Passport (photo of ID page)"
                    : form.idDocType === "drivers_license"
                    ? "Driver's License (photo of front)"
                    : "Photo ID (select type above first)"
                }
                required
                accept="image/*,.pdf"
                value={form.idDoc}
                onChange={(v) => set("idDoc", v)}
                uploadFn={uploadFileAnon}
                error={errOnStep("idDoc")}
              />
            </>
          )}
          {step === 2 && (
            <>
              <h2 ref={headingRef} tabIndex={-1} className="brand-wordmark text-xl focus:outline-none">TX security license &amp; experience</h2>
              <Two>
                <Field label="TX security license number" required name="siaLicenseNumber" error={fieldErrors}><Input value={form.siaLicenseNumber} onChange={(e) => set("siaLicenseNumber", e.target.value)} /></Field>
                <Field label="License level" required name="siaLicenseLevel" error={fieldErrors}>
                  <select className="w-full border rounded h-10 px-3 bg-background focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                    value={form.siaLicenseLevel} onChange={(e) => set("siaLicenseLevel", e.target.value)}>
                    <option value="">Select…</option>
                    <option value="2">L2 — Unarmed</option>
                    <option value="3">L3 — Armed</option>
                    <option value="4">L4 — PPO</option>
                  </select>
                </Field>
              </Two>
              <Two>
                <Field label="License expiry" required name="siaLicenseExpiry" error={fieldErrors}><Input type="date" value={form.siaLicenseExpiry} onChange={(e) => set("siaLicenseExpiry", e.target.value)} /></Field>
                <Field label="Years of experience" required name="yearsExperience" error={fieldErrors}><Input type="number" min={0} value={form.yearsExperience} onChange={(e) => set("yearsExperience", e.target.value)} /></Field>
              </Two>
              <Field label="Describe your previous security experience" required name="previousExperience" error={fieldErrors}>
                <Textarea rows={5} value={form.previousExperience} onChange={(e) => set("previousExperience", e.target.value)} />
              </Field>
            </>
          )}
          {step === 3 && (
            <>
              <h2 ref={headingRef} tabIndex={-1} className="brand-wordmark text-xl focus:outline-none">References &amp; documents</h2>
              <p className="text-sm text-muted-foreground">
                At least one complete reference is required (name, relationship, and phone).
              </p>
              {form.references.map((r, i) => (
                <fieldset key={i} className="p-3 border rounded space-y-2 bg-muted/30">
                  <legend className="text-xs uppercase tracking-wide opacity-70 px-1">
                    Reference {i + 1}{i === 0 ? " (required)" : " (optional)"}
                  </legend>
                  <Two>
                    <Field label="Name" required={i === 0} name={`ref:${i}:name`} error={fieldErrors}><Input value={r.name} onChange={(e) => setRef(i, "name", e.target.value)} /></Field>
                    <Field label="Relationship" required={i === 0} name={`ref:${i}:relationship`} error={fieldErrors}><Input value={r.relationship} onChange={(e) => setRef(i, "relationship", e.target.value)} /></Field>
                  </Two>
                  <Two>
                    <Field label="Phone" required={i === 0} name={`ref:${i}:phone`} error={fieldErrors}><Input type="tel" value={r.phone} onChange={(e) => setRef(i, "phone", e.target.value)} /></Field>
                    <Field label="Email"><Input type="email" value={r.email} onChange={(e) => setRef(i, "email", e.target.value)} /></Field>
                  </Two>
                </fieldset>
              ))}
              <Two>
                <FileUploadField label="Head & shoulders photo" required accept="image/*" value={form.photo} onChange={(v) => set("photo", v)} uploadFn={uploadFileAnon} error={errOnStep("photo")} />
                <FileUploadField label="CV (PDF / DOC)" required accept=".pdf,.doc,.docx" value={form.cv} onChange={(v) => set("cv", v)} uploadFn={uploadFileAnon} error={errOnStep("cv")} />
              </Two>
              <MultiFileUploadField
                label="Training certificates"
                required
                accept="image/*,.pdf"
                value={form.trainingCertificates}
                onChange={(v) => set("trainingCertificates", v)}
                uploadFn={uploadFileAnon}
                error={errOnStep("trainingCertificates")}
              />
            </>
          )}
          {step === 4 && (
            <AvailabilityGrid
              headingRef={headingRef}
              value={form.availability}
              onToggle={toggleAvail}
              error={errOnStep("availability")}
            />
          )}
          {step === 5 && (
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
                <Sum k="CV" v={form.cv ? form.cv.name : "—"} />
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
                          onClick={() => fe.field && setStep(stepForField(fe.field))}
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

          <div className="flex justify-between pt-4 border-t">
            <Button type="button" variant="ghost" disabled={step === 0 || submitting}
              onClick={() => setStep((s) => Math.max(0, s - 1))}>
              <ChevronLeft className="w-4 h-4 mr-1" aria-hidden="true" /> Back
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
  headingRef, value, onToggle, error,
}: {
  headingRef: React.Ref<HTMLHeadingElement>;
  value: { day: Day; period: Period }[];
  onToggle: (d: Day, p: Period) => void;
  error?: string;
}) {
  const errorId = useId();
  return (
    <>
      <h2 ref={headingRef} tabIndex={-1} className="brand-wordmark text-xl focus:outline-none">
        Availability <span className="text-destructive" aria-hidden="true">*</span>
        <span className="sr-only"> (required)</span>
      </h2>
      <p className="text-sm text-muted-foreground">
        Select each shift period you can usually work. At least one slot is required.
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
  label, name, error, children, required,
}: {
  label: string;
  name?: string;
  error?: FieldError[];
  children: ReactNode;
  required?: boolean;
}) {
  const fieldId = useId();
  const errorId = useId();
  const match = findFieldError(name, error ?? []);
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
      "aria-describedby": match ? errorId : el.props["aria-describedby"],
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
