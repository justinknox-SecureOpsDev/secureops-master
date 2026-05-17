import { useEffect, useState } from "react";
import { useRoute } from "wouter";
import { api, ApiError } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { BrandHeader } from "@/components/BrandHeader";
import { FileUploadField } from "@/components/FileUploadField";
import { uploadFileAnon, type UploadedFile } from "@/lib/upload";
import { CheckCircle2, AlertTriangle, Loader2, ChevronLeft, ChevronRight, FileText, ExternalLink } from "lucide-react";

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

type PolicyDto = {
  id: string;
  slug: string;
  label: string;
  version: number;
  fileKey: string | null;
  fileName: string | null;
  viewUrl: string | null;
};

type Prefill = {
  employeeId: string;
  firstName: string; lastName: string; email: string;
  phone?: string | null; address?: string | null;
  niNumber?: string | null; siaLicenseNumber?: string | null; siaLicenseLevel?: number | null;
  existing: boolean;
  policies: PolicyDto[];
};

const STEPS = ["Bank & tax", "Emergency & uniform", "Documents", "Consent & sign"];

export function OnboardPage() {
  const [, params] = useRoute("/onboard/:token");
  const token = params?.token ?? "";
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [prefill, setPrefill] = useState<Prefill | null>(null);
  const [step, setStep] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Form state
  const [bankSortCode, setBankSortCode] = useState("");
  const [bankAccountNumber, setBankAccountNumber] = useState("");
  const [bankAccountName, setBankAccountName] = useState("");
  const [niNumberConfirmed, setNiNumberConfirmed] = useState("");
  const [taxCode, setTaxCode] = useState("");
  const [p45Doc, setP45Doc] = useState<UploadedFile | null>(null);
  const [emergencyContactName, setEcn] = useState("");
  const [emergencyContactRelationship, setEcr] = useState("");
  const [emergencyContactPhone, setEcp] = useState("");
  const [uShirt, setUShirt] = useState("");
  const [uTrousers, setUTrousers] = useState("");
  const [uJacket, setUJacket] = useState("");
  const [uBoots, setUBoots] = useState("");
  const [siaLicenseDoc, setSiaDoc] = useState<UploadedFile | null>(null);
  const [passportDoc, setPassportDoc] = useState<UploadedFile | null>(null);
  const [directDepositConsent, setDdc] = useState(false);
  const [directDepositSignature, setDds] = useState("");
  const [acks, setAcks] = useState<Record<string, { accepted: boolean; signature: string }>>({});
  const [viewed, setViewed] = useState<Record<string, boolean>>({});

  const policies = prefill?.policies ?? [];

  useEffect(() => {
    if (!prefill) return;
    setAcks((prev) => {
      const next = { ...prev };
      for (const p of prefill.policies) {
        if (!next[p.slug]) next[p.slug] = { accepted: false, signature: "" };
      }
      return next;
    });
  }, [prefill]);

  useEffect(() => {
    if (!token) return;
    setLoading(true);
    api<Prefill>(`/onboarding/${encodeURIComponent(token)}`)
      .then((p) => {
        setPrefill(p);
        if (p.niNumber) setNiNumberConfirmed(p.niNumber);
      })
      .catch((e) => setLoadError(e instanceof ApiError ? e.message : (e as Error).message))
      .finally(() => setLoading(false));
  }, [token]);

  if (loading) {
    return (
      <div className="min-h-screen bg-background">
        <BrandHeader subtitle="Onboarding" />
        <main className="max-w-2xl mx-auto px-6 py-16 text-center text-muted-foreground">
          <Loader2 className="w-8 h-8 animate-spin mx-auto mb-2" />
          Loading your onboarding…
        </main>
      </div>
    );
  }
  if (loadError || !prefill) {
    return (
      <div className="min-h-screen bg-background">
        <BrandHeader subtitle="Onboarding" />
        <main className="max-w-2xl mx-auto px-6 py-16 text-center space-y-3">
          <AlertTriangle className="w-12 h-12 text-amber-600 mx-auto" />
          <h1 className="brand-wordmark text-2xl">Onboarding link unavailable</h1>
          <p className="text-muted-foreground">{loadError || "This link can't be opened."}</p>
          <p className="text-xs text-muted-foreground">Please contact HR for a fresh onboarding link.</p>
        </main>
      </div>
    );
  }

  if (submitted) {
    return (
      <div className="min-h-screen bg-background">
        <BrandHeader subtitle="Onboarding" />
        <main className="max-w-2xl mx-auto px-6 py-16 text-center space-y-4">
          <CheckCircle2 className="w-16 h-16 text-emerald-700 mx-auto" />
          <h1 className="brand-wordmark text-3xl">You're onboarded!</h1>
          <p className="text-muted-foreground">
            Welcome to Williams Council Security Group, {prefill.firstName}. HR will reach out
            with your start details and credentials for the SecureOps mobile app.
          </p>
        </main>
      </div>
    );
  }

  function canAdvance(): true | string {
    if (step === 0) {
      if (!bankSortCode || !bankAccountNumber || !bankAccountName) return "All bank details are required.";
    }
    if (step === 1) {
      if (!emergencyContactName || !emergencyContactPhone) return "Emergency contact name and phone required.";
      if (!normalizePhoneToE164(emergencyContactPhone)) {
        return "Emergency contact phone is invalid. Please enter a valid US phone number (e.g. (214) 555-1234) or include the country code (e.g. +44 20 1234 5678).";
      }
    }
    if (step === 3) {
      if (!directDepositConsent) return "Please confirm direct deposit consent.";
      if (!directDepositSignature.trim()) return "Please type your name as signature.";
      for (const p of policies) {
        if (!viewed[p.slug]) return `Please click "Open document to read" for: ${p.label}`;
        const v = acks[p.slug];
        if (!v?.accepted) return `Please acknowledge: ${p.label}`;
        if (!v.signature.trim()) return `Please sign: ${p.label}`;
      }
    }
    return true;
  }

  async function submit() {
    setSubmitting(true);
    setError(null);
    try {
      const now = new Date().toISOString();
      const body = {
        bankSortCode, bankAccountNumber, bankAccountName,
        niNumberConfirmed: niNumberConfirmed || null,
        taxCode: taxCode || null,
        p45Doc,
        emergencyContactName, emergencyContactRelationship: emergencyContactRelationship || null, emergencyContactPhone,
        uniformShirt: uShirt || null,
        uniformTrousers: uTrousers || null,
        uniformJacket: uJacket || null,
        uniformBoots: uBoots || null,
        siaLicenseDoc, passportDoc,
        directDepositConsent, directDepositSignature,
        acknowledgements: policies.map((p) => ({
          type: p.slug,
          accepted: acks[p.slug]?.accepted ?? false,
          signature: acks[p.slug]?.signature ?? "",
          timestamp: now,
          // Bind the signature to the EXACT policy version the applicant
          // viewed at prefill time. Server rejects the submission if this
          // does not match a currently-active version of the same slug.
          policyId: p.id,
          policyVersion: p.version,
        })),
      };
      await api(`/onboarding/${encodeURIComponent(token)}`, { method: "POST", body });
      setSubmitted(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen bg-background">
      <BrandHeader subtitle={`Onboarding · ${prefill.firstName} ${prefill.lastName}`} />
      <main className="max-w-2xl mx-auto px-6 py-8">
        {prefill.existing && (
          <div className="mb-4 text-sm bg-amber-50 border border-amber-200 text-amber-900 p-2 rounded">
            You've previously submitted onboarding info — submitting again will update it.
          </div>
        )}
        <ol className="flex flex-wrap gap-2 text-xs">
          {STEPS.map((s, i) => (
            <li key={s} className={`px-2 py-1 rounded border ${
              i === step ? "bg-brand-navy text-white border-brand-navy" :
              i < step ? "bg-accent/60 border-accent" : "bg-background opacity-60"
            }`}>{i + 1}. {s}</li>
          ))}
        </ol>
        <div className="mt-6 bg-card rounded-lg shadow-sm border p-6 space-y-5">
          {step === 0 && (
            <>
              <h2 className="brand-wordmark text-xl">Bank & tax details</h2>
              <Two>
                <Field label="Bank routing number *"><Input value={bankSortCode} onChange={(e) => setBankSortCode(e.target.value)} placeholder="9 digits" /></Field>
                <Field label="Account number *"><Input value={bankAccountNumber} onChange={(e) => setBankAccountNumber(e.target.value)} /></Field>
              </Two>
              <Field label="Account holder name *"><Input value={bankAccountName} onChange={(e) => setBankAccountName(e.target.value)} /></Field>
              <Two>
                <Field label="SSN"><Input value={niNumberConfirmed} onChange={(e) => setNiNumberConfirmed(e.target.value)} placeholder="xxx-xx-xxxx" /></Field>
                <Field label="W-4 filing status"><Input value={taxCode} onChange={(e) => setTaxCode(e.target.value)} placeholder="e.g. Single, Married" /></Field>
              </Two>
              <FileUploadField label="Prior W-2 / final pay stub (if available)" accept=".pdf,image/*" value={p45Doc} onChange={setP45Doc} uploadFn={uploadFileAnon} />
            </>
          )}
          {step === 1 && (
            <>
              <h2 className="brand-wordmark text-xl">Emergency contact & uniform</h2>
              <Two>
                <Field label="Contact name *"><Input value={emergencyContactName} onChange={(e) => setEcn(e.target.value)} /></Field>
                <Field label="Relationship"><Input value={emergencyContactRelationship} onChange={(e) => setEcr(e.target.value)} /></Field>
              </Two>
              <Field label="Phone *"><Input value={emergencyContactPhone} onChange={(e) => setEcp(e.target.value)} /></Field>
              <h3 className="text-sm uppercase tracking-wide opacity-70 pt-3">Uniform sizes</h3>
              <Two>
                <Field label="Shirt"><Input value={uShirt} onChange={(e) => setUShirt(e.target.value)} placeholder="S / M / L / XL" /></Field>
                <Field label="Pants"><Input value={uTrousers} onChange={(e) => setUTrousers(e.target.value)} placeholder="W32 L32" /></Field>
              </Two>
              <Two>
                <Field label="Jacket"><Input value={uJacket} onChange={(e) => setUJacket(e.target.value)} /></Field>
                <Field label="Boots"><Input value={uBoots} onChange={(e) => setUBoots(e.target.value)} placeholder="US size" /></Field>
              </Two>
            </>
          )}
          {step === 2 && (
            <>
              <h2 className="brand-wordmark text-xl">Documents</h2>
              <FileUploadField label="TX security license (photo of card)" accept="image/*,.pdf" value={siaLicenseDoc} onChange={setSiaDoc} uploadFn={uploadFileAnon} />
              <FileUploadField label="Passport / driver's license / right-to-work document" accept="image/*,.pdf" value={passportDoc} onChange={setPassportDoc} uploadFn={uploadFileAnon} />
            </>
          )}
          {step === 3 && (
            <>
              <h2 className="brand-wordmark text-xl">Consent & acknowledgements</h2>
              <div className="p-3 border rounded space-y-2 bg-muted/20">
                <label className="flex items-start gap-2 cursor-pointer">
                  <Checkbox checked={directDepositConsent} onCheckedChange={(v) => setDdc(!!v)} className="mt-0.5" />
                  <span className="text-sm">
                    I authorise Williams Council Security Group to pay my wages by direct deposit
                    into the bank account specified above.
                  </span>
                </label>
                <Field label="Type your full name as signature *">
                  <Input value={directDepositSignature} onChange={(e) => setDds(e.target.value)} placeholder="Your full name" />
                </Field>
              </div>
              {policies.length === 0 && (
                <div className="text-sm text-muted-foreground italic p-3 border rounded">
                  No policies require acknowledgement at this time.
                </div>
              )}
              {policies.map((p) => {
                const isViewed = !!viewed[p.slug];
                const ack = acks[p.slug] ?? { accepted: false, signature: "" };
                return (
                  <div key={p.slug} className="border rounded bg-muted/20 overflow-hidden">
                    <div className="flex items-center justify-between gap-2 p-3 bg-background border-b">
                      <div className="flex items-center gap-2 min-w-0">
                        <FileText className="w-4 h-4 brand-gold shrink-0" />
                        <div className="min-w-0">
                          <div className="text-sm font-medium truncate">{p.label}</div>
                          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                            {p.fileName ?? "Document"} · v{p.version}
                          </div>
                        </div>
                      </div>
                      {p.viewUrl && (
                        <a
                          href={p.viewUrl}
                          target="_blank"
                          rel="noreferrer"
                          onClick={() => setViewed((prev) => ({ ...prev, [p.slug]: true }))}
                          className={`shrink-0 inline-flex items-center gap-1 text-xs px-2 py-1 rounded border hover:bg-accent/50 ${
                            isViewed ? "border-emerald-300 bg-emerald-50 text-emerald-800" : "border-brand-gold text-brand-navy"
                          }`}
                        >
                          {isViewed
                            ? <><CheckCircle2 className="w-3.5 h-3.5" /> Opened</>
                            : <><ExternalLink className="w-3.5 h-3.5" /> Open document to read</>}
                        </a>
                      )}
                    </div>
                    {p.viewUrl ? (
                      <iframe
                        src={p.viewUrl}
                        title={p.label}
                        className="w-full h-72 bg-white border-b"
                      />
                    ) : (
                      <div className="p-4 text-sm text-muted-foreground italic border-b">
                        Document is not currently available — please contact HR.
                      </div>
                    )}
                    <div className="p-3 space-y-2">
                      <label
                        className={`flex items-start gap-2 ${isViewed ? "cursor-pointer" : "opacity-60 cursor-not-allowed"}`}
                        title={isViewed ? "" : "Click 'Open document to read' first"}
                      >
                        <Checkbox
                          checked={ack.accepted}
                          disabled={!isViewed}
                          onCheckedChange={(v) =>
                            setAcks((prev) => ({ ...prev, [p.slug]: { ...(prev[p.slug] ?? { accepted: false, signature: "" }), accepted: !!v } }))
                          }
                          className="mt-0.5"
                        />
                        <span className="text-sm font-medium">
                          I have read and accept the {p.label}.
                          {!isViewed && <span className="block text-xs text-muted-foreground font-normal mt-0.5">Open the document via the "Open document to read" link above to enable this checkbox.</span>}
                        </span>
                      </label>
                      <Input
                        placeholder="Type full name to sign"
                        value={ack.signature}
                        disabled={!isViewed}
                        onChange={(e) =>
                          setAcks((prev) => ({ ...prev, [p.slug]: { ...(prev[p.slug] ?? { accepted: false, signature: "" }), signature: e.target.value } }))
                        }
                      />
                    </div>
                  </div>
                );
              })}
              {error && <div className="text-sm text-destructive bg-destructive/5 p-2 rounded border border-destructive/20">{error}</div>}
            </>
          )}

          <div className="flex justify-between pt-4 border-t">
            <Button type="button" variant="ghost" disabled={step === 0 || submitting}
              onClick={() => setStep((s) => Math.max(0, s - 1))}>
              <ChevronLeft className="w-4 h-4 mr-1" /> Back
            </Button>
            {step < STEPS.length - 1 ? (
              <Button type="button" className="bg-brand-navy hover:opacity-90 text-white"
                onClick={() => {
                  const ok = canAdvance();
                  if (ok !== true) { setError(ok); return; }
                  setError(null);
                  setStep((s) => s + 1);
                }}
              >Continue <ChevronRight className="w-4 h-4 ml-1" /></Button>
            ) : (
              <Button type="button" disabled={submitting}
                className="bg-brand-navy hover:opacity-90 text-white"
                onClick={() => {
                  const ok = canAdvance();
                  if (ok !== true) { setError(ok); return; }
                  submit();
                }}>
                {submitting ? "Submitting…" : "Complete onboarding"}
              </Button>
            )}
          </div>
        </div>
      </main>
    </div>
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
