import { useEffect, useMemo, useState } from "react";
import { Link, useRoute } from "wouter";
import MarkdownIt from "markdown-it";
import {
  ArrowLeft,
  Download,
  Loader2,
  Lock,
  PenLine,
  ShieldCheck,
  BadgeCheck,
} from "lucide-react";
import {
  AGREEMENT_FIELD_GROUP_LABELS,
  AGREEMENT_FILE_BASES,
  fillAgreement,
  type AgreementFieldGroup,
  type AgreementSlot,
} from "@workspace/legal-docs";
import { api, fetchWithAuth } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

const md = new MarkdownIt({ html: false, linkify: false });

type ContextField = {
  key: string;
  label: string;
  group: AgreementFieldGroup;
  required: boolean;
  /** "provider" values are SOBBU's and read-only here; "customer" ones are editable. */
  authority: "provider" | "customer";
  hint: string | null;
  multiline: boolean;
  value: string;
};

type SignedDto = {
  id: string;
  slot: AgreementSlot;
  signerName: string;
  signerTitle: string;
  signerEmail: string;
  signedAt: string;
  documentSha256: string;
  guarantyExecuted: boolean;
  guarantorName: string | null;
};

type UploadedDoc = {
  fileName: string;
  fileSize: number | null;
  documentSha256: string;
  uploadedAt: string | null;
};

type SlotContext = {
  title: string;
  /**
   * Which document governs this slot. "uploaded" means the platform owner
   * replaced the bundled template with a PDF — that PDF is what gets reviewed
   * and signed, and there are no fillable terms.
   */
  source?: "template" | "uploaded";
  template: string | null;
  document?: UploadedDoc | null;
  /** Set when an uploaded document exists but can't be read; signing is blocked. */
  unavailableReason?: string | null;
  consentText: string;
  guarantyConsentText: string | null;
  fields: ContextField[];
  /** Digest of SOBBU's terms as shown here; echoed back so we can't sign stale terms. */
  termsDigest: string;
  readyToSign: boolean;
  missingProviderLabels: string[];
  signed: SignedDto | null;
};

const GUARANTY_KEYS = ["guarantorName", "guarantorTitle", "guarantorAddress"];

export async function downloadSignedPdf(slot: AgreementSlot): Promise<void> {
  const res = await fetchWithAuth(`/api/admin/platform/agreements/${slot}/signed-pdf`);
  if (!res.ok) {
    let msg = `Download failed (${res.status})`;
    try {
      const data = (await res.json()) as { message?: string };
      if (data?.message) msg = data.message;
    } catch {
      // keep default message
    }
    throw new Error(msg);
  }
  const blob = await res.blob();
  const objectUrl = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = objectUrl;
  a.download = `${AGREEMENT_FILE_BASES[slot]}-signed.pdf`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(objectUrl);
}

