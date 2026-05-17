import { useState } from "react";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { BrandHeader } from "@/components/BrandHeader";
import { FileUploadField, MultiFileUploadField } from "@/components/FileUploadField";
import { uploadFileAnon, type UploadedFile } from "@/lib/upload";
import { CheckCircle2, ChevronLeft, ChevronRight } from "lucide-react";

// Match the server-side normalizer in artifacts/api-server/src/lib/phone.ts.
// Strips non-digits, then: keeps a leading "+", defaults to US/+1 for 10
// digits, treats 11 digits starting with "1" as US/+1. Returns null otherwise.
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
const PERIODS = ["morning", "afternoon", "evening", "overnight"] as const;
type Day = (typeof DAYS)[number];
type Period = (typeof PERIODS)[number];

type Reference = { name: string; relationship: string; phone: string; email: string };
type Form = {
  // Personal
  firstName: string; lastName: string; email: string; phone: string;
  address: string; city: string; state: string; zip: string;
  dateOfBirth: string; cityOfBirth: string; stateOfBirth: string; niNumber: string;
  // I-9 Employment Eligibility (replaces generic "right to work")
  i9Doc: UploadedFile | null;
  ssnCardDoc: UploadedFile | null;
  idDocType: "" | "drivers_license" | "passport";
  idDoc: UploadedFile | null;
  // SIA
  siaLicenseNumber: string;
  siaLicenseLevel: string; // "" | "2" | "3" | "4"
  siaLicenseExpiry: string;
  previousExperience: string;
  yearsExperience: string;
  // References
  references: Reference[];
  // Files
  photo: UploadedFile | null;
  cv: UploadedFile | null;
  trainingCertificates: UploadedFile[];
  // Availability
  availability: { day: Day; period: Period }[];
};

const STEPS = ["Personal", "I-9 & Identity", "TX License & experience", "References & docs", "Availability", "Review"];

const I9_FORM_URL = "https://www.uscis.gov/sites/default/files/document/forms/i-9.pdf";

