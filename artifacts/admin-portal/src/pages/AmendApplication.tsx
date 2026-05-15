import { useEffect, useState } from "react";
import { useRoute } from "wouter";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { FileUploadField } from "@/components/FileUploadField";
import { type UploadedFile } from "@/lib/upload";
import { api } from "@/lib/api";
import { CheckCircle2, Loader2, ShieldAlert } from "lucide-react";

type FieldType = "text" | "textarea" | "number" | "date" | "file";
type AmendField = { key: string; label: string; type: FieldType; currentValue: string | null };
type AmendData = {
  firstName: string;
  lastName: string;
  email: string;
  note: string | null;
  expiresAt: string;
  fields: AmendField[];
};

type Value = string | UploadedFile | null;

export function AmendApplication() {
  const [, params] = useRoute("/amend/:token");
  const token = params?.token ?? "";
  const [data, setData] = useState<AmendData | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [values, setValues] = useState<Record<string, Value>>({});
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (!token) return;
    setLoading(true);
    api<AmendData>(`/applications/amend/${encodeURIComponent(token)}`)
      .then((d) => {
        setData(d);
        const init: Record<string, Value> = {};
        for (const f of d.fields) {
          init[f.key] = f.type === "file" ? null : (f.currentValue ?? "");
        }
        setValues(init);
      })
      .catch((e) => setLoadError((e as Error).message))
      .finally(() => setLoading(false));
  }, [token]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!data) return;
    // Require every requested field to be filled — the whole point of this
    // flow is for the applicant to provide the missing details.
    const missing = data.fields.filter((f) => {
      const v = values[f.key];
      if (f.type === "file") return v == null;
      return v == null || String(v).trim() === "";
    });
    if (missing.length > 0) {
      setSubmitError(`Please complete all requested items: ${missing.map((m) => m.label).join(", ")}.`);
      return;
    }
    setSubmitting(true); setSubmitError(null);
    const payload: Record<string, unknown> = {};
    for (const f of data.fields) {
      const v = values[f.key]!;
      if (f.type === "file") {
        const u = v as UploadedFile;
        payload[f.key] = { objectPath: u.objectPath, name: u.name };
      } else if (f.type === "number") {
        payload[f.key] = Number(v);
      } else {
        payload[f.key] = v;
      }
    }
    try {
      await api(`/applications/amend/${encodeURIComponent(token)}`, {
        method: "POST",
        body: { values: payload },
      });
      setDone(true);
    } catch (e) {
      setSubmitError((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) {
    return (
      <Shell>
        <div className="flex items-center justify-center py-16 text-muted-foreground">
          <Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading…
        </div>
      </Shell>
    );
  }
  if (loadError) {
    return (
      <Shell>
        <div className="bg-rose-50 border border-rose-200 text-rose-900 p-4 rounded flex items-start gap-2">
          <ShieldAlert className="w-5 h-5 mt-0.5 shrink-0" />
          <div>
            <div className="font-semibold">{loadError}</div>
            <div className="text-sm mt-1">If you believe this is a mistake, please contact the recruitment team.</div>
          </div>
        </div>
      </Shell>
    );
  }
  if (done) {
    return (
      <Shell>
        <div className="bg-emerald-50 border border-emerald-200 text-emerald-900 p-6 rounded text-center">
          <CheckCircle2 className="w-10 h-10 mx-auto mb-2" />
          <div className="font-semibold text-lg">Thank you!</div>
          <p className="text-sm mt-1">
            Your updated information has been submitted. Our recruitment team will review it shortly.
          </p>
        </div>
      </Shell>
    );
  }
  if (!data) return null;

  return (
    <Shell>
      <div className="space-y-2 mb-6">
        <h1 className="brand-wordmark text-2xl">Hi {data.firstName},</h1>
        <p className="text-sm text-muted-foreground">
          We need a few more details to finish reviewing your application. Please complete the items below
          and submit. This link expires {new Date(data.expiresAt).toLocaleDateString()}.
        </p>
        {data.note && (
          <div className="bg-[#f6f1e1] border-l-4 border-[#c9a84c] p-3 rounded text-sm whitespace-pre-wrap">
            <div className="text-xs uppercase tracking-wide opacity-70 mb-1">Note from our team</div>
            {data.note}
          </div>
        )}
      </div>

      <form onSubmit={submit} className="space-y-4">
        {data.fields.map((f) => (
          <FieldEditor
            key={f.key}
            field={f}
            value={values[f.key]}
            onChange={(v) => setValues((prev) => ({ ...prev, [f.key]: v }))}
          />
        ))}
        {submitError && (
          <div className="text-sm text-destructive bg-destructive/5 p-2 rounded border border-destructive/20">{submitError}</div>
        )}
        <Button type="submit" disabled={submitting} className="w-full bg-brand-navy hover:opacity-90 text-white">
          {submitting ? "Submitting…" : "Submit updated information"}
        </Button>
      </form>
    </Shell>
  );
}

function FieldEditor({
  field, value, onChange,
}: {
  field: AmendField;
  value: Value;
  onChange: (v: Value) => void;
}) {
  if (field.type === "file") {
    return (
      <div>
        <FileUploadField
          label={field.label}
          accept={field.key === "photo" ? "image/*" : field.key === "cv" ? ".pdf,.doc,.docx" : "image/*,.pdf"}
          value={(value as UploadedFile | null) ?? null}
          onChange={(v) => onChange(v)}
        />
        {field.currentValue && !value && (
          <p className="text-xs text-muted-foreground mt-1">A file is already on file — uploading a new one will replace it.</p>
        )}
      </div>
    );
  }
  return (
    <div className="space-y-1">
      <label className="text-xs uppercase font-semibold text-foreground/80 block">{field.label}</label>
      {field.type === "textarea" ? (
        <Textarea rows={3} value={(value as string) ?? ""} onChange={(e) => onChange(e.target.value)} />
      ) : (
        <Input
          type={field.type === "number" ? "number" : field.type === "date" ? "date" : "text"}
          value={(value as string) ?? ""}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
    </div>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-brand-cream py-8 px-4">
      <div className="max-w-xl mx-auto bg-card rounded-lg border shadow-sm p-6">
        <div className="brand-wordmark text-base brand-navy mb-4 pb-3 border-b">
          Williams Council Security Group
        </div>
        {children}
      </div>
    </div>
  );
}

export default AmendApplication;