export default function AgreementSignPage() {
  const [, params] = useRoute("/legal/agreements/sign/:slot");
  const slot: AgreementSlot | null =
    params?.slot === "msa" || params?.slot === "user_agreement"
      ? (params.slot as AgreementSlot)
      : null;

  const [ctx, setCtx] = useState<SlotContext | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [signerName, setSignerName] = useState("");
  const [signerTitle, setSignerTitle] = useState("");
  const [signatureText, setSignatureText] = useState("");
  const [consent, setConsent] = useState(false);
  const [guarantyEnabled, setGuarantyEnabled] = useState(false);
  const [guarantorSignature, setGuarantorSignature] = useState("");
  const [guarantorConsent, setGuarantorConsent] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [signedNow, setSignedNow] = useState<SignedDto | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [docUrl, setDocUrl] = useState<string | null>(null);
  const [docError, setDocError] = useState<string | null>(null);
  /** No signing an uploaded document the signer was never actually shown. */
  const [docLoaded, setDocLoaded] = useState(false);

  useEffect(() => {
    if (!slot) return;
    api<{ slots: Record<string, SlotContext> }>("/admin/platform/agreements/signing-context")
      .then((data) => {
        const s = data.slots[slot];
        if (!s) throw new Error("Agreement not found");
        setCtx(s);
        const initial: Record<string, string> = {};
        for (const f of s.fields) if (f.authority === "customer") initial[f.key] = f.value;
        setValues(initial);
      })
      .catch((e) => setLoadError((e as Error).message));
  }, [slot]);

  const isUploaded = ctx?.source === "uploaded";

  // The uploaded PDF is the document being agreed to, so it has to be on
  // screen — not just linked. It's fetched with the admin's token and shown as
  // a blob so the same bytes the server will archive are what the signer reads.
  useEffect(() => {
    if (!slot || !isUploaded || !ctx?.document) return;
    setDocLoaded(false);
    let revoked = false;
    let objectUrl: string | null = null;
    setDocError(null);
    (async () => {
      // Same-origin on purpose: the production CSP only lets the portal fetch
      // its own API, and this endpoint hash-verifies the bytes it serves.
      const res = await fetchWithAuth(`/api/admin/platform/agreements/${slot}/document`);
      if (!res.ok) {
        let msg = `Could not load the document (${res.status})`;
        try {
          const data = (await res.json()) as { message?: string };
          if (data.message) msg = data.message;
        } catch {
          /* non-JSON error body */
        }
        throw new Error(msg);
      }
      const blob = await res.blob();
      if (revoked) return;
      objectUrl = URL.createObjectURL(blob);
      setDocUrl(objectUrl);
    })().catch((e) => setDocError((e as Error).message));
    return () => {
      revoked = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      setDocUrl(null);
    };
  }, [slot, isUploaded, ctx?.document?.documentSha256]);

  // SOBBU's values are display-only. The server re-derives them when the
  // signature is submitted, so nothing on this page can alter the terms.
  const providerValues = useMemo(() => {
    const v: Record<string, string> = {};
    for (const f of ctx?.fields ?? []) if (f.authority === "provider") v[f.key] = f.value;
    return v;
  }, [ctx]);

  const previewValues = useMemo(() => {
    const v: Record<string, string> = { ...providerValues, ...values };
    if (!guarantyEnabled) for (const k of GUARANTY_KEYS) delete v[k];
    return v;
  }, [providerValues, values, guarantyEnabled]);

  // Preview the SERVER's template, not this bundle's copy, so a stale browser
  // build can never show one document and sign another.
  const filled = useMemo(
    () =>
      slot && ctx && !isUploaded
        ? fillAgreement(slot, previewValues, { template: ctx.template ?? undefined })
        : null,
    [slot, ctx, isUploaded, previewValues],
  );

  const previewHtml = useMemo(
    () => (filled ? md.render(filled.markdown) : ""),
    [filled],
  );

  if (!slot) {
    return (
      <div className="mx-auto w-full max-w-3xl px-4 py-8">
        <p className="text-sm text-muted-foreground">Unknown agreement.</p>
        <Button asChild variant="outline" size="sm" className="mt-4">
          <Link href="/legal/agreements">
            <ArrowLeft className="mr-1.5 h-4 w-4" />
            Back to Legal &amp; Agreements
          </Link>
        </Button>
      </div>
    );
  }

  const groups: AgreementFieldGroup[] = [];
  if (ctx && !isUploaded) {
    for (const f of ctx.fields) {
      if (f.group === "guaranty") continue;
      if (!groups.includes(f.group)) groups.push(f.group);
    }
  }

  // Only what the customer can actually fix. Gaps in SOBBU's terms are
  // reported separately (and authoritatively) by the server.
  const missingLabels = filled
    ? filled.missing
        .filter((d) => d.authority === "customer")
        .filter((d) => d.group !== "guaranty" || guarantyEnabled)
        .map((d) => d.label)
    : [];

  const guarantorName = values["guarantorName"]?.trim() ?? "";
  const guarantorTitle = values["guarantorTitle"]?.trim() ?? "";
  const guarantorAddress = values["guarantorAddress"]?.trim() ?? "";

  const guarantyComplete =
    !guarantyEnabled ||
    (guarantorName.length > 0 &&
      guarantorTitle.length > 0 &&
      guarantorAddress.length > 0 &&
      guarantorSignature.trim().length > 0 &&
      guarantorConsent);

  const canSubmit =
    !submitting &&
    ctx !== null &&
    ctx.readyToSign &&
    missingLabels.length === 0 &&
    signerName.trim().length > 0 &&
    signerTitle.trim().length > 0 &&
    signatureText.trim().length > 0 &&
    consent &&
    guarantyComplete &&
    // An uploaded document can only be accepted once it is actually on screen.
    (!isUploaded || (docLoaded && !docError));

  async function submit() {
    if (!slot || !ctx) return;
    setSubmitError(null);
    setSubmitting(true);
    try {
      // No field values are sent: the terms are SOBBU's and are resolved
      // server-side. The digest proves which terms were on screen.
      const body: Record<string, unknown> = {
        termsDigest: ctx.termsDigest,
        signerName: signerName.trim(),
        signerTitle: signerTitle.trim(),
        signature: signatureText.trim(),
        consent: true,
      };
      if (slot === "msa" && guarantyEnabled) {
        body.guarantor = {
          name: guarantorName,
          title: guarantorTitle,
          address: guarantorAddress,
          signature: guarantorSignature.trim(),
          consent: true,
        };
      }
      const res = await api<{ signature: SignedDto }>(
        `/admin/platform/agreements/${slot}/sign`,
        { method: "POST", body },
      );
      setSignedNow(res.signature);
      window.scrollTo({ top: 0 });
    } catch (e) {
      setSubmitError((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  function renderField(f: ContextField) {
    const id = `agr-${f.key}`;
    return (
      <div key={f.key} className="space-y-1.5">
        <Label htmlFor={id}>
          {f.label}
          {f.required && <span className="ml-0.5 text-destructive">*</span>}
        </Label>
        {f.multiline ? (
          <Textarea
            id={id}
            rows={2}
            value={values[f.key] ?? ""}
            onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
          />
        ) : (
          <Input
            id={id}
            value={values[f.key] ?? ""}
            onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
          />
        )}
        {f.hint && <p className="text-xs text-muted-foreground">{f.hint}</p>}
      </div>
    );
  }

  /**
   * A term SOBBU has set. Shown for review only — the customer accepts these,
   * they don't complete them, and the server ignores anything sent for them.
   */
  function renderProviderValue(f: ContextField) {
    return (
      <div key={f.key} className="space-y-0.5">
        <p className="text-xs font-medium text-muted-foreground">{f.label}</p>
        {f.value.trim() ? (
          <p className="whitespace-pre-wrap break-words text-sm text-foreground">{f.value}</p>
        ) : (
          <p className="text-sm font-medium text-amber-700">Not set by SOBBU yet</p>
        )}
        {f.hint && <p className="text-xs text-muted-foreground">{f.hint}</p>}
      </div>
    );
  }

  if (signedNow) {
    return (
      <div className="mx-auto w-full max-w-2xl px-4 py-8 sm:px-6">
        <Card>
          <CardHeader>
            <div className="mb-2 flex h-10 w-10 items-center justify-center rounded-lg bg-emerald-50">
              <BadgeCheck className="h-5 w-5 text-emerald-600" />
            </div>
            <CardTitle>Agreement signed</CardTitle>
            <CardDescription>
              {ctx?.title} was signed by {signedNow.signerName} ({signedNow.signerTitle}) on{" "}
              {new Date(signedNow.signedAt).toLocaleString()}.
              {signedNow.guarantyExecuted && (
                <> The Exhibit C Personal Guaranty was executed by {signedNow.guarantorName}.</>
              )}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="break-all text-xs text-muted-foreground">
              Document SHA-256: <span className="font-mono">{signedNow.documentSha256}</span>
            </p>
            {downloadError && (
              <p role="alert" className="text-sm text-destructive">
                {downloadError}
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                onClick={() => {
                  setDownloadError(null);
                  void downloadSignedPdf(slot).catch((e) =>
                    setDownloadError((e as Error).message),
                  );
                }}
              >
                <Download className="mr-1.5 h-4 w-4" />
                Download signed PDF
              </Button>
              <Button asChild size="sm" variant="outline">
                <Link href="/legal/agreements">
                  <ArrowLeft className="mr-1.5 h-4 w-4" />
                  Back to Legal &amp; Agreements
                </Link>
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 sm:py-8">
      <header className="mb-6">
        <Button asChild variant="ghost" size="sm" className="-ml-2 mb-2">
          <Link href="/legal/agreements">
            <ArrowLeft className="mr-1.5 h-4 w-4" />
            Legal &amp; Agreements
          </Link>
        </Button>
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
          <PenLine className="h-6 w-6 text-muted-foreground" />
          Review &amp; sign — {ctx?.title ?? "…"}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {isUploaded
            ? "SOBBU supplied this agreement as a finished document. Read it in full, then complete the signature block to accept. The exact file you sign is stored permanently."
            : "The commercial and legal terms are set by SOBBU and shown here for review — they can't be changed on this page. Complete the signature block to accept. The exact document you sign is stored permanently."}
        </p>
      </header>

      {loadError && (
        <div
          role="alert"
          className="mb-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          Failed to load the agreement: {loadError}
        </div>
      )}

      {ctx?.signed && (
        <div className="mb-4 rounded-md border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
          This agreement was already signed by {ctx.signed.signerName} on{" "}
          {new Date(ctx.signed.signedAt).toLocaleDateString()}. Signing again records a new,
          superseding signature.
        </div>
      )}

      {ctx && !ctx.readyToSign && (
        <div
          role="alert"
          className="mb-4 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900"
        >
          {ctx.unavailableReason ? (
            ctx.unavailableReason
          ) : (
            <>
              This agreement isn&apos;t ready to sign yet — SOBBU still has to set:{" "}
              {ctx.missingProviderLabels.join(", ")}. These can only be set by SOBBU, so please
              contact them to finish the agreement.
            </>
          )}
        </div>
      )}

      {ctx && (
        <div className="grid gap-6 lg:grid-cols-[minmax(0,380px)_minmax(0,1fr)]">
          <div className="space-y-4">
            {groups.map((g, i) => (
              <Card key={g}>
                <CardHeader className="pb-3">
                  <CardTitle className="flex items-center gap-1.5 text-sm">
                    <Lock className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
                    {AGREEMENT_FIELD_GROUP_LABELS[g]}
                  </CardTitle>
                  {i === 0 && (
                    <CardDescription>
                      Set by SOBBU LLC as the platform provider. Review them before you sign —
                      contact SOBBU if anything needs to change.
                    </CardDescription>
                  )}
                </CardHeader>
                <CardContent className="space-y-3">
                  {ctx.fields
                    .filter((f) => f.group === g)
                    .map((f) => (f.authority === "provider" ? renderProviderValue(f) : renderField(f)))}
                </CardContent>
              </Card>
            ))}

            {slot === "msa" && !isUploaded && (
              <Card>
                <CardHeader className="pb-3">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <CardTitle className="text-sm">
                        {AGREEMENT_FIELD_GROUP_LABELS.guaranty}
                      </CardTitle>
                      <CardDescription className="mt-1">
                        Optional. When executed, the guarantor becomes personally liable for the
                        Customer&apos;s payment obligations.
                      </CardDescription>
                    </div>
                    <Switch
                      checked={guarantyEnabled}
                      onCheckedChange={setGuarantyEnabled}
                      aria-label="Execute the Exhibit C Personal Guaranty"
                    />
                  </div>
                </CardHeader>
                {guarantyEnabled && (
                  <CardContent className="space-y-3">
                    {ctx.fields.filter((f) => f.group === "guaranty").map(renderField)}
                    <div className="space-y-1.5">
                      <Label htmlFor="agr-guarantor-signature">
                        Guarantor signature (type full name)
                        <span className="ml-0.5 text-destructive">*</span>
                      </Label>
                      <Input
                        id="agr-guarantor-signature"
                        value={guarantorSignature}
                        onChange={(e) => setGuarantorSignature(e.target.value)}
                        placeholder="Type the guarantor's full legal name"
                      />
                    </div>
                    {ctx.guarantyConsentText && (
                      <div className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 p-3">
                        <Checkbox
                          id="agr-guaranty-consent"
                          checked={guarantorConsent}
                          onCheckedChange={(c) => setGuarantorConsent(c === true)}
                          className="mt-0.5"
                        />
                        <Label
                          htmlFor="agr-guaranty-consent"
                          className="text-xs font-normal leading-relaxed text-amber-900"
                        >
                          {ctx.guarantyConsentText}
                        </Label>
                      </div>
                    )}
                  </CardContent>
                )}
              </Card>
            )}

            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm">Signature</CardTitle>
                <CardDescription>
                  Signing on behalf of the customer organization.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="space-y-1.5">
                  <Label htmlFor="agr-signer-name">
                    Your full name<span className="ml-0.5 text-destructive">*</span>
                  </Label>
                  <Input
                    id="agr-signer-name"
                    value={signerName}
                    onChange={(e) => setSignerName(e.target.value)}
                    autoComplete="name"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="agr-signer-title">
                    Your title<span className="ml-0.5 text-destructive">*</span>
                  </Label>
                  <Input
                    id="agr-signer-title"
                    value={signerTitle}
                    onChange={(e) => setSignerTitle(e.target.value)}
                    placeholder="e.g. Owner, CEO, Operations Director"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="agr-signature">
                    Signature (type your full name)
                    <span className="ml-0.5 text-destructive">*</span>
                  </Label>
                  <Input
                    id="agr-signature"
                    value={signatureText}
                    onChange={(e) => setSignatureText(e.target.value)}
                    placeholder="Type your full legal name"
                    className="font-serif italic"
                  />
                </div>
                <div className="flex items-start gap-2 rounded-md border border-border bg-muted/50 p-3">
                  <Checkbox
                    id="agr-consent"
                    checked={consent}
                    onCheckedChange={(c) => setConsent(c === true)}
                    className="mt-0.5"
                  />
                  <Label
                    htmlFor="agr-consent"
                    className="text-xs font-normal leading-relaxed text-muted-foreground"
                  >
                    {ctx.consentText}
                  </Label>
                </div>

                {missingLabels.length > 0 && (
                  <p className="text-xs text-amber-700">
                    Still required: {missingLabels.join(", ")}
                  </p>
                )}
                {submitError && (
                  <p role="alert" className="text-sm text-destructive">
                    {submitError}
                  </p>
                )}
                <Button className="w-full" disabled={!canSubmit} onClick={() => void submit()}>
                  {submitting ? (
                    <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                  ) : (
                    <ShieldCheck className="mr-1.5 h-4 w-4" />
                  )}
                  Sign agreement
                </Button>
                <p className="text-center text-xs text-muted-foreground">
                  Provided by SOBBU LLC. This template is not legal advice — have it reviewed by a
                  licensed attorney before relying on it.
                </p>
              </CardContent>
            </Card>
          </div>

          <Card className="min-w-0">
            <CardHeader className="pb-3">
              <CardTitle className="text-sm">
                {isUploaded ? "The document you are signing" : "Live preview"}
              </CardTitle>
              <CardDescription>
                {isUploaded ? (
                  <>
                    This agreement is governed by the document SOBBU uploaded — shown in full
                    below. It is the exact file that will be archived with your signature.
                  </>
                ) : (
                  <>
                    This is the exact document that will be recorded when you sign. Unfilled fields
                    appear as [BRACKETED] placeholders.
                  </>
                )}
              </CardDescription>
              {isUploaded && ctx.document && (
                <p className="break-all pt-1 text-xs text-muted-foreground">
                  {ctx.document.fileName}
                  {ctx.document.uploadedAt && (
                    <> · uploaded {new Date(ctx.document.uploadedAt).toLocaleDateString()}</>
                  )}
                  <br />
                  SHA-256: <span className="font-mono">{ctx.document.documentSha256}</span>
                </p>
              )}
            </CardHeader>
            <CardContent>
              {isUploaded ? (
                docError ? (
                  <p role="alert" className="text-sm text-destructive">
                    {docError}
                  </p>
                ) : docUrl ? (
                  <iframe
                    src={docUrl}
                    title={`${ctx.title} — document being signed`}
                    className="h-[75dvh] w-full rounded-md border border-border bg-white"
                    onLoad={() => setDocLoaded(true)}
                    onError={() =>
                      setDocError("The document could not be displayed, so it can't be signed here.")
                    }
                  />
                ) : (
                  <p className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Loading the document…
                  </p>
                )
              ) : (
                <div
                  className="prose prose-sm max-w-none overflow-x-auto rounded-md border border-border bg-white p-4 sm:p-6 prose-headings:scroll-mt-4 prose-table:text-xs lg:max-h-[75dvh] lg:overflow-y-auto"
                  // Rendered from the bundled agreement template via markdown-it
                  // with html:false — user-entered values are markdown-escaped by
                  // fillAgreement and cannot inject markup.
                  dangerouslySetInnerHTML={{ __html: previewHtml }}
                />
              )}
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
