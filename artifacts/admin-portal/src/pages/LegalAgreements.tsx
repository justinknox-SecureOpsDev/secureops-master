import { useEffect, useRef, useState } from "react";
import { Link } from "wouter";
import {
  FileText,
  Download,
  ExternalLink,
  ScrollText,
  ShieldCheck,
  Upload,
  Undo2,
  Loader2,
  BadgeCheck,
  PenLine,
} from "lucide-react";
import { api, ApiError } from "@/lib/api";
import { uploadFile } from "@/lib/upload";
import { downloadSignedPdf } from "@/pages/AgreementSign";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

const BASE = import.meta.env.BASE_URL;

const MAX_PDF_BYTES = 15 * 1024 * 1024; // keep in sync with the API's 15 MB cap

type AgreementSlot = "msa" | "user_agreement";

type AgreementDoc = {
  slot: AgreementSlot;
  title: string;
  file: string;
  audience: string;
  description: string;
  Icon: typeof FileText;
};

type SlotStatus = {
  slot: AgreementSlot;
  custom: {
    fileName: string;
    fileSize: number | null;
    uploadedAt: string | null;
    uploadedBy: string | null;
  } | null;
};

type SignatureDto = {
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

// Platform-level legal documents authored by SOBBU LLC (the company that owns,
// develops, and operates SecureOps Command). These are distinct from the
// customer-branded, in-app Privacy Policy / Terms that the customer presents to
// its own officers as the operator. The bundled template PDFs live in
// `public/legal/` and are served at `${BASE_URL}legal/<file>.pdf`; a super-admin
// can replace each with the actual executed document (stored privately in
// object storage and served via short-lived signed URLs).
const AGREEMENTS: AgreementDoc[] = [
  {
    slot: "msa",
    title: "Master Subscription Agreement",
    file: "SecureOps-Command-Master-Subscription-Agreement.pdf",
    audience: "Between SOBBU LLC and your organization",
    description:
      "The B2B SaaS subscription contract governing your organization's use of the SecureOps Command platform — license grant, data protection, fees, term, liability, and the deployment specifics (Order Form).",
    Icon: FileText,
  },
  {
    slot: "user_agreement",
    title: "User Agreement (Terms of Service / EULA)",
    file: "SecureOps-Command-User-Agreement.pdf",
    audience: "For administrators, dispatchers, and officers",
    description:
      "The terms every end user agrees to when using the web portal and mobile apps — acceptable use, account responsibilities, location/notification disclosures, and the emergency-button limitations.",
    Icon: ScrollText,
  },
];

// Customer-facing legal pages already published in this deployment, presented to
// your own personnel and applicants. Linked here for convenience.
const CUSTOMER_LEGAL = [
  { label: "Privacy Policy", href: "privacy" },
  { label: "Terms of Service", href: "terms" },
  { label: "Data Rights", href: "data-rights" },
];

type SlotMap = Record<AgreementSlot, SlotStatus["custom"]>;

const EMPTY_SLOT_MAP: SlotMap = { msa: null, user_agreement: null };

/** A short-lived, slot-scoped result message shown on the card that produced it. */
type SlotMessage = { kind: "error" | "ok"; text: string };

export default function LegalAgreementsPage() {
  // null = never loaded successfully. A *failed* load is tracked separately in
  // `statusFailed` and must never be rendered as "Template": an unreachable API
  // and "no document has been uploaded" look identical to the user otherwise,
  // which makes a successful upload appear to have silently done nothing.
  const [statuses, setStatuses] = useState<SlotMap | null>(null);
  const [statusFailed, setStatusFailed] = useState(false);
  const [signatures, setSignatures] = useState<Record<AgreementSlot, SignatureDto | null> | null>(
    null,
  );
  const [isSuperAdmin, setIsSuperAdmin] = useState(false);
  const [busySlot, setBusySlot] = useState<AgreementSlot | null>(null);
  const [messages, setMessages] = useState<Partial<Record<AgreementSlot, SlotMessage>>>({});

  function setMessage(slot: AgreementSlot, kind: SlotMessage["kind"], text: string) {
    setMessages((m) => ({ ...m, [slot]: { kind, text } }));
  }
  function clearMessage(slot: AgreementSlot) {
    setMessages((m) => ({ ...m, [slot]: undefined }));
  }

  /**
   * Bumped by every confirmed write. A status response that was already in
   * flight when a write landed is discarded rather than committed: otherwise
   * an older "no document here" read can resolve last and put the card back
   * to "Template" after a successful replacement.
   */
  const writeGen = useRef(0);

  /** Reports how the refresh ended so callers can describe it truthfully. */
  async function loadStatus(): Promise<"ok" | "failed" | "superseded"> {
    const gen = writeGen.current;
    try {
      const data = await api<{ agreements: SlotStatus[] }>("/admin/platform/agreements");
      if (writeGen.current !== gen) return "superseded";
      const map = { ...EMPTY_SLOT_MAP };
      for (const s of data.agreements) map[s.slot] = s.custom;
      setStatuses(map);
      setStatusFailed(false);
      return "ok";
    } catch {
      if (writeGen.current !== gen) return "superseded";
      // Keep the last known state. A failed refresh must never downgrade a
      // document we just saved back to "Template".
      setStatusFailed(true);
      return "failed";
    }
  }

  useEffect(() => {
    void loadStatus();
    api<{ signatures: Record<AgreementSlot, SignatureDto | null> }>(
      "/admin/platform/agreements/signatures",
    )
      .then((r) => setSignatures(r.signatures))
      .catch(() => setSignatures(null));
    api<{ isSuperAdmin: boolean }>("/admin/platform/me")
      .then((r) => setIsSuperAdmin(r.isSuperAdmin))
      .catch(() => setIsSuperAdmin(false));
  }, []);

  async function viewCustom(slot: AgreementSlot) {
    clearMessage(slot);
    const win = window.open("", "_blank");
    try {
      const { url } = await api<{ url: string }>(`/admin/platform/agreements/${slot}/url`);
      if (win) win.location.href = url;
      else window.open(url, "_blank");
    } catch (e) {
      if (win) win.close();
      setMessage(slot, "error", `Failed to open document: ${(e as Error).message}`);
    }
  }

  async function downloadCustom(slot: AgreementSlot) {
    clearMessage(slot);
    try {
      const { url, fileName } = await api<{ url: string; fileName: string }>(
        `/admin/platform/agreements/${slot}/url`,
      );
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Download failed (${res.status})`);
      const blob = await res.blob();
      const objectUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = objectUrl;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(objectUrl);
    } catch (e) {
      setMessage(slot, "error", `Failed to download document: ${(e as Error).message}`);
    }
  }

  async function uploadCustom(slot: AgreementSlot, file: File) {
    clearMessage(slot);
    if (!/\.pdf$/i.test(file.name)) {
      setMessage(slot, "error", "Please choose a PDF file.");
      return;
    }
    if (file.size > MAX_PDF_BYTES) {
      setMessage(slot, "error", "PDF exceeds the 15 MB limit.");
      return;
    }
    setBusySlot(slot);
    try {
      let uploaded: Awaited<ReturnType<typeof uploadFile>>;
      try {
        uploaded = await uploadFile(file);
      } catch (e) {
        // The bytes never reached storage, so nothing was registered: this is
        // a definite "not replaced".
        setMessage(slot, "error", `Upload failed — the document was not replaced. ${(e as Error).message}`);
        return;
      }

      try {
        const saved = await api<SlotStatus>(`/admin/platform/agreements/${slot}`, {
          method: "PUT",
          body: { fileKey: uploaded.objectPath, fileName: uploaded.name },
        });
        // The server's reply is authoritative — apply it before refreshing so a
        // failed refresh can't make a stored replacement look like it never
        // happened (the original "my upload didn't take" report).
        const savedName = saved?.custom?.fileName ?? uploaded.name;
        writeGen.current += 1;
        setStatuses((prev) => ({ ...(prev ?? EMPTY_SLOT_MAP), [slot]: saved?.custom ?? null }));
        const refreshed = await loadStatus();
        setMessage(
          slot,
          "ok",
          refreshed === "failed"
            ? `Saved — “${savedName}” is stored, but this page couldn't refresh. Reload to confirm.`
            : `Saved — “${savedName}” is now the active document.`,
        );
      } catch (e) {
        // Only a 4xx proves the route itself refused the write. A 5xx can come
        // from a proxy *after* the server committed, and a non-ApiError means
        // no answer came back at all (dropped connection, restart mid-request).
        if (e instanceof ApiError && e.status >= 400 && e.status < 500) {
          setMessage(slot, "error", `Upload failed — the document was not replaced. ${e.message}`);
          return;
        }
        // The write may or may not have been committed, so claim neither: show
        // what is actually stored instead. Fence reads that started before this
        // write so a pre-upload answer can't land on top of the verification.
        writeGen.current += 1;
        const refreshed = await loadStatus();
        setMessage(
          slot,
          "error",
          refreshed === "failed"
            ? `Couldn't confirm the upload (${(e as Error).message}) and this page couldn't refresh. Reload the page to see which document is stored.`
            : `Couldn't confirm the upload (${(e as Error).message}). The badge above shows what is stored right now — if it hasn't changed, try again.`,
        );
      }
    } finally {
      setBusySlot(null);
    }
  }

  async function revertToTemplate(slot: AgreementSlot, title: string) {
    if (
      !window.confirm(
        `Remove the uploaded document for "${title}" and revert to the bundled template?`,
      )
    )
      return;
    clearMessage(slot);
    setBusySlot(slot);
    try {
      await api(`/admin/platform/agreements/${slot}`, { method: "DELETE" });
      writeGen.current += 1;
      setStatuses((prev) => ({ ...(prev ?? EMPTY_SLOT_MAP), [slot]: null }));
      await loadStatus();
      setMessage(slot, "ok", "Reverted to the bundled template.");
    } catch (e) {
      setMessage(slot, "error", `Could not revert: ${(e as Error).message}`);
    } finally {
      setBusySlot(null);
    }
  }

  const anyTemplateShown =
    statuses === null || AGREEMENTS.some((d) => !statuses[d.slot]);

  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-6 sm:px-6 sm:py-8">
      <header className="mb-6">
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
          <ShieldCheck className="h-6 w-6 text-muted-foreground" />
          Legal &amp; Agreements
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          The platform agreements for SecureOps Command, provided by SOBBU LLC.
          View or download the PDF copies below.
        </p>
      </header>

      {statusFailed && (
        <div
          role="status"
          className="mb-4 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800"
        >
          <span>
            Couldn&apos;t check which documents are uploaded — the server didn&apos;t respond.
            {statuses ? " Showing the last known state." : " Showing the bundled templates."}
          </span>
          <button
            type="button"
            className="font-medium underline underline-offset-2"
            onClick={() => void loadStatus()}
          >
            Try again
          </button>
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        {AGREEMENTS.map((doc) => {
          const custom = statuses?.[doc.slot] ?? null;
          const signed = signatures?.[doc.slot] ?? null;
          const message = messages[doc.slot];
          const templateUrl = `${BASE}legal/${doc.file}`;
          const busy = busySlot === doc.slot;
          return (
            <Card key={doc.slot} className="flex flex-col">
              <CardHeader>
                <div className="mb-2 flex items-start justify-between gap-2">
                  <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-muted">
                    <doc.Icon className="h-5 w-5 text-foreground" />
                  </div>
                  <div className="flex flex-wrap justify-end gap-1.5">
                    {signed && (
                      <span className="inline-flex items-center gap-1 rounded-full border border-sky-300 bg-sky-50 px-2 py-0.5 text-xs font-medium text-sky-700">
                        <PenLine className="h-3.5 w-3.5" />
                        Signed
                      </span>
                    )}
                    {statuses !== null ? (
                      custom ? (
                        <span className="inline-flex items-center gap-1 rounded-full border border-emerald-300 bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700">
                          <BadgeCheck className="h-3.5 w-3.5" />
                          Uploaded document
                        </span>
                      ) : (
                        <span className="inline-flex items-center rounded-full border border-border bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
                          Template
                        </span>
                      )
                    ) : (
                      statusFailed && (
                        <span className="inline-flex items-center rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-800">
                          Status unavailable
                        </span>
                      )
                    )}
                  </div>
                </div>
                <CardTitle className="text-base">{doc.title}</CardTitle>
                <CardDescription>{doc.audience}</CardDescription>
              </CardHeader>
              <CardContent className="flex-1">
                <p className="text-sm text-muted-foreground">{doc.description}</p>
                {custom && (
                  <p className="mt-3 break-all text-xs text-muted-foreground">
                    {custom.fileName}
                    {custom.uploadedAt && (
                      <> · uploaded {new Date(custom.uploadedAt).toLocaleDateString()}</>
                    )}
                  </p>
                )}
                {signed && (
                  <p className="mt-3 text-xs text-muted-foreground">
                    Signed by {signed.signerName} ({signed.signerTitle}) on{" "}
                    {new Date(signed.signedAt).toLocaleDateString()}
                    {signed.guarantyExecuted && <> · personal guaranty executed</>}
                  </p>
                )}
                {message && (
                  <p
                    role={message.kind === "error" ? "alert" : "status"}
                    className={`mt-3 rounded-md border px-2.5 py-1.5 text-xs ${
                      message.kind === "error"
                        ? "border-destructive/40 bg-destructive/10 text-destructive"
                        : "border-emerald-300 bg-emerald-50 text-emerald-700"
                    }`}
                  >
                    {message.text}
                  </p>
                )}
              </CardContent>
              <CardFooter className="flex flex-wrap gap-2">
                <Button asChild size="sm" variant={signed ? "outline" : "default"}>
                  <Link href={`/legal/agreements/sign/${doc.slot}`}>
                    <PenLine className="mr-1.5 h-4 w-4" />
                    {signed ? "Review & re-sign" : "Review & sign"}
                  </Link>
                </Button>
                {signed && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      clearMessage(doc.slot);
                      void downloadSignedPdf(doc.slot).catch((e) =>
                        setMessage(
                          doc.slot,
                          "error",
                          `Failed to download signed PDF: ${(e as Error).message}`,
                        ),
                      );
                    }}
                  >
                    <Download className="mr-1.5 h-4 w-4" />
                    Signed PDF
                  </Button>
                )}
                {custom ? (
                  <>
                    <Button size="sm" variant="outline" disabled={busy} onClick={() => void viewCustom(doc.slot)}>
                      <ExternalLink className="mr-1.5 h-4 w-4" />
                      View PDF
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() => void downloadCustom(doc.slot)}
                    >
                      <Download className="mr-1.5 h-4 w-4" />
                      Download
                    </Button>
                  </>
                ) : (
                  <>
                    <Button asChild size="sm" variant="outline">
                      <a href={templateUrl} target="_blank" rel="noopener noreferrer">
                        <ExternalLink className="mr-1.5 h-4 w-4" />
                        View PDF
                      </a>
                    </Button>
                    <Button asChild size="sm" variant="outline">
                      <a href={templateUrl} download={doc.file}>
                        <Download className="mr-1.5 h-4 w-4" />
                        Download
                      </a>
                    </Button>
                  </>
                )}
                {isSuperAdmin && (
                  <>
                    <label
                      className={`inline-flex cursor-pointer items-center rounded-md border border-input bg-background px-2.5 py-1.5 text-xs font-medium shadow-sm hover:bg-accent hover:text-accent-foreground ${busy ? "pointer-events-none opacity-50" : ""}`}
                    >
                      {busy ? (
                        <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                      ) : (
                        <Upload className="mr-1.5 h-4 w-4" />
                      )}
                      {custom ? "Replace" : "Upload actual document"}
                      <input
                        type="file"
                        accept=".pdf,application/pdf"
                        className="hidden"
                        onChange={(e) => {
                          const f = e.target.files?.[0];
                          if (f) void uploadCustom(doc.slot, f);
                          e.target.value = "";
                        }}
                      />
                    </label>
                    {custom && (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy}
                        onClick={() => void revertToTemplate(doc.slot, doc.title)}
                      >
                        <Undo2 className="mr-1.5 h-4 w-4" />
                        Revert to template
                      </Button>
                    )}
                  </>
                )}
              </CardFooter>
            </Card>
          );
        })}
      </div>

      <Card className="mt-6">
        <CardHeader>
          <CardTitle className="text-base">Your published customer legal pages</CardTitle>
          <CardDescription>
            The privacy and terms pages shown to your own personnel and applicants in this deployment.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          {CUSTOMER_LEGAL.map((p) => (
            <Button key={p.href} asChild size="sm" variant="outline">
              <Link href={`/${p.href}`}>
                <ExternalLink className="mr-1.5 h-4 w-4" />
                {p.label}
              </Link>
            </Button>
          ))}
        </CardContent>
      </Card>

      {anyTemplateShown && (
        <p className="mt-6 text-xs text-muted-foreground">
          Documents marked “Template” are templates and do not constitute legal
          advice. Bracketed placeholders must be completed and the agreements
          reviewed by a licensed attorney before they are signed or relied upon.
        </p>
      )}
    </div>
  );
}
