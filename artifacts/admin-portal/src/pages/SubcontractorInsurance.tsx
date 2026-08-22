import { useEffect, useRef, useState } from "react";
import { ShieldCheck, Plus, Upload, FileText, ExternalLink, Trash2, Pencil, AlertTriangle } from "lucide-react";
import { api } from "@/lib/api";
import { uploadFileSubcontractor, openSignedObjectSubcontractor } from "@/lib/upload";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";

type Coi = {
  id: string;
  coverageType: string;
  insurer: string | null;
  policyNumber: string | null;
  coverageAmount: string | null;
  effectiveDate: string | null;
  expiryDate: string;
  documentKey: string | null;
  notes: string | null;
};

type Me = { user: { subcontractorId: string | null } };

const COVERAGE_TYPES = [
  { value: "general_liability", label: "General Liability" },
  { value: "workers_comp", label: "Workers' Compensation" },
  { value: "auto", label: "Auto" },
  { value: "umbrella", label: "Umbrella" },
  { value: "professional", label: "Professional Liability" },
  { value: "other", label: "Other" },
];

const EMPTY_FORM = {
  coverageType: "general_liability",
  insurer: "",
  policyNumber: "",
  coverageAmount: "",
  effectiveDate: "",
  expiryDate: "",
  documentKey: "",
  notes: "",
};

