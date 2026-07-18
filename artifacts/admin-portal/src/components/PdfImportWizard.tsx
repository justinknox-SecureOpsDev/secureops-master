import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { FileText, Loader2, CheckCircle2, AlertTriangle, UserPlus, UserCog } from "lucide-react";
import { api, ApiError } from "@/lib/api";
import { uploadFile } from "@/lib/upload";

/** Every editable field the wizard renders. Mirrors the server `EmployeeDraft`. */
type DraftForm = {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  address: string;
  dateOfBirth: string;
  cityOfBirth: string;
  stateOfBirth: string;
  emergencyContactName: string;
  emergencyContactRelationship: string;
  emergencyContactPhone: string;
  siaLicenseNumber: string;
  siaLicenseLevel: string;
  siaLicenseExpiry: string;
  previousExperience: string;
  yearsExperience: string;
};

const EMPTY_FORM: DraftForm = {
  firstName: "", lastName: "", email: "", phone: "", address: "",
  dateOfBirth: "", cityOfBirth: "", stateOfBirth: "",
  emergencyContactName: "", emergencyContactRelationship: "", emergencyContactPhone: "",
  siaLicenseNumber: "", siaLicenseLevel: "", siaLicenseExpiry: "",
  previousExperience: "", yearsExperience: "",
};

type ServerDraft = Partial<Record<keyof DraftForm, string | number>>;
type Match = { userId: string; name: string; email: string; role: string };
type ParseResponse = { draft: ServerDraft; warnings: string[]; match: Match | null };
type CommitResponse = { userId: string; mode: "create" | "update"; created: boolean };

type Step = "upload" | "extracting" | "review" | "result";

const MAX_PDF_BYTES = 8 * 1024 * 1024;

/** Coerce the server draft (mixed string/number) into the all-string form state. */
function draftToForm(d: ServerDraft): DraftForm {
  const out = { ...EMPTY_FORM };
  for (const k of Object.keys(EMPTY_FORM) as (keyof DraftForm)[]) {
    const v = d[k];
    if (v !== undefined && v !== null) out[k] = String(v);
  }
  return out;
}

