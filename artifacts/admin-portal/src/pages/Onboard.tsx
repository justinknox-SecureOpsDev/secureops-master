import { cloneElement, isValidElement, useEffect, useId, useRef, useState, type ReactElement, type ReactNode } from "react";
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

type StepError = { field?: string; message: string };

export function OnboardPage() {
  const [, params] = useRoute("/onboard/:token");
  const token = params?.token ?? "";
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [prefill, setPrefill] = useState<Prefill | null>(null);
  const [step, setStep] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<StepError | null>(null);
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  // Skip the first focus so we don't yank focus past the brand header
  // when the page first renders.
  const initialMount = useRef(true);

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

  useEffect(() => {
    if (loading || !prefill) return;
    if (initialMount.current) {
      initialMount.current = false;
      return;
    }
    // Move keyboard focus to the new step's heading so screen readers
    // announce the change instead of leaving focus on the Continue button.
    headingRef.current?.focus();
  }, [step, submitted, loading, prefill]);

  // Clear a stale step error as soon as the offending control becomes
  // valid, so aria-invalid / the inline alert don't outlive the problem.
  useEffect(() => {
    if (!error) return;
    const stillFailing = canAdvance();
    if (!stillFailing || stillFailing.field !== error.field) {
      setError(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    bankSortCode, bankAccountNumber, bankAccountName,
    emergencyContactName, emergencyContactPhone,
    directDepositConsent, directDepositSignature,
    viewed, acks,
  ]);

  if (loading) {
    return (
      <div className="min-h-screen bg-background">
        <BrandHeader subtitle="Onboarding" />
        <main className="max-w-2xl mx-auto px-6 py-16 text-center text-muted-foreground" role="status" aria-live="polite">
          <Loader2 className="w-8 h-8 animate-spin mx-auto mb-2" aria-hidden="true" />
          Loading your onboarding…
        </main>
      </div>
    );
  }
  if (loadError || !prefill) {
    return (
      <div className="min-h-screen bg-background">
        <BrandHeader subtitle="Onboarding" />
        <main className="max-w-2xl mx-auto px-6 py-16 text-center space-y-3" role="alert">
          <AlertTriangle className="w-12 h-12 text-amber-600 mx-auto" aria-hidden="true" />
          <h1 className="brand-wordmark text-2xl" tabIndex={-1} ref={headingRef}>Onboarding link unavailable</h1>
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
          <CheckCircle2 className="w-16 h-16 text-emerald-700 mx-auto" aria-hidden="true" />
          <h1 className="brand-wordmark text-3xl" tabIndex={-1} ref={headingRef}>You're onboarded!</h1>
          <p className="text-muted-foreground">
            Welcome to Williams Council Security Group, {prefill.firstName}. HR will reach out
            with your start details and credentials for the SecureOps mobile app.
          </p>
        </main>
      </div>
    );
  }

  function canAdvance(): StepError | null {
    if (step === 0) {
      if (!bankSortCode) return { field: "bankSortCode", message: "Bank routing number is required." };
      if (!bankAccountNumber) return { field: "bankAccountNumber", message: "Account number is required." };
      if (!bankAccountName) return { field: "bankAccountName", message: "Account holder name is required." };
    }
    if (step === 1) {
      if (!emergencyContactName) return { field: "emergencyContactName", message: "Emergency contact name is required." };
      if (!emergencyContactPhone) return { field: "emergencyContactPhone", message: "Emergency contact phone is required." };
      if (!normalizePhoneToE164(emergencyContactPhone)) {
        return { field: "emergencyContactPhone", message: "Emergency contact phone is invalid. Please enter a valid US phone number (e.g. (214) 555-1234) or include the country code (e.g. +44 20 1234 5678)." };
      }
    }
    if (step === 3) {
      if (!directDepositConsent) return { field: "directDepositConsent", message: "Please confirm direct deposit consent." };
      if (!directDepositSignature.trim()) return { field: "directDepositSignature", message: "Please type your name as signature." };
      for (const p of policies) {
        if (!viewed[p.slug]) return { field: `policy:${p.slug}:view`, message: `Please open the document for: ${p.label}` };
        const v = acks[p.slug];
        if (!v?.accepted) return { field: `policy:${p.slug}:ack`, message: `Please acknowledge: ${p.label}` };
        if (!v.signature.trim()) return { field: `policy:${p.slug}:sig`, message: `Please sign: ${p.label}` };
      }
    }
    return null;
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
          policyId: p.id,
          policyVersion: p.version,
        })),
      };
      await api(`/onboarding/${encodeURIComponent(token)}`, { method: "POST", body });
      setSubmitted(true);
    } catch (e) {
      setError({ message: (e as Error).message });
    } finally {
      setSubmitting(false);
    }
  }

  const stepLabel = STEPS[step];

  return (
    <div className="min-h-screen bg-background">
      <BrandHeader subtitle={`Onboarding · ${prefill.firstName} ${prefill.lastName}`} />
      <main className="max-w-2xl mx-auto px-6 py-8">
        {/* Polite step-change announcement for screen readers. */}
        <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">
          Step {step + 1} of {STEPS.length}: {stepLabel}
        </div>
        {prefill.existing && (
          <div className="mb-4 text-sm bg-amber-50 border border-amber-200 text-amber-900 p-2 rounded" role="status">
            You've previously submitted onboarding info — submitting again will update it.
          </div>
        )}
        <ol className="flex flex-wrap gap-2 text-xs" aria-label="Onboarding progress">
          {STEPS.map((s, i) => (
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
        <form
          noValidate
          onSubmit={(e) => e.preventDefault()}
          aria-label={`Onboarding, step ${step + 1} of ${STEPS.length}: ${stepLabel}`}
          className="mt-6 bg-card rounded-lg shadow-sm border p-6 space-y-5"
        >
          {step === 0 && (
            <>
              <h2 ref={headingRef} tabIndex={-1} className="brand-wordmark text-xl focus:outline-none">Bank &amp; tax details</h2>
              <Two>
                <Field label="Bank routing number" required name="bankSortCode" error={error}><Input inputMode="numeric" value={bankSortCode} onChange={(e) => setBankSortCode(e.target.value)} placeholder="9 digits" /></Field>
                <Field label="Account number" required name="bankAccountNumber" error={error}><Input inputMode="numeric" value={bankAccountNumber} onChange={(e) => setBankAccountNumber(e.target.value)} /></Field>
              </Two>
              <Field label="Account holder name" required name="bankAccountName" error={error}><Input autoComplete="name" value={bankAccountName} onChange={(e) => setBankAccountName(e.target.value)} /></Field>
              <Two>
                <Field label="SSN"><Input value={niNumberConfirmed} onChange={(e) => setNiNumberConfirmed(e.target.value)} placeholder="xxx-xx-xxxx" /></Field>
                <Field label="W-4 filing status"><Input value={taxCode} onChange={(e) => setTaxCode(e.target.value)} placeholder="e.g. Single, Married" /></Field>
              </Two>
              <FileUploadField label="Prior W-2 / final pay stub (if available)" accept=".pdf,image/*" value={p45Doc} onChange={setP45Doc} uploadFn={uploadFileAnon} />
            </>
          )}
          {step === 1 && (
            <>
              <h2 ref={headingRef} tabIndex={-1} className="brand-wordmark text-xl focus:outline-none">Emergency contact &amp; uniform</h2>
              <Two>
                <Field label="Contact name" required name="emergencyContactName" error={error}><Input value={emergencyContactName} onChange={(e) => setEcn(e.target.value)} /></Field>
                <Field label="Relationship"><Input value={emergencyContactRelationship} onChange={(e) => setEcr(e.target.value)} /></Field>
              </Two>
              <Field label="Phone" required name="emergencyContactPhone" error={error}><Input type="tel" value={emergencyContactPhone} onChange={(e) => setEcp(e.target.value)} /></Field>
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
              <h2 ref={headingRef} tabIndex={-1} className="brand-wordmark text-xl focus:outline-none">Documents</h2>
              <FileUploadField label="TX security license (photo of card)" accept="image/*,.pdf" value={siaLicenseDoc} onChange={setSiaDoc} uploadFn={uploadFileAnon} error={error?.field === "siaLicenseDoc" ? error.message : undefined} />
              <FileUploadField label="Passport / driver's license / right-to-work document" accept="image/*,.pdf" value={passportDoc} onChange={setPassportDoc} uploadFn={uploadFileAnon} error={error?.field === "passportDoc" ? error.message : undefined} />
            </>
          )}
          {step === 3 && (
            <>
              <h2 ref={headingRef} tabIndex={-1} className="brand-wordmark text-xl focus:outline-none">Consent &amp; acknowledgements</h2>
              <ConsentBlock
                consent={directDepositConsent}
                onConsentChange={setDdc}
                signature={directDepositSignature}
                onSignatureChange={setDds}
                consentError={error?.field === "directDepositConsent" ? error.message : undefined}
                signatureError={error?.field === "directDepositSignature" ? error.message : undefined}
              />
              {policies.length === 0 && (
                <div className="text-sm text-muted-foreground italic p-3 border rounded">
                  No policies require acknowledgement at this time.
                </div>
              )}
              {policies.map((p) => (
                <PolicyAck
                  key={p.slug}
                  policy={p}
                  viewed={!!viewed[p.slug]}
                  onView={() => setViewed((prev) => ({ ...prev, [p.slug]: true }))}
                  ack={acks[p.slug] ?? { accepted: false, signature: "" }}
                  onChange={(next) =>
                    setAcks((prev) => ({ ...prev, [p.slug]: next }))
                  }
                  viewError={error?.field === `policy:${p.slug}:view` ? error.message : undefined}
                  ackError={error?.field === `policy:${p.slug}:ack` ? error.message : undefined}
                  sigError={error?.field === `policy:${p.slug}:sig` ? error.message : undefined}
                />
              ))}
              {error && (
                <div role="alert" className="text-sm text-destructive bg-destructive/5 p-2 rounded border border-destructive/20">
                  {error.message}
                </div>
              )}
            </>
          )}

          {/* Error from in-step canAdvance() for steps 0-2 (step 3 renders its own error block above). */}
          {step !== 3 && error && (
            <div role="alert" className="text-sm text-destructive bg-destructive/5 p-2 rounded border border-destructive/20">
              {error.message}
            </div>
          )}

          <div className="flex justify-between pt-4 border-t">
            <Button type="button" variant="ghost" disabled={step === 0 || submitting}
              onClick={() => setStep((s) => Math.max(0, s - 1))}>
              <ChevronLeft className="w-4 h-4 mr-1" aria-hidden="true" /> Back
            </Button>
            {step < STEPS.length - 1 ? (
              <Button type="button" className="bg-brand-navy hover:opacity-90 text-white"
                onClick={() => {
                  const err = canAdvance();
                  if (err) { setError(err); return; }
                  setError(null);
                  setStep((s) => s + 1);
                }}
              >Continue <ChevronRight className="w-4 h-4 ml-1" aria-hidden="true" /></Button>
            ) : (
              <Button type="submit" disabled={submitting}
                className="bg-brand-navy hover:opacity-90 text-white"
                onClick={() => {
                  const err = canAdvance();
                  if (err) { setError(err); return; }
                  submit();
                }}>
                {submitting ? "Submitting…" : "Complete onboarding"}
              </Button>
            )}
          </div>
        </form>
      </main>
    </div>
  );
}

function ConsentBlock({
  consent, onConsentChange, signature, onSignatureChange,
  consentError, signatureError,
}: {
  consent: boolean;
  onConsentChange: (v: boolean) => void;
  signature: string;
  onSignatureChange: (v: string) => void;
  consentError?: string;
  signatureError?: string;
}) {
  const consentId = useId();
  const sigId = useId();
  const consentErrorId = useId();
  const sigErrorId = useId();
  return (
    <div className="p-3 border rounded space-y-2 bg-muted/20">
      <div className="flex items-start gap-2">
        <Checkbox
          id={consentId}
          checked={consent}
          onCheckedChange={(v) => onConsentChange(!!v)}
          className="mt-0.5"
          aria-required="true"
          aria-invalid={consentError ? true : undefined}
          aria-describedby={consentError ? consentErrorId : undefined}
        />
        <Label htmlFor={consentId} className="text-sm font-normal cursor-pointer leading-snug">
          I authorise Williams Council Security Group to pay my wages by direct deposit
          into the bank account specified above.
          <span className="sr-only"> (required)</span>
        </Label>
      </div>
      {consentError && (
        <div id={consentErrorId} role="alert" className="text-xs text-destructive">{consentError}</div>
      )}
      <div className="space-y-1">
        <Label htmlFor={sigId} className="text-xs uppercase font-semibold text-foreground/80">
          Type your full name as signature
          <span className="text-destructive ml-0.5" aria-hidden="true">*</span>
          <span className="sr-only"> (required)</span>
        </Label>
        <Input
          id={sigId}
          value={signature}
          onChange={(e) => onSignatureChange(e.target.value)}
          placeholder="Your full name"
          autoComplete="name"
          aria-required="true"
          aria-invalid={signatureError ? true : undefined}
          aria-describedby={signatureError ? sigErrorId : undefined}
        />
        {signatureError && (
          <div id={sigErrorId} role="alert" className="text-xs text-destructive">{signatureError}</div>
        )}
      </div>
    </div>
  );
}

function PolicyAck({
  policy, viewed, onView, ack, onChange,
  viewError, ackError, sigError,
}: {
  policy: PolicyDto;
  viewed: boolean;
  onView: () => void;
  ack: { accepted: boolean; signature: string };
  onChange: (next: { accepted: boolean; signature: string }) => void;
  viewError?: string;
  ackError?: string;
  sigError?: string;
}) {
  const ackId = useId();
  const sigId = useId();
  const helpId = useId();
  const viewErrorId = useId();
  const ackErrorId = useId();
  const sigErrorId = useId();
  return (
    <div className="border rounded bg-muted/20 overflow-hidden">
      <div className="flex items-center justify-between gap-2 p-3 bg-background border-b">
        <div className="flex items-center gap-2 min-w-0">
          <FileText className="w-4 h-4 brand-gold shrink-0" aria-hidden="true" />
          <div className="min-w-0">
            <div className="text-sm font-medium truncate">{policy.label}</div>
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
              {policy.fileName ?? "Document"} · v{policy.version}
            </div>
          </div>
        </div>
        {policy.viewUrl && (
          <a
            href={policy.viewUrl}
            target="_blank"
            rel="noreferrer"
            onClick={onView}
            aria-label={
              viewed
                ? `${policy.label} document opened`
                : `Open ${policy.label} document in a new tab`
            }
            className={`shrink-0 inline-flex items-center gap-1 text-xs px-2 py-1 rounded border hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring ${
              viewed ? "border-emerald-300 bg-emerald-50 text-emerald-800" : "border-brand-gold text-brand-navy"
            }`}
          >
            {viewed
              ? <><CheckCircle2 className="w-3.5 h-3.5" aria-hidden="true" /> Opened</>
              : <><ExternalLink className="w-3.5 h-3.5" aria-hidden="true" /> Open document to read</>}
          </a>
        )}
      </div>
      {policy.viewUrl ? (
        <iframe
          src={policy.viewUrl}
          title={`${policy.label} document preview`}
          className="w-full h-72 bg-white border-b"
        />
      ) : (
        <div className="p-4 text-sm text-muted-foreground italic border-b">
          Document is not currently available — please contact HR.
        </div>
      )}
      <div className="p-3 space-y-2">
        {viewError && (
          <div id={viewErrorId} role="alert" className="text-xs text-destructive">{viewError}</div>
        )}
        <div className={`flex items-start gap-2 ${viewed ? "" : "opacity-60"}`}>
          <Checkbox
            id={ackId}
            checked={ack.accepted}
            disabled={!viewed}
            onCheckedChange={(v) => onChange({ ...ack, accepted: !!v })}
            className="mt-0.5"
            aria-describedby={[!viewed ? helpId : null, ackError ? ackErrorId : null].filter(Boolean).join(" ") || undefined}
            aria-invalid={ackError ? true : undefined}
            aria-required="true"
          />
          <Label
            htmlFor={ackId}
            className={`text-sm font-medium leading-snug ${viewed ? "cursor-pointer" : "cursor-not-allowed"}`}
          >
            I have read and accept the {policy.label}.
            {!viewed && (
              <span id={helpId} className="block text-xs text-muted-foreground font-normal mt-0.5">
                Open the document via the "Open document to read" link above to enable this checkbox.
              </span>
            )}
          </Label>
        </div>
        {ackError && (
          <div id={ackErrorId} role="alert" className="text-xs text-destructive">{ackError}</div>
        )}
        <div className="space-y-1">
          <Label htmlFor={sigId} className="sr-only">
            Type your full name to sign the {policy.label}
          </Label>
          <Input
            id={sigId}
            placeholder="Type full name to sign"
            value={ack.signature}
            disabled={!viewed}
            onChange={(e) => onChange({ ...ack, signature: e.target.value })}
            aria-required="true"
            aria-label={`Signature for ${policy.label}`}
            aria-invalid={sigError ? true : undefined}
            aria-describedby={sigError ? sigErrorId : undefined}
          />
          {sigError && (
            <div id={sigErrorId} role="alert" className="text-xs text-destructive">{sigError}</div>
          )}
        </div>
      </div>
    </div>
  );
}

function Field({
  label, children, required, name, error,
}: {
  label: string;
  children: ReactNode;
  required?: boolean;
  name?: string;
  error?: StepError | null;
}) {
  const fieldId = useId();
  const errorId = useId();
  const match = name && error?.field === name ? error : null;
  let control = children;
  let controlId = fieldId;
  if (isValidElement(children)) {
    const el = children as ReactElement<{
      id?: string;
      "aria-describedby"?: string;
      "aria-invalid"?: boolean | "true" | "false";
      "aria-required"?: boolean | "true" | "false";
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