export function ApplyPage() {
  const [step, setStep] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);
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

  function canAdvance(): true | string {
    if (step === 0) {
      if (!form.firstName || !form.lastName) return "First and last name are required.";
      if (!form.email) return "Email is required.";
      if (!form.phone) return "Phone is required.";
      if (!normalizePhoneToE164(form.phone)) {
        return "Phone number is invalid. Please enter a valid US phone number (e.g. (214) 555-1234) or include the country code (e.g. +44 20 1234 5678).";
      }
      if (!form.address) return "Street address is required.";
      if (!form.city) return "City is required.";
      if (!form.state) return "State is required.";
      if (!form.zip) return "ZIP code is required.";
    }
    if (step === 1) {
      if (!form.i9Doc) return "Please upload your completed Form I-9.";
      if (!form.ssnCardDoc) return "Please upload a photo of your Social Security card.";
      if (!form.idDocType) return "Please select your photo ID type (driver's license or passport).";
      if (!form.idDoc) return "Please upload a photo of your driver's license or passport.";
    }
    if (step === 3) {
      // References step — phone is optional per reference, but if the
      // applicant typed something we want it to parse as a real number so
      // future reference-check SMS/voice flows don't silently skip it.
      for (let i = 0; i < form.references.length; i++) {
        const r = form.references[i];
        if (r.phone.trim() && !normalizePhoneToE164(r.phone)) {
          return `Reference #${i + 1} phone is invalid. Please enter a valid US phone number (e.g. (214) 555-1234) or include the country code (e.g. +44 20 1234 5678), or leave it blank.`;
        }
      }
    }
    return true;
  }

  async function submit() {
    setSubmitting(true);
    setError(null);
    try {
      const body = {
        firstName: form.firstName,
        lastName: form.lastName,
        email: form.email,
        phone: form.phone,
        address: form.address,
        city: form.city || null,
        state: form.state || null,
        zip: form.zip || null,
        dateOfBirth: form.dateOfBirth || null,
        cityOfBirth: form.cityOfBirth || null,
        stateOfBirth: form.stateOfBirth || null,
        niNumber: form.niNumber || null,
        i9Doc: form.i9Doc,
        ssnCardDoc: form.ssnCardDoc,
        idDocType: form.idDocType || null,
        idDoc: form.idDoc,
        siaLicenseNumber: form.siaLicenseNumber || null,
        siaLicenseLevel: form.siaLicenseLevel ? Number(form.siaLicenseLevel) : null,
        siaLicenseExpiry: form.siaLicenseExpiry || null,
        previousExperience: form.previousExperience || null,
        yearsExperience: form.yearsExperience ? Number(form.yearsExperience) : null,
        references: form.references.filter((r) => r.name.trim()).map((r) => ({
          name: r.name, relationship: r.relationship, phone: r.phone, email: r.email || undefined,
        })),
        photo: form.photo,
        cv: form.cv,
        trainingCertificates: form.trainingCertificates,
        availability: form.availability,
      };
      await api("/applications", { method: "POST", body });
      setSubmitted(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  if (submitted) {
    return (
      <div className="min-h-screen bg-background">
        <BrandHeader subtitle="Officer Application" />
        <main className="max-w-3xl mx-auto px-6 py-16 text-center space-y-4">
          <CheckCircle2 className="w-16 h-16 text-emerald-700 mx-auto" />
          <h1 className="brand-wordmark text-3xl">Thank you!</h1>
          <p className="text-muted-foreground">
            Your application has been received. Our HR team will review it and reach out
            shortly via email if you're shortlisted.
          </p>
        </main>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <BrandHeader subtitle="Officer Application" />
      <main className="max-w-3xl mx-auto px-6 py-8">
        <Stepper step={step} steps={STEPS} />
        <div className="mt-6 bg-card rounded-lg shadow-sm border p-6 space-y-5">
          {step === 0 && (
            <>
              <h2 className="brand-wordmark text-xl">Personal details</h2>
              <Two>
                <Field label="First name *"><Input value={form.firstName} onChange={(e) => set("firstName", e.target.value)} /></Field>
                <Field label="Last name *"><Input value={form.lastName} onChange={(e) => set("lastName", e.target.value)} /></Field>
              </Two>
              <Two>
                <Field label="Email *"><Input type="email" value={form.email} onChange={(e) => set("email", e.target.value)} /></Field>
                <Field label="Phone *"><Input value={form.phone} onChange={(e) => set("phone", e.target.value)} /></Field>
              </Two>
              <Field label="Street address *"><Textarea rows={2} value={form.address} onChange={(e) => set("address", e.target.value)} placeholder="Street, apt/unit" /></Field>
              <Two>
                <Field label="City *"><Input value={form.city} onChange={(e) => set("city", e.target.value)} /></Field>
                <Field label="State *"><Input value={form.state} onChange={(e) => set("state", e.target.value.toUpperCase().slice(0, 2))} placeholder="TX" maxLength={2} /></Field>
              </Two>
              <Two>
                <Field label="ZIP code *"><Input value={form.zip} onChange={(e) => set("zip", e.target.value)} placeholder="75001" /></Field>
                <div />
              </Two>
              <Two>
                <Field label="Date of birth"><Input type="date" value={form.dateOfBirth} onChange={(e) => set("dateOfBirth", e.target.value)} /></Field>
                <Field label="SSN (last 4)"><Input value={form.niNumber} onChange={(e) => set("niNumber", e.target.value)} /></Field>
              </Two>
              <Two>
                <Field label="City of birth"><Input value={form.cityOfBirth} onChange={(e) => set("cityOfBirth", e.target.value)} /></Field>
                <Field label="State / county of birth"><Input value={form.stateOfBirth} onChange={(e) => set("stateOfBirth", e.target.value)} /></Field>
              </Two>
            </>
          )}
          {step === 1 && (
            <>
              <h2 className="brand-wordmark text-xl">I-9 Employment Eligibility</h2>
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
                  ↓ Download blank Form I-9 (USCIS)
                </a>
                <div className="text-xs text-amber-900/80 mt-1">
                  Print, complete Section 1, sign and date, then scan or photograph all pages.
                </div>
              </div>
              <FileUploadField
                label="Completed Form I-9 (PDF or photos of all pages) *"
                accept="image/*,.pdf"
                value={form.i9Doc}
                onChange={(v) => set("i9Doc", v)}
                uploadFn={uploadFileAnon}
              />
              <FileUploadField
                label="Social Security card (photo of front) *"
                accept="image/*,.pdf"
                value={form.ssnCardDoc}
                onChange={(v) => set("ssnCardDoc", v)}
                uploadFn={uploadFileAnon}
              />
              <Field label="Photo ID type *">
                <select
                  className="w-full border rounded h-10 px-3 bg-background"
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
                    ? "Passport (photo of ID page) *"
                    : form.idDocType === "drivers_license"
                    ? "Driver's License (photo of front) *"
                    : "Photo ID (select type above first) *"
                }
                accept="image/*,.pdf"
                value={form.idDoc}
                onChange={(v) => set("idDoc", v)}
                uploadFn={uploadFileAnon}
              />
            </>
          )}
          {step === 2 && (
            <>
              <h2 className="brand-wordmark text-xl">TX security license & experience</h2>
              <Two>
                <Field label="TX security license number"><Input value={form.siaLicenseNumber} onChange={(e) => set("siaLicenseNumber", e.target.value)} /></Field>
                <Field label="License level">
                  <select className="w-full border rounded h-10 px-3 bg-background"
                    value={form.siaLicenseLevel} onChange={(e) => set("siaLicenseLevel", e.target.value)}>
                    <option value="">—</option>
                    <option value="2">L2 — Unarmed</option>
                    <option value="3">L3 — Armed</option>
                    <option value="4">L4 — PPO</option>
                  </select>
                </Field>
              </Two>
              <Two>
                <Field label="License expiry"><Input type="date" value={form.siaLicenseExpiry} onChange={(e) => set("siaLicenseExpiry", e.target.value)} /></Field>
                <Field label="Years of experience"><Input type="number" min={0} value={form.yearsExperience} onChange={(e) => set("yearsExperience", e.target.value)} /></Field>
              </Two>
              <Field label="Describe your previous security experience">
                <Textarea rows={5} value={form.previousExperience} onChange={(e) => set("previousExperience", e.target.value)} />
              </Field>
            </>
          )}
          {step === 3 && (
            <>
              <h2 className="brand-wordmark text-xl">References & documents</h2>
              {form.references.map((r, i) => (
                <div key={i} className="p-3 border rounded space-y-2 bg-muted/30">
                  <div className="text-xs uppercase tracking-wide opacity-70">Reference {i + 1}</div>
                  <Two>
                    <Field label="Name"><Input value={r.name} onChange={(e) => setRef(i, "name", e.target.value)} /></Field>
                    <Field label="Relationship"><Input value={r.relationship} onChange={(e) => setRef(i, "relationship", e.target.value)} /></Field>
                  </Two>
                  <Two>
                    <Field label="Phone"><Input value={r.phone} onChange={(e) => setRef(i, "phone", e.target.value)} /></Field>
                    <Field label="Email"><Input type="email" value={r.email} onChange={(e) => setRef(i, "email", e.target.value)} /></Field>
                  </Two>
                </div>
              ))}
              <Two>
                <FileUploadField label="Head & shoulders photo" accept="image/*" value={form.photo} onChange={(v) => set("photo", v)} uploadFn={uploadFileAnon} />
                <FileUploadField label="CV (PDF / DOC)" accept=".pdf,.doc,.docx" value={form.cv} onChange={(v) => set("cv", v)} uploadFn={uploadFileAnon} />
              </Two>
              <MultiFileUploadField label="Training certificates" accept="image/*,.pdf" value={form.trainingCertificates} onChange={(v) => set("trainingCertificates", v)} uploadFn={uploadFileAnon} />
            </>
          )}
          {step === 4 && (
            <>
              <h2 className="brand-wordmark text-xl">Availability</h2>
              <p className="text-sm text-muted-foreground">Tap each shift period you can usually work.</p>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr><th></th>{DAYS.map((d) => <th key={d} className="px-2 py-1 capitalize">{d}</th>)}</tr>
                  </thead>
                  <tbody>
                    {PERIODS.map((p) => (
                      <tr key={p}>
                        <td className="capitalize text-xs uppercase tracking-wide opacity-70 pr-2">{p}</td>
                        {DAYS.map((d) => {
                          const on = form.availability.some((c) => c.day === d && c.period === p);
                          return (
                            <td key={d} className="p-1">
                              <button
                                type="button" onClick={() => toggleAvail(d, p)}
                                className={`w-full h-8 rounded border text-xs ${on ? "bg-brand-navy text-white border-brand-navy" : "bg-background hover:bg-accent/40"}`}
                              >{on ? "✓" : ""}</button>
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
          {step === 5 && (
            <>
              <h2 className="brand-wordmark text-xl">Review & submit</h2>
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
              {error && <div className="text-sm text-destructive bg-destructive/5 p-2 rounded border border-destructive/20">{error}</div>}
            </>
          )}

          <div className="flex justify-between pt-4 border-t">
            <Button type="button" variant="ghost" disabled={step === 0 || submitting}
              onClick={() => setStep((s) => Math.max(0, s - 1))}>
              <ChevronLeft className="w-4 h-4 mr-1" /> Back
            </Button>
            {step < STEPS.length - 1 ? (
              <Button
                type="button"
                className="bg-brand-navy hover:opacity-90 text-white"
                onClick={() => {
                  const ok = canAdvance();
                  if (ok !== true) { setError(ok); return; }
                  setError(null);
                  setStep((s) => Math.min(STEPS.length - 1, s + 1));
                }}
              >Continue <ChevronRight className="w-4 h-4 ml-1" /></Button>
            ) : (
              <Button type="button" disabled={submitting}
                className="bg-brand-navy hover:opacity-90 text-white"
                onClick={submit}>
                {submitting ? "Submitting…" : "Submit application"}
              </Button>
            )}
          </div>
        </div>
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

function Stepper({ step, steps }: { step: number; steps: string[] }) {
  return (
    <ol className="flex flex-wrap gap-2 text-xs">
      {steps.map((s, i) => (
        <li key={s} className={`px-2 py-1 rounded border ${
          i === step ? "bg-brand-navy text-white border-brand-navy" :
          i < step ? "bg-accent/60 border-accent" : "bg-background opacity-60"
        }`}>
          {i + 1}. {s}
        </li>
      ))}
    </ol>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <Label className="text-xs uppercase font-semibold text-foreground/80">{label}</Label>
      {children}
    </div>
  );
}
function Two({ children }: { children: React.ReactNode }) {
  return <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">{children}</div>;
}
function Sum({ k, v }: { k: string; v: string }) {
  return (<><dt className="text-muted-foreground">{k}</dt><dd className="font-medium truncate">{v}</dd></>);
}
