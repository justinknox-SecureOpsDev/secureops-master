import { useEffect, useState } from "react";
import { useRoute } from "wouter";
import { Loader2, AlertTriangle, QrCode, CheckCircle2, LogOut, Building2, User, Badge, MapPin } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { BUSINESS_TIME_ZONE } from "@/lib/format";

const API = "/api";

const OTHER_COMPANY = "__other__";

type SiteInfo = {
  siteId: string;
  siteName: string;
  companies: string[];
};

type ToggleResult = {
  action: "clocked_in" | "clocked_out";
  entryId: string;
  name: string;
  company: string;
  siteName: string;
  clockInAt: string;
  clockOutAt?: string | null;
  hoursWorked?: string | null;
};

function fmtDateTime(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    weekday: "short", month: "short", day: "numeric",
    hour: "numeric", minute: "2-digit", timeZone: BUSINESS_TIME_ZONE,
  });
}

export default function SubcontractorClockInPage() {
  const [, params] = useRoute<{ token: string }>("/subcontractor/clock/:token");
  const token = params?.token ?? "";

  const [siteInfo, setSiteInfo] = useState<SiteInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [form, setForm] = useState({ name: "", company: "", badgeId: "" });
  // When true, the company is typed manually (not in the known-companies list).
  const [companyOther, setCompanyOther] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [result, setResult] = useState<ToggleResult | null>(null);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${API}/subcontractor/clock/${encodeURIComponent(token)}`);
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body?.message ?? `Error (${res.status})`);
        if (!cancelled) setSiteInfo(body as SiteInfo);
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [token]);

  async function handleSubmit() {
    if (!form.name.trim()) { setFormError("Name is required"); return; }
    if (!form.company.trim()) { setFormError("Company is required"); return; }
    setFormError(null);
    setSubmitting(true);
    try {
      const res = await fetch(`${API}/subcontractor/clock/${encodeURIComponent(token)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: form.name.trim(), company: form.company.trim(), badgeId: form.badgeId.trim() || undefined }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.message ?? `Error (${res.status})`);
      setResult(body as ToggleResult);
    } catch (e) {
      setFormError((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  function reset() {
    setResult(null);
    setForm({ name: "", company: "", badgeId: "" });
    setCompanyOther(false);
    setFormError(null);
  }

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ background: "#080c18" }}>
        <Loader2 className="w-6 h-6 animate-spin text-white" />
      </div>
    );
  }

  if (error || !siteInfo) {
    return (
      <div className="min-h-screen flex items-center justify-center p-6" style={{ background: "#080c18" }}>
        <div className="max-w-md w-full bg-white rounded-xl p-6 text-center">
          <AlertTriangle className="w-8 h-8 mx-auto mb-3 text-amber-600" />
          <div className="text-lg font-semibold mb-1" style={{ color: "#080c18" }}>QR Code Unavailable</div>
          <div className="text-sm text-muted-foreground">{error ?? "This QR code is no longer valid."}</div>
          <div className="text-xs text-muted-foreground mt-4">
            Please ask your site supervisor for an updated QR code.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen" style={{ background: "#080c18" }}>
      <div style={{ background: "#080c18", color: "#f0e6c8" }}>
        <div className="max-w-lg mx-auto px-6 py-5 flex items-center gap-3">
          <QrCode className="w-5 h-5" style={{ color: "#c9a84c" }} />
          <div>
            <div className="font-bold text-base">Williams Council Security Group</div>
            <div className="text-xs opacity-70">Subcontractor Clock-In / Clock-Out</div>
          </div>
        </div>
      </div>

      <div className="max-w-lg mx-auto p-6 space-y-4">
        {/* Site context */}
        <div className="bg-white rounded-xl p-5">
          <div className="text-sm font-semibold mb-3" style={{ color: "#080c18" }}>Site</div>
          <div className="flex items-center gap-2 text-sm">
            <MapPin className="w-4 h-4 shrink-0 text-muted-foreground" />
            <span className="font-medium text-foreground">{siteInfo.siteName}</span>
          </div>
        </div>

        {result ? (
          <div className="bg-white rounded-xl p-5 space-y-4 text-center">
            {result.action === "clocked_in" ? (
              <>
                <CheckCircle2 className="w-12 h-12 mx-auto text-green-600" />
                <div className="text-lg font-semibold text-green-700">You're clocked in</div>
                <div className="text-sm text-muted-foreground">
                  {result.name} · {result.company}
                  <div className="mt-1">Clocked in at {fmtDateTime(result.clockInAt)}</div>
                </div>
                <p className="text-xs text-muted-foreground">
                  When you leave, scan the same QR code and enter the same name &amp; company to clock out.
                </p>
              </>
            ) : (
              <>
                <LogOut className="w-12 h-12 mx-auto" style={{ color: "#c9a84c" }} />
                <div className="text-lg font-semibold" style={{ color: "#080c18" }}>You're clocked out</div>
                <div className="text-sm text-muted-foreground">
                  {result.name} · {result.company}
                  <div className="mt-1">
                    {fmtDateTime(result.clockInAt)} — {result.clockOutAt ? fmtDateTime(result.clockOutAt) : "—"}
                  </div>
                  {result.hoursWorked && (
                    <div className="mt-1 font-medium text-foreground">{result.hoursWorked} hours logged</div>
                  )}
                </div>
              </>
            )}
            <Button
              className="w-full"
              variant="outline"
              onClick={reset}
            >
              Done
            </Button>
          </div>
        ) : (
          <div className="bg-white rounded-xl p-5 space-y-4">
            <div className="text-sm font-semibold" style={{ color: "#080c18" }}>Enter your details</div>
            <p className="text-xs text-muted-foreground">
              First scan clocks you <strong>in</strong>. Scan again with the same name &amp; company to clock <strong>out</strong>.
            </p>
            {formError && (
              <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded p-3">
                {formError}
              </div>
            )}
            <div className="space-y-3">
              <div className="space-y-1">
                <Label className="flex items-center gap-1 text-xs font-medium">
                  <User className="w-3 h-3" /> Full Name *
                </Label>
                <Input
                  placeholder="Your full name"
                  value={form.name}
                  onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                  disabled={submitting}
                />
              </div>
              <div className="space-y-1">
                <Label className="flex items-center gap-1 text-xs font-medium">
                  <Building2 className="w-3 h-3" /> Company *
                </Label>
                {siteInfo.companies.length > 0 ? (
                  <>
                    <Select
                      value={companyOther ? OTHER_COMPANY : (form.company || undefined)}
                      onValueChange={(v) => {
                        if (v === OTHER_COMPANY) {
                          setCompanyOther(true);
                          setForm((f) => ({ ...f, company: "" }));
                        } else {
                          setCompanyOther(false);
                          setForm((f) => ({ ...f, company: v }));
                        }
                      }}
                      disabled={submitting}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="Select your company" />
                      </SelectTrigger>
                      <SelectContent>
                        {siteInfo.companies.map((c) => (
                          <SelectItem key={c} value={c}>{c}</SelectItem>
                        ))}
                        <SelectItem value={OTHER_COMPANY}>Other (not listed)…</SelectItem>
                      </SelectContent>
                    </Select>
                    {companyOther && (
                      <Input
                        className="mt-2"
                        placeholder="Type your company name"
                        value={form.company}
                        onChange={(e) => setForm((f) => ({ ...f, company: e.target.value }))}
                        disabled={submitting}
                        autoFocus
                      />
                    )}
                  </>
                ) : (
                  <Input
                    placeholder="Your company name"
                    value={form.company}
                    onChange={(e) => setForm((f) => ({ ...f, company: e.target.value }))}
                    disabled={submitting}
                  />
                )}
              </div>
              <div className="space-y-1">
                <Label className="flex items-center gap-1 text-xs font-medium">
                  <Badge className="w-3 h-3" /> Badge / ID (optional)
                </Label>
                <Input
                  placeholder="Badge or ID number"
                  value={form.badgeId}
                  onChange={(e) => setForm((f) => ({ ...f, badgeId: e.target.value }))}
                  disabled={submitting}
                />
              </div>
            </div>
            <Button
              className="w-full"
              style={{ background: "#080c18", color: "#f0e6c8" }}
              onClick={handleSubmit}
              disabled={submitting}
            >
              {submitting ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
              Clock In / Out
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