function fmtDate(d: string | null) {
  if (!d) return "—";
  return new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function isExpired(d: string) {
  return new Date(d).getTime() < Date.now();
}

export default function SubcontractorInsurance() {
  const { toast } = useToast();
  const [loading, setLoading] = useState(true);
  const [needsProfile, setNeedsProfile] = useState(false);
  const [cois, setCois] = useState<Coi[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [submitting, setSubmitting] = useState(false);
  const [uploadingDoc, setUploadingDoc] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const docInputRef = useRef<HTMLInputElement>(null);

  function refresh() {
    setLoading(true);
    return api<Me>("/subcontractor-portal/me")
      .then(({ user }) => {
        if (!user.subcontractorId) {
          setNeedsProfile(true);
          return;
        }
        setNeedsProfile(false);
        return api<Coi[]>("/subcontractor-portal/cois").then(setCois);
      })
      .finally(() => setLoading(false));
  }

  useEffect(() => { refresh(); }, []);

  function fld<K extends keyof typeof form>(k: K, v: (typeof form)[K]) {
    setForm((f) => ({ ...f, [k]: v }));
  }

  function startAdd() {
    setEditingId(null);
    setForm(EMPTY_FORM);
    setShowForm(true);
  }

  function startEdit(c: Coi) {
    setEditingId(c.id);
    setForm({
      coverageType: c.coverageType,
      insurer: c.insurer ?? "",
      policyNumber: c.policyNumber ?? "",
      coverageAmount: c.coverageAmount ?? "",
      effectiveDate: c.effectiveDate ? c.effectiveDate.slice(0, 10) : "",
      expiryDate: c.expiryDate ? c.expiryDate.slice(0, 10) : "",
      documentKey: c.documentKey ?? "",
      notes: c.notes ?? "",
    });
    setShowForm(true);
  }

  async function onDocSelected(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploadingDoc(true);
    try {
      const uploaded = await uploadFileSubcontractor(file);
      fld("documentKey", uploaded.objectPath);
      toast({ title: "Certificate uploaded." });
    } catch (err: any) {
      toast({ title: err?.message ?? "Upload failed.", variant: "destructive" });
    } finally {
      setUploadingDoc(false);
      if (docInputRef.current) docInputRef.current.value = "";
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.expiryDate) {
      toast({ title: "Expiry date is required.", variant: "destructive" });
      return;
    }
    setSubmitting(true);
    try {
      if (editingId) {
        await api(`/subcontractor-portal/cois/${editingId}`, { method: "PUT", body: form });
        toast({ title: "Certificate updated." });
      } else {
        await api("/subcontractor-portal/cois", { method: "POST", body: form });
        toast({ title: "Certificate added." });
      }
      setShowForm(false);
      await refresh();
    } catch (err: any) {
      toast({ title: err?.message ?? "Failed to save certificate.", variant: "destructive" });
    } finally {
      setSubmitting(false);
    }
  }

  async function remove(id: string) {
    if (!confirm("Delete this certificate of insurance?")) return;
    setDeletingId(id);
    try {
      await api(`/subcontractor-portal/cois/${id}`, { method: "DELETE" });
      toast({ title: "Certificate deleted." });
      await refresh();
    } catch (err: any) {
      toast({ title: err?.message ?? "Failed to delete.", variant: "destructive" });
    } finally {
      setDeletingId(null);
    }
  }

  if (loading) {
    return <div className="text-center py-16 text-muted-foreground text-sm">Loading…</div>;
  }

  if (needsProfile) {
    return (
      <div className="max-w-2xl mx-auto px-4 py-16 text-center">
        <AlertTriangle className="w-10 h-10 mx-auto mb-3 text-amber-500" />
        <p className="text-sm text-muted-foreground">
          Complete your company profile first, then come back here to add your certificates of insurance.
        </p>
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto px-4 py-8">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-xl font-bold flex items-center gap-2">
          <ShieldCheck className="w-5 h-5" /> Certificates of Insurance
        </h1>
        <Button size="sm" className="gap-1" onClick={startAdd}>
          <Plus className="w-4 h-4" /> Add certificate
        </Button>
      </div>

      {showForm && (
        <form onSubmit={submit} className="border rounded-lg bg-card p-6 mb-8 space-y-4">
          <h2 className="text-base font-semibold">{editingId ? "Edit certificate" : "New certificate"}</h2>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1">
              <Label>Coverage type</Label>
              <Select value={form.coverageType} onValueChange={(v) => fld("coverageType", v)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {COVERAGE_TYPES.map((t) => (
                    <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="insurer">Insurer</Label>
              <Input id="insurer" value={form.insurer} onChange={(e) => fld("insurer", e.target.value)} />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1">
              <Label htmlFor="policyNumber">Policy number</Label>
              <Input id="policyNumber" value={form.policyNumber} onChange={(e) => fld("policyNumber", e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="coverageAmount">Coverage amount ($)</Label>
              <Input id="coverageAmount" type="number" min="0" step="1" value={form.coverageAmount} onChange={(e) => fld("coverageAmount", e.target.value)} />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1">
              <Label htmlFor="effectiveDate">Effective date</Label>
              <Input id="effectiveDate" type="date" value={form.effectiveDate} onChange={(e) => fld("effectiveDate", e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="expiryDate">Expiry date *</Label>
              <Input id="expiryDate" type="date" required value={form.expiryDate} onChange={(e) => fld("expiryDate", e.target.value)} />
            </div>
          </div>
          <div className="space-y-1">
            <Label>Certificate document</Label>
            <div className="flex items-center gap-3 flex-wrap">
              <input ref={docInputRef} type="file" accept=".pdf,.jpg,.jpeg,.png" className="hidden" onChange={onDocSelected} />
              <Button type="button" variant="outline" size="sm" className="gap-1.5" disabled={uploadingDoc} onClick={() => docInputRef.current?.click()}>
                <Upload className="w-3.5 h-3.5" /> {uploadingDoc ? "Uploading…" : form.documentKey ? "Replace file" : "Upload PDF"}
              </Button>
              {form.documentKey && (
                <button
                  type="button"
                  onClick={() => openSignedObjectSubcontractor(form.documentKey)}
                  className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                >
                  <FileText className="w-3.5 h-3.5" /> View current file <ExternalLink className="w-3 h-3" />
                </button>
              )}
            </div>
          </div>
          <div className="space-y-1">
            <Label htmlFor="notes">Notes</Label>
            <Textarea id="notes" rows={2} value={form.notes} onChange={(e) => fld("notes", e.target.value)} />
          </div>
          <div className="flex gap-3 pt-1">
            <Button type="submit" disabled={submitting}>{submitting ? "Saving…" : editingId ? "Save changes" : "Add certificate"}</Button>
            <Button type="button" variant="outline" onClick={() => setShowForm(false)}>Cancel</Button>
          </div>
        </form>
      )}

      {cois.length === 0 ? (
        <div className="text-center py-16 text-muted-foreground">
          <ShieldCheck className="w-10 h-10 mx-auto mb-3 opacity-30" />
          <p className="text-sm">No certificates of insurance on file yet.</p>
          <Button size="sm" className="mt-4 gap-1" onClick={startAdd}>
            <Plus className="w-4 h-4" /> Add the first one
          </Button>
        </div>
      ) : (
        <div className="space-y-3">
          {cois.map((c) => {
            const expired = isExpired(c.expiryDate);
            return (
              <div key={c.id} className="border rounded-lg bg-card p-4 flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-medium text-sm">
                      {COVERAGE_TYPES.find((t) => t.value === c.coverageType)?.label ?? c.coverageType}
                    </span>
                    <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full uppercase tracking-wide ${expired ? "bg-red-100 text-red-700" : "bg-green-100 text-green-700"}`}>
                      {expired ? "Expired" : "Active"}
                    </span>
                  </div>
                  <div className="text-xs text-muted-foreground mt-1 flex gap-x-3 flex-wrap">
                    {c.insurer && <span>{c.insurer}</span>}
                    {c.policyNumber && <span>Policy #{c.policyNumber}</span>}
                    {c.coverageAmount && <span>${Number(c.coverageAmount).toLocaleString()}</span>}
                  </div>
                  <div className="text-xs text-muted-foreground mt-0.5">
                    {fmtDate(c.effectiveDate)} – {fmtDate(c.expiryDate)}
                  </div>
                  {c.documentKey && (
                    <button
                      onClick={() => openSignedObjectSubcontractor(c.documentKey!)}
                      className="inline-flex items-center gap-1 text-xs text-primary hover:underline mt-1"
                    >
                      <FileText className="w-3 h-3" /> View document
                    </button>
                  )}
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <Button size="sm" variant="ghost" className="h-8 px-2" onClick={() => startEdit(c)}>
                    <Pencil className="w-3.5 h-3.5" />
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-8 px-2 text-destructive hover:bg-destructive/10"
                    disabled={deletingId === c.id}
                    onClick={() => remove(c.id)}
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
