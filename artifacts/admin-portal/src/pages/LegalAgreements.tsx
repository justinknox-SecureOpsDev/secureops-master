import { Link } from "wouter";
import { FileText, Download, ExternalLink, ScrollText, ShieldCheck } from "lucide-react";
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

type AgreementDoc = {
  title: string;
  file: string;
  audience: string;
  description: string;
  Icon: typeof FileText;
};

// Platform-level legal documents authored by SOBBU LLC (the company that owns,
// develops, and operates SecureOps Command). These are distinct from the
// customer-branded, in-app Privacy Policy / Terms that the customer presents to
// its own officers as the operator. The PDFs live in `public/legal/` and are
// served at `${BASE_URL}legal/<file>.pdf`.
const AGREEMENTS: AgreementDoc[] = [
  {
    title: "Master Subscription Agreement",
    file: "SecureOps-Command-Master-Subscription-Agreement.pdf",
    audience: "Between SOBBU LLC and your organization",
    description:
      "The B2B SaaS subscription contract governing your organization's use of the SecureOps Command platform — license grant, data protection, fees, term, liability, and the deployment specifics (Order Form).",
    Icon: FileText,
  },
  {
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

      <div className="grid gap-4 sm:grid-cols-2">
        {AGREEMENTS.map((doc) => {
          const url = `${BASE}legal/${doc.file}`;
          return (
            <Card key={doc.file} className="flex flex-col">
              <CardHeader>
                <div className="mb-2 flex h-10 w-10 items-center justify-center rounded-lg bg-muted">
                  <doc.Icon className="h-5 w-5 text-foreground" />
                </div>
                <CardTitle className="text-base">{doc.title}</CardTitle>
                <CardDescription>{doc.audience}</CardDescription>
              </CardHeader>
              <CardContent className="flex-1">
                <p className="text-sm text-muted-foreground">{doc.description}</p>
              </CardContent>
              <CardFooter className="flex flex-wrap gap-2">
                <Button asChild size="sm">
                  <a href={url} target="_blank" rel="noopener noreferrer">
                    <ExternalLink className="mr-1.5 h-4 w-4" />
                    View PDF
                  </a>
                </Button>
                <Button asChild size="sm" variant="outline">
                  <a href={url} download={doc.file}>
                    <Download className="mr-1.5 h-4 w-4" />
                    Download
                  </a>
                </Button>
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

      <p className="mt-6 text-xs text-muted-foreground">
        These documents are templates and do not constitute legal advice. Bracketed
        placeholders must be completed and the agreements reviewed by a licensed
        attorney before they are signed or relied upon.
      </p>
    </div>
  );
}
