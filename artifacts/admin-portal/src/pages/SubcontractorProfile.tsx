import { useEffect, useRef, useState } from "react";
import { Building2, Upload, FileText, ExternalLink, Save } from "lucide-react";
import { api } from "@/lib/api";
import { uploadFileSubcontractor, openSignedObjectSubcontractor } from "@/lib/upload";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { useToast } from "@/hooks/use-toast";

type Profile = {
  id: string;
  companyName: string;
  contactName: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  address: string | null;
  taxId: string | null;
  bankAccountName: string | null;
  bankAccountNumber: string | null;
  bankRoutingNumber: string | null;
  directDepositConsent: boolean;
  w9DocKey: string | null;
} | null;

type Me = { profile: Profile };

const EMPTY_FORM = {
  companyName: "",
  contactName: "",
  contactEmail: "",
  contactPhone: "",
  address: "",
  taxId: "",
  bankAccountName: "",
  bankAccountNumber: "",
  bankRoutingNumber: "",
  directDepositConsent: false,
  w9DocKey: "",
};

export default function SubcontractorProfile() {
  const { toast } = useToast();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [uploadingW9, setUploadingW9] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [hasProfile, setHasProfile] = useState(false);
  const w9InputRef = useRef<HTMLInputElement>(null);

  function load() {
    setLoading(true);
    return api<Me>("/subcontractor-portal/me")
      .then(({ profile }) => {
        if (profile) {
          setHasProfile(true);
          setForm({
            companyName: profile.companyName ?? "",
            contactName: profile.contactName ?? "",
            contactEmail: profile.contactEmail ?? "",
            contactPhone: profile.contactPhone ?? "",
            address: profile.address ?? "",
            taxId: profile.taxId ?? "",
            bankAccountName: profile.bankAccountName ?? "",
            bankAccountNumber: profile.bankAccountNumber ?? "",
            bankRoutingNumber: profile.bankRoutingNumber ?? "",
            directDepositConsent: profile.directDepositConsent ?? false,
            w9DocKey: profile.w9DocKey ?? "",
          });
        }
      })
      .finally(() => setLoading(false));
  }

  useEffect(() => { load(); }, []);

  function fld<K extends keyof typeof form>(k: K, v: (typeof form)[K]) {
    setForm((f) => ({ ...f, [k]: v }));
  }

  async function onW9Selected(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploadingW9(true);
    try {
      const uploaded = await uploadFileSubcontractor(file);
      fld("w9DocKey", uploaded.objectPath);
      toast({ title: "W-9 uploaded — remember to save." });
    } catch (err: any) {
      toast({ title: err?.message ?? "W-9 upload failed.", variant: "destructive" });
    } finally {
      setUploadingW9(false);
      if (w9InputRef.current) w9InputRef.current.value = "";
    }
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!form.companyName.trim()) {
      toast({ title: "Company name is required.", variant: "destructive" });
      return;
    }
    setSaving(true);
    try {
      await api("/subcontractor-portal/profile", { method: "PUT", body: form });
      toast({ title: "Profile saved." });
      setHasProfile(true);
      await load();
    } catch (err: any) {
      toast({ title: err?.message ?? "Failed to save profile.", variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return <div className="text-center py-16 text-muted-foreground text-sm">Loading…</div>;
  }

  return (
    <div className="max-w-2xl mx-auto px-4 py-8">
      <h1 className="text-xl font-bold flex items-center gap-2 mb-2">
        <Building2 className="w-5 h-5" /> Company Profile
      </h1>
      <p className="text-sm text-muted-foreground mb-6">
        {hasProfile
          ? "Keep your company info, tax details, and banking up to date."
          : "Fill this out once to complete your vendor onboarding — no admin needed."}
      </p>

      <form onSubmit={save} className="space-y-8">
        <section className="border rounded-lg bg-card p-6 space-y-4">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Company &amp; contact</h2>
          <div className="space-y-1">
            <Label htmlFor="companyName">Company name *</Label>
            <Input id="companyName" required value={form.companyName} onChange={(e) => fld("companyName", e.target.value)} />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1">
              <Label htmlFor="contactName">Contact name</Label>
              <Input id="contactName" value={form.contactName} onChange={(e) => fld("contactName", e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="contactPhone">Contact phone</Label>
              <Input id="contactPhone" value={form.contactPhone} onChange={(e) => fld("contactPhone", e.target.value)} />
            </div>
          </div>
          <div className="space-y-1">
            <Label htmlFor="contactEmail">Contact email</Label>
            <Input id="contactEmail" type="email" value={form.contactEmail} onChange={(e) => fld("contactEmail", e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="address">Business address</Label>
            <Input id="address" value={form.address} onChange={(e) => fld("address", e.target.value)} />
          </div>
        </section>

        <section className="border rounded-lg bg-card p-6 space-y-4">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Tax ID &amp; W-9</h2>
          <div className="space-y-1">
            <Label htmlFor="taxId">Tax ID / EIN</Label>
            <Input
              id="taxId"
              value={form.taxId}
              onChange={(e) => fld("taxId", e.target.value)}
              placeholder={form.taxId.startsWith("••••") ? undefined : "e.g. 12-3456789"}
            />
            {form.taxId.startsWith("••••") && (
              <p className="text-xs text-muted-foreground">Saved value hidden for security. Enter a new value to replace it.</p>
            )}
          </div>
          <div className="space-y-1">
            <Label>W-9 form</Label>
            <div className="flex items-center gap-3 flex-wrap">
              <input ref={w9InputRef} type="file" accept=".pdf,.doc,.docx,.jpg,.jpeg,.png" className="hidden" onChange={onW9Selected} />
              <Button type="button" variant="outline" size="sm" className="gap-1.5" disabled={uploadingW9} onClick={() => w9InputRef.current?.click()}>
                <Upload className="w-3.5 h-3.5" /> {uploadingW9 ? "Uploading…" : form.w9DocKey ? "Replace file" : "Upload W-9"}
              </Button>
              {form.w9DocKey && (
                <button
                  type="button"
                  onClick={() => openSignedObjectSubcontractor(form.w9DocKey)}
                  className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                >
                  <FileText className="w-3.5 h-3.5" /> View current file <ExternalLink className="w-3 h-3" />
                </button>
              )}
            </div>
          </div>
        </section>

        <section className="border rounded-lg bg-card p-6 space-y-4">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Banking (for payment)</h2>
          <div className="space-y-1">
            <Label htmlFor="bankAccountName">Account holder name</Label>
            <Input id="bankAccountName" value={form.bankAccountName} onChange={(e) => fld("bankAccountName", e.target.value)} />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1">
              <Label htmlFor="bankRoutingNumber">Routing number</Label>
              <Input
                id="bankRoutingNumber"
                value={form.bankRoutingNumber}
                onChange={(e) => fld("bankRoutingNumber", e.target.value)}
                placeholder={form.bankRoutingNumber.startsWith("••••") ? undefined : undefined}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="bankAccountNumber">Account number</Label>
              <Input id="bankAccountNumber" value={form.bankAccountNumber} onChange={(e) => fld("bankAccountNumber", e.target.value)} />
            </div>
          </div>
          {(form.bankAccountNumber.startsWith("••••") || form.bankRoutingNumber.startsWith("••••")) && (
            <p className="text-xs text-muted-foreground">Saved values hidden for security. Enter new values to replace them.</p>
          )}
          <div className="flex items-center gap-2 pt-1">
            <Checkbox
              id="directDepositConsent"
              checked={form.directDepositConsent}
              onCheckedChange={(v) => fld("directDepositConsent", v === true)}
            />
            <Label htmlFor="directDepositConsent" className="font-normal cursor-pointer">
              I authorize payment to this account via direct deposit / ACH.
            </Label>
          </div>
        </section>

        <div className="flex justify-end">
          <Button type="submit" disabled={saving} className="gap-1.5">
            <Save className="w-4 h-4" /> {saving ? "Saving…" : "Save profile"}
          </Button>
        </div>
      </form>
    </div>
  );
}
