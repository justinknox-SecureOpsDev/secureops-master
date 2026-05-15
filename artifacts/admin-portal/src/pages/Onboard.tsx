import { useEffect, useState } from "react";
import { useRoute } from "wouter";
import { api, ApiError } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { BrandHeader } from "@/components/BrandHeader";
import { FileUploadField } from "@/components/FileUploadField";
import type { UploadedFile } from "@/lib/upload";
import { CheckCircle2, AlertTriangle, Loader2, ChevronLeft, ChevronRight } from "lucide-react";

type Prefill = {
  employeeId: string;
  firstName: string; lastName: string; email: string;
  phone?: string | null; address?: string | null;
  niNumber?: string | null; siaLicenseNumber?: string | null; siaLicenseLevel?: number | null;
  existing: boolean;
};

const ACK_TYPES = [
  { type: "drug_free", label: "Drug-Free Workplace Policy" },
  { type: "uniform_sou", label: "Uniform Standard of Use" },
  { type: "non_disclosure", label: "Non-Disclosure Agreement" },
  { type: "contract", label: "Employment Contract" },
] as const;

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
  const [acks, setAcks] = useState<Record<string, { accepted: boolean; signature: string }>>(
    () => Object.fromEntries(ACK_TYPES.map((a) => [a.type, { accepted: false, signature: "" }])),
  );

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
    }
    if (step === 3) {
      if (!directDepositConsent) return "Please confirm direct deposit consent.";
      if (!directDepositSignature.trim()) return "Please type your name as signature.";
      for (const a of ACK_TYPES) {
        const v = acks[a.type];
        if (!v.accepted) return `Please acknowledge: ${a.label}`;
        if (!v.signature.trim()) return `Please sign: ${a.label}`;
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
        acknowledgements: ACK_TYPES.map((a) => ({
          type: a.type, accepted: acks[a.type].accepted,
          signature: acks[a.type].signature, timestamp: now,
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
                <Field label="Sort code *"><Input value={bankSortCode} onChange={(e) => setBankSortCode(e.target.value)} placeholder="00-00-00" /></Field>
                <Field label="Account number *"><Input value={bankAccountNumber} onChange={(e) => setBankAccountNumber(e.target.value)} /></Field>
              </Two>
              <Field label="Account holder name *"><Input value={bankAccountName} onChange={(e) => setBankAccountName(e.target.value)} /></Field>
              <Two>
                <Field label="National Insurance number"><Input value={niNumberConfirmed} onChange={(e) => setNiNumberConfirmed(e.target.value)} /></Field>
                <Field label="Tax code"><Input value={taxCode} onChange={(e) => setTaxCode(e.target.value)} placeholder="e.g. 1257L" /></Field>
              </Two>
              <FileUploadField label="P45 (if available)" accept=".pdf,image/*" value={p45Doc} onChange={setP45Doc} />
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
                <Field label="Trousers"><Input value={uTrousers} onChange={(e) => setUTrousers(e.target.value)} placeholder="W32 L32" /></Field>
              </Two>
              <Two>
                <Field label="Jacket"><Input value={uJacket} onChange={(e) => setUJacket(e.target.value)} /></Field>
                <Field label="Boots"><Input value={uBoots} onChange={(e) => setUBoots(e.target.value)} placeholder="UK size" /></Field>
              </Two>
            </>
          )}
          {step === 2 && (
            <>
              <h2 className="brand-wordmark text-xl">Documents</h2>
              <FileUploadField label="SIA licence (photo of card)" accept="image/*,.pdf" value={siaLicenseDoc} onChange={setSiaDoc} />
              <FileUploadField label="Passport / right-to-work document" accept="image/*,.pdf" value={passportDoc} onChange={setPassportDoc} />
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
              {ACK_TYPES.map((a) => (
                <div key={a.type} className="p-3 border rounded space-y-2 bg-muted/20">
                  <label className="flex items-start gap-2 cursor-pointer">
                    <Checkbox
                      checked={acks[a.type].accepted}
                      onCheckedChange={(v) => setAcks((prev) => ({ ...prev, [a.type]: { ...prev[a.type], accepted: !!v } }))}
                      className="mt-0.5"
                    />
                    <span className="text-sm font-medium">I acknowledge & accept the {a.label}.</span>
                  </label>
                  <Input
                    placeholder="Type full name to sign"
                    value={acks[a.type].signature}
                    onChange={(e) => setAcks((prev) => ({ ...prev, [a.type]: { ...prev[a.type], signature: e.target.value } }))}
                  />
                </div>
              ))}
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
