import { useEffect, useState } from "react";
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
} from "lucide-react";
import { api } from "@/lib/api";
import { uploadFile } from "@/lib/upload";
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

export default function LegalAgreementsPage() {
  // null = status unknown (load failed / not permitted) → render templates only.
  const [statuses, setStatuses] = useState<Record<AgreementSlot, SlotStatus["custom"]> | null>(null);
  const [isSuperAdmin, setIsSuperAdmin] = useState(false);
  const [busySlot, setBusySlot] = useState<AgreementSlot | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function loadStatus() {
    try {
      const data = await api<{ agreements: SlotStatus[] }>("/admin/platform/agreements");
      const map = {} as Record<AgreementSlot, SlotStatus["custom"]>;
      for (const s of data.agreements) map[s.slot] = s.custom;
      setStatuses(map);
    } catch {
      // Non-admins (or a transient failure) simply see the bundled templates.
      setStatuses(null);
    }
  }

  useEffect(() => {
    void loadStatus();
    api<{ isSuperAdmin: boolean }>("/admin/platform/me")
      .then((r) => setIsSuperAdmin(r.isSuperAdmin))
      .catch(() => setIsSuperAdmin(false));
  }, []);

  async function viewCustom(slot: AgreementSlot) {
    setError(null);
    const win = window.open("", "_blank");
    try {
      const { url } = await api<{ url: string }>(`/admin/platform/agreements/${slot}/url`);
      if (win) win.location.href = url;
      else window.open(url, "_blank");
    } catch (e) {
      if (win) win.close();
      setError(`Failed to open document: ${(e as Error).message}`);
    }
  }

  async function downloadCustom(slot: AgreementSlot) {
    setError(null);
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
      setError(`Failed to download document: ${(e as Error).message}`);
    }
  }

  async function uploadCustom(slot: AgreementSlot, file: File) {
    setError(null);
    if (!/\.pdf$/i.test(file.name)) {
      setError("Please choose a PDF file.");
      return;
    }
    if (file.size > MAX_PDF_BYTES) {
      setError("PDF exceeds the 15 MB limit.");
      return;
    }
    setBusySlot(slot);
    try {
      const uploaded = await uploadFile(file);
      await api(`/admin/platform/agreements/${slot}`, {
        method: "PUT",
        body: { fileKey: uploaded.objectPath, fileName: uploaded.name },
      });
      await loadStatus();
    } catch (e) {
      setError((e as Error).message);
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
    setError(null);
    setBusySlot(slot);
    try {
      await api(`/admin/platform/agreements/${slot}`, { method: "DELETE" });
      await loadStatus();
    } catch (e) {
      setError((e as Error).message);
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

      {error && (
        <div
          role="alert"
          className="mb-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {error}
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        {AGREEMENTS.map((doc) => {
          const custom = statuses?.[doc.slot] ?? null;
          const templateUrl = `${BASE}legal/${doc.file}`;
          const busy = busySlot === doc.slot;
          return (
            <Card key={doc.slot} className="flex flex-col">
              <CardHeader>
                <div className="mb-2 flex items-start justify-between gap-2">
                  <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-muted">
                    <doc.Icon className="h-5 w-5 text-foreground" />
                  </div>
                  {statuses !== null &&
                    (custom ? (
                      <span className="inline-flex items-center gap-1 rounded-full border border-emerald-300 bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700">
                        <BadgeCheck className="h-3.5 w-3.5" />
                        Uploaded document
                      </span>
                    ) : (
                      <span className="inline-flex items-center rounded-full border border-border bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
                        Template
                      </span>
                    ))}
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
              </CardContent>
              <CardFooter className="flex flex-wrap gap-2">
                {custom ? (
                  <>
                    <Button size="sm" disabled={busy} onClick={() => void viewCustom(doc.slot)}>
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
                    <Button asChild size="sm">
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