export function PdfImportWizard({
  open, onOpenChange,
}: {
  open: boolean;
  onOpenChange: (b: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [step, setStep] = useState<Step>("upload");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [form, setForm] = useState<DraftForm>(EMPTY_FORM);
  const [match, setMatch] = useState<Match | null>(null);
  const [mode, setMode] = useState<"create" | "update">("create");
  const [objectPath, setObjectPath] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string>("");
  const [result, setResult] = useState<CommitResponse | null>(null);

  function reset() {
    setStep("upload");
    setBusy(false);
    setError(null);
    setWarnings([]);
    setForm(EMPTY_FORM);
    setMatch(null);
    setMode("create");
    setObjectPath(null);
    setFileName("");
    setResult(null);
  }

  function set<K extends keyof DraftForm>(key: K, value: string) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  async function handleFile(file: File) {
    setError(null);
    if (file.type !== "application/pdf" && !file.name.toLowerCase().endsWith(".pdf")) {
      setError("Please choose a PDF file.");
      return;
    }
    if (file.size > MAX_PDF_BYTES) {
      setError("PDF must be 8 MB or smaller.");
      return;
    }
    setFileName(file.name);
    setStep("extracting");
    setBusy(true);
    try {
      const uploaded = await uploadFile(file);
      setObjectPath(uploaded.objectPath);
      const res = await api<ParseResponse>("/admin/import/employees/parse-pdf", {
        method: "POST",
        body: { objectPath: uploaded.objectPath },
      });
      setForm(draftToForm(res.draft));
      setWarnings(res.warnings ?? []);
      setMatch(res.match);
      // Default to update when the extracted email already belongs to an
      // employee; otherwise create. A matched non-employee can't be updated,
      // so we leave it on create and surface a warning in the review step.
      setMode(res.match && res.match.role === "employee" ? "update" : "create");
      setStep("review");
    } catch (e) {
      setError(
        e instanceof ApiError ? e.message : (e as Error).message ?? "Could not read this PDF.",
      );
      setStep("upload");
    } finally {
      setBusy(false);
    }
  }

  async function commit() {
    setBusy(true);
    setError(null);
    try {
      const fields: Record<string, string> = {};
      for (const [k, v] of Object.entries(form)) {
        if (v.trim() !== "") fields[k] = v.trim();
      }
      const res = await api<CommitResponse>("/admin/import/employees/commit-pdf", {
        method: "POST",
        body: {
          mode,
          userId: mode === "update" ? match?.userId : undefined,
          objectPath: objectPath ?? undefined,
          fields,
        },
      });
      setResult(res);
      queryClient.invalidateQueries({ queryKey: ["personnel"] });
      setStep("result");
    } catch (e) {
      setError(e instanceof ApiError ? e.message : (e as Error).message ?? "Import failed.");
    } finally {
      setBusy(false);
    }
  }

  const matchIsEmployee = match?.role === "employee";

  return (
    <Dialog open={open} onOpenChange={(b) => { onOpenChange(b); if (!b) reset(); }}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            Import employee from PDF —{" "}
            <span className="brand-gold-ink">
              {step === "upload" ? "Upload"
                : step === "extracting" ? "Reading…"
                : step === "review" ? "Review & edit"
                : "Done"}
            </span>
          </DialogTitle>
          <DialogDescription className="sr-only">
            Upload a single resume or application PDF; the details are extracted automatically,
            then you review and edit them before creating or updating an employee.
          </DialogDescription>
        </DialogHeader>

        <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">
          {step === "upload" ? "Step 1 of 3: Upload a PDF"
            : step === "extracting" ? "Reading the PDF, please wait"
            : step === "review" ? "Step 2 of 3: Review and edit the extracted details"
            : "Step 3 of 3: Import complete"}
        </div>

        {error && (
          <div role="alert" className="text-sm text-destructive bg-destructive/5 p-3 rounded border border-destructive/20 flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {step === "upload" && (
          <div className="space-y-3">
            <div className="py-8 text-center border-2 border-dashed rounded-lg">
              <FileText className="w-10 h-10 mx-auto brand-gold mb-3" />
              <p className="text-sm text-muted-foreground mb-3">
                Pick one PDF — a resume/CV or a filled-in application form for a single person.
                We'll read it and pre-fill the form for you to review.
              </p>
              <input
                type="file"
                accept="application/pdf,.pdf"
                disabled={busy}
                aria-label="Choose a PDF file to import"
                onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); }}
                className="block mx-auto text-sm"
              />
              <p className="text-[11px] text-muted-foreground mt-3">Max 8 MB. One employee per file.</p>
            </div>
          </div>
        )}

        {step === "extracting" && (
          <div className="py-12 flex flex-col items-center justify-center gap-3 text-center">
            <Loader2 className="w-8 h-8 animate-spin brand-gold" />
            <p className="text-sm text-muted-foreground">
              Reading <span className="font-medium text-foreground">{fileName}</span> and extracting details…
            </p>
          </div>
        )}

        {step === "review" && (
          <div className="space-y-4">
            {warnings.length > 0 && (
              <div className="text-xs bg-amber-50 border border-amber-200 rounded p-3 space-y-1">
                <div className="font-semibold text-amber-900 flex items-center gap-1.5">
                  <AlertTriangle className="w-3.5 h-3.5" /> Please double-check these
                </div>
                <ul className="list-disc pl-5 text-amber-800">
                  {warnings.map((w, i) => <li key={i}>{w}</li>)}
                </ul>
              </div>
            )}

            {match && (
              <div className="rounded border p-3 space-y-2 bg-accent/20">
                <div className="text-sm">
                  An account already exists for{" "}
                  <span className="font-semibold">{match.email}</span>
                  {match.name ? <> — {match.name}</> : null}
                  {!matchIsEmployee && (
                    <span className="ml-1 text-destructive">(role: {match.role})</span>
                  )}.
                </div>
                {matchIsEmployee ? (
                  <fieldset className="flex flex-wrap gap-4 text-sm">
                    <legend className="sr-only">Choose whether to create a new employee or update the existing one</legend>
                    <label className="inline-flex items-center gap-2 cursor-pointer">
                      <input
                        type="radio"
                        name="pdf-import-mode"
                        checked={mode === "update"}
                        onChange={() => setMode("update")}
                      />
                      Update this employee
                    </label>
                    <label className="inline-flex items-center gap-2 cursor-pointer">
                      <input
                        type="radio"
                        name="pdf-import-mode"
                        checked={mode === "create"}
                        onChange={() => setMode("create")}
                      />
                      Create a new one (needs a different email)
                    </label>
                  </fieldset>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    That email belongs to a non-employee account, so it can't be updated here.
                    Change the email below to create a new employee.
                  </p>
                )}
              </div>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Field id="firstName" label="First name" value={form.firstName} onChange={(v) => set("firstName", v)} required />
              <Field id="lastName" label="Last name" value={form.lastName} onChange={(v) => set("lastName", v)} required />
              <Field id="email" label="Email" type="email" value={form.email} onChange={(v) => set("email", v)} required full />
              <Field id="phone" label="Phone" type="tel" value={form.phone} onChange={(v) => set("phone", v)} />
              <Field id="address" label="Address" value={form.address} onChange={(v) => set("address", v)} full />
              <Field id="dateOfBirth" label="Date of birth" type="date" value={form.dateOfBirth} onChange={(v) => set("dateOfBirth", v)} />
              <Field id="cityOfBirth" label="City of birth" value={form.cityOfBirth} onChange={(v) => set("cityOfBirth", v)} />
              <Field id="stateOfBirth" label="State of birth" value={form.stateOfBirth} onChange={(v) => set("stateOfBirth", v)} />
            </div>

            <div className="border-t pt-3">
              <div className="text-xs uppercase font-semibold brand-navy mb-2">Emergency contact</div>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <Field id="emergencyContactName" label="Name" value={form.emergencyContactName} onChange={(v) => set("emergencyContactName", v)} />
                <Field id="emergencyContactRelationship" label="Relationship" value={form.emergencyContactRelationship} onChange={(v) => set("emergencyContactRelationship", v)} />
                <Field id="emergencyContactPhone" label="Phone" type="tel" value={form.emergencyContactPhone} onChange={(v) => set("emergencyContactPhone", v)} />
              </div>
            </div>

            <div className="border-t pt-3">
              <div className="text-xs uppercase font-semibold brand-navy mb-2">Texas security license</div>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <Field id="siaLicenseNumber" label="License number" value={form.siaLicenseNumber} onChange={(v) => set("siaLicenseNumber", v)} />
                <div className="space-y-1">
                  <Label htmlFor="siaLicenseLevel">License level</Label>
                  <select
                    id="siaLicenseLevel"
                    className="w-full rounded border px-2 py-2 bg-background text-sm"
                    value={form.siaLicenseLevel}
                    onChange={(e) => set("siaLicenseLevel", e.target.value)}
                  >
                    <option value="">None</option>
                    <option value="2">L2 — Unarmed</option>
                    <option value="3">L3 — Armed</option>
                    <option value="4">L4 — PPO / Manager</option>
                  </select>
                </div>
                <Field id="siaLicenseExpiry" label="License expiry" type="date" value={form.siaLicenseExpiry} onChange={(v) => set("siaLicenseExpiry", v)} />
              </div>
              <p className="text-[11px] text-muted-foreground mt-1.5">
                A license is recorded only when both a number and an expiry date are provided.
              </p>
            </div>

            <div className="border-t pt-3">
              <div className="text-xs uppercase font-semibold brand-navy mb-2">Experience</div>
              <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
                <Field id="yearsExperience" label="Years" type="number" value={form.yearsExperience} onChange={(v) => set("yearsExperience", v)} />
                <div className="sm:col-span-3 space-y-1">
                  <Label htmlFor="previousExperience">Previous experience</Label>
                  <Textarea
                    id="previousExperience"
                    rows={3}
                    value={form.previousExperience}
                    onChange={(e) => set("previousExperience", e.target.value)}
                  />
                </div>
              </div>
            </div>

            <div className="flex items-center justify-between gap-2 border-t pt-3">
              <Button variant="ghost" type="button" onClick={() => { reset(); }}>
                Start over
              </Button>
              <Button type="button" onClick={commit} disabled={busy}>
                {busy ? <Loader2 className="w-4 h-4 animate-spin mr-1.5" /> : (
                  mode === "update"
                    ? <UserCog className="w-4 h-4 mr-1.5" />
                    : <UserPlus className="w-4 h-4 mr-1.5" />
                )}
                {mode === "update" ? "Update employee" : "Create employee"}
              </Button>
            </div>
          </div>
        )}

        {step === "result" && result && (
          <div className="py-8 flex flex-col items-center justify-center gap-3 text-center">
            <CheckCircle2 className="w-10 h-10 text-emerald-600" />
            <p className="text-sm">
              Employee {result.created ? "created" : "updated"} successfully.
            </p>
            <div className="flex gap-2">
              <Button asChild>
                <Link href={`/personnel/${result.userId}`} onClick={() => onOpenChange(false)}>
                  View profile
                </Link>
              </Button>
              <Button variant="outline" type="button" onClick={reset}>
                Import another
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function Field({
  id, label, value, onChange, type = "text", required = false, full = false,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  required?: boolean;
  full?: boolean;
}) {
  return (
    <div className={`space-y-1 ${full ? "sm:col-span-2" : ""}`}>
      <Label htmlFor={id}>
        {label}{required ? <span className="text-destructive"> *</span> : null}
      </Label>
      <Input id={id} type={type} value={value} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}
