import { useState } from "react";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { BrandHeader } from "@/components/BrandHeader";
import { FileUploadField, MultiFileUploadField } from "@/components/FileUploadField";
import type { UploadedFile } from "@/lib/upload";
import { CheckCircle2, ChevronLeft, ChevronRight } from "lucide-react";

const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
const PERIODS = ["morning", "afternoon", "evening", "overnight"] as const;
type Day = (typeof DAYS)[number];
type Period = (typeof PERIODS)[number];

type Reference = { name: string; relationship: string; phone: string; email: string };
type Form = {
  // Personal
  firstName: string; lastName: string; email: string; phone: string; address: string;
  dateOfBirth: string; cityOfBirth: string; stateOfBirth: string; niNumber: string;
  // Right to work
  rightToWorkStatus: string;
  rightToWorkDoc: UploadedFile | null;
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

const STEPS = ["Personal", "Right to work", "TX License & experience", "References & docs", "Availability", "Review"];

export function ApplyPage() {
  const [step, setStep] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<Form>({
    firstName: "", lastName: "", email: "", phone: "", address: "",
    dateOfBirth: "", cityOfBirth: "", stateOfBirth: "", niNumber: "",
    rightToWorkStatus: "", rightToWorkDoc: null,
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
      if (!form.address) return "Address is required.";
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
        dateOfBirth: form.dateOfBirth || null,
        cityOfBirth: form.cityOfBirth || null,
        stateOfBirth: form.stateOfBirth || null,
        niNumber: form.niNumber || null,
        rightToWorkStatus: form.rightToWorkStatus || null,
        rightToWorkDoc: form.rightToWorkDoc,
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
              <Field label="Full address *"><Textarea rows={2} value={form.address} onChange={(e) => set("address", e.target.value)} /></Field>
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
              <h2 className="brand-wordmark text-xl">Right to work</h2>
              <Field label="Status">
                <select
                  className="w-full border rounded h-10 px-3 bg-background"
                  value={form.rightToWorkStatus}
                  onChange={(e) => set("rightToWorkStatus", e.target.value)}
                >
                  <option value="">Select…</option>
                  <option value="us_citizen">US Citizen</option>
                  <option value="permanent_resident">Permanent Resident / Green Card</option>
                  <option value="work_visa">Employment Authorization (EAD/Visa)</option>
                  <option value="other">Other</option>
                </select>
              </Field>
              <FileUploadField
                label="Right-to-work document (passport, driver's license, EAD, I-9 docs)"
                accept="image/*,.pdf"
                value={form.rightToWorkDoc}
                onChange={(v) => set("rightToWorkDoc", v)}
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
                <FileUploadField label="Head & shoulders photo" accept="image/*" value={form.photo} onChange={(v) => set("photo", v)} />
                <FileUploadField label="CV (PDF / DOC)" accept=".pdf,.doc,.docx" value={form.cv} onChange={(v) => set("cv", v)} />
              </Two>
              <MultiFileUploadField label="Training certificates" accept="image/*,.pdf" value={form.trainingCertificates} onChange={(v) => set("trainingCertificates", v)} />
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
                <Sum k="Right-to-work" v={form.rightToWorkStatus || "—"} />
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
