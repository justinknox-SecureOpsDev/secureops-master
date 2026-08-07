import { useEffect, useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { refreshBrand } from "@/lib/brand";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import { Shield, Loader2, ExternalLink, Check, Building2, Palette, Upload, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

type TierKey = "starter" | "professional" | "enterprise";

const TIER_DISABLED: Record<TierKey, string[]> = {
  starter: ["chat", "radio", "incidents", "invoicing", "payroll", "hr", "policies", "swapRequests", "licenseRenewals", "dar", "exports", "trainings", "patrol", "availability", "officerShares"],
  professional: ["radio", "invoicing", "payroll", "hr", "trainings", "exports", "officerShares"],
  enterprise: [],
};

type Tier = {
  key: TierKey;
  name: string;
  price: string;
  cadence: string;
  tagline: string;
  highlight?: boolean;
  included: string[];
};

const TIERS: Tier[] = [
  {
    key: "starter",
    name: "Starter",
    price: "$349/mo",
    cadence: "1–25 officers",
    tagline: "Single-site or small operators.",
    included: [
      "Scheduling + repeating shifts",
      "Time clock + geo clock-in",
      "Officer + admin mobile apps",
      "Clients, sites & licenses",
      "Email + push notifications",
    ],
  },
  {
    key: "professional",
    name: "Professional",
    price: "$899/mo",
    cadence: "25–150 officers",
    tagline: "Most security companies.",
    highlight: true,
    included: [
      "Everything in Starter, plus:",
      "Incidents + client share links",
      "Real-time chat",
      "Live officer map + geofence alerts",
      "DARs, swaps, patrol, license renewals",
      "Audit log",
    ],
  },
  {
    key: "enterprise",
    name: "Enterprise",
    price: "$1,200/mo",
    cadence: "150+ officers · +$4/officer over 150",
    tagline: "Full back-office, multi-site.",
    included: [
      "Everything in Professional, plus:",
      "HR pipeline (application + onboarding)",
      "Payroll execution + paystubs",
      "Auto-generated weekly invoicing",
      "Push-to-talk radio",
      "Training certifications + exports",
      "Officer share links",
    ],
  },
];

const ADDONS = [
  { name: "Stripe Connect direct deposits", price: "$99/mo" },
  { name: "Twilio SMS notifications", price: "$39/mo" },
  { name: "Dedicated subdomain + custom email FROM", price: "$25/mo" },
  { name: "Additional sub-brand (multi-tenant)", price: "$199/mo" },
];

const SETUP = [
  { name: "Branding kit", price: "$1,500" },
  { name: "White-label deployment", price: "$2,500" },
  { name: "Apple App Store distribution", price: "$1,200 + $99/yr" },
  { name: "Google Play distribution", price: "$800 + $25 one-time" },
  { name: "Data migration (basic / large)", price: "$750 / $2,000+" },
  { name: "Admin training (live)", price: "$600" },
  { name: "Officer training (video pack)", price: "$400" },
  { name: "On-site go-live support", price: "$1,800/day" },
];

type CustomerConfig = {
  customerName: string | null;
  planTier: "starter" | "professional" | "enterprise" | "custom" | null;
  monthlyPriceCents: number | null;
  officerCount: number | null;
  billingNotes: string | null;
  planStartDate: string | null;
  timeConfirmEditWindowHours: string | null;
  updatedAt?: string | null;
  updatedBy?: string | null;
};

const STANDARD_PRICES: Record<string, number> = {
  starter: 34900,
  professional: 89900,
  enterprise: 199500,
};

// Annual = 10× monthly (2 months free, ~17% off)
const ANNUAL_CENTS: Record<string, number> = {
  starter: 34900 * 10,
  professional: 89900 * 10,
  enterprise: 199500 * 10,
};

function fmtDollars(cents: number) {
  return "$" + Math.round(cents / 100).toLocaleString("en-US");
}

const EMPTY_CONFIG: CustomerConfig = {
  customerName: null,
  planTier: null,
  monthlyPriceCents: null,
  officerCount: null,
  billingNotes: null,
  planStartDate: null,
  timeConfirmEditWindowHours: null,
};

type BrandCfg = {
  companyName: string | null;
  shortName: string | null;
  tagline: string | null;
  companyLicense: string | null;
  appName: string | null;
  colorNavy: string | null;
  colorGold: string | null;
  colorCream: string | null;
  billingEmail: string | null;
  hrEmail: string | null;
  adminNotifyEmail: string | null;
  backgroundCheckAdminUserId: string | null;
  logoDataUrl: string | null;
  updatedAt?: string | null;
  updatedBy?: string | null;
};

const EMPTY_BRAND: BrandCfg = {
  companyName: null,
  shortName: null,
  tagline: null,
  companyLicense: null,
  appName: null,
  colorNavy: null,
  colorGold: null,
  colorCream: null,
  billingEmail: null,
  hrEmail: null,
  adminNotifyEmail: null,
  backgroundCheckAdminUserId: null,
  logoDataUrl: null,
};

// WCSG env defaults — shown as the colour-swatch value when no override is set.
const BRAND_DEFAULTS = { navy: "#0c0a08", gold: "#c9a04a", cream: "#f0e4c0" };
const MAX_LOGO_BYTES = 300 * 1024;

type FeatureDetail = {
  key: string;
  enabled: boolean;
  source: "override" | "env";
  envDisabled: boolean;
};

const LABELS: Record<string, string> = {
  chat: "Team chat",
  radio: "Push-to-talk radio",
  incidents: "Incident reporting",
  payroll: "Payroll (Board, Pay Run, paystubs)",
  invoicing: "Invoicing",
  hr: "HR pipeline (application + onboarding)",
  liveMap: "Live officer map / dispatch",
  policies: "Policies",
  swapRequests: "Shift swap requests",
  licenseRenewals: "License renewals",
  dar: "Daily activity reports",
  exports: "Bulk exports",
  trainings: "Training certifications",
  patrol: "Patrol checkpoints",
  availability: "Officer availability",
  officerShares: "Officer profile share links",
};

export default function PlatformFeaturesPage() {
  const qc = useQueryClient();
  const { toast } = useToast();

  const meQ = useQuery<{ isSuperAdmin: boolean }>({
    queryKey: ["platform", "me"],
    queryFn: () => api("/admin/platform/me"),
  });

  const flagsQ = useQuery<{ features: FeatureDetail[] }>({
    queryKey: ["platform", "features"],
    queryFn: () => api("/admin/platform/features"),
    enabled: meQ.data?.isSuperAdmin === true,
  });

  const configQ = useQuery<{ config: CustomerConfig | null }>({
    queryKey: ["platform", "customer-config"],
    queryFn: () => api("/admin/platform/customer-config"),
    enabled: meQ.data?.isSuperAdmin === true,
  });

  const [configDraft, setConfigDraft] = useState<CustomerConfig>(EMPTY_CONFIG);

  useEffect(() => {
    if (configQ.data) {
      const c = configQ.data.config;
      setConfigDraft(c ? {
        customerName: c.customerName,
        planTier: c.planTier as CustomerConfig["planTier"],
        monthlyPriceCents: c.monthlyPriceCents,
        officerCount: c.officerCount,
        billingNotes: c.billingNotes,
        planStartDate: c.planStartDate,
        timeConfirmEditWindowHours: c.timeConfirmEditWindowHours ?? null,
      } : EMPTY_CONFIG);
    }
  }, [configQ.data]);

  const saveConfig = useMutation({
    mutationFn: (data: CustomerConfig) =>
      api("/admin/platform/customer-config", { method: "PUT", body: data }),
    onSuccess: () => {
      toast({ title: "Saved", description: "Customer account details updated." });
      qc.invalidateQueries({ queryKey: ["platform", "customer-config"] });
    },
    onError: (err: unknown) => {
      toast({ title: "Failed to save", description: err instanceof Error ? err.message : "Unknown error", variant: "destructive" });
    },
  });

  const configDirty = (() => {
    const c = configQ.data?.config;
    if (!c) return Object.values(configDraft).some((v) => v !== null);
    return (
      configDraft.customerName !== (c.customerName ?? null) ||
      configDraft.planTier !== ((c.planTier as CustomerConfig["planTier"]) ?? null) ||
      configDraft.monthlyPriceCents !== (c.monthlyPriceCents ?? null) ||
      configDraft.officerCount !== (c.officerCount ?? null) ||
      configDraft.billingNotes !== (c.billingNotes ?? null) ||
      configDraft.planStartDate !== (c.planStartDate ?? null) ||
      configDraft.timeConfirmEditWindowHours !== (c.timeConfirmEditWindowHours ?? null)
    );
  })();

  const brandQ = useQuery<{ config: BrandCfg | null }>({
    queryKey: ["platform", "brand"],
    queryFn: () => api("/admin/platform/brand"),
    enabled: meQ.data?.isSuperAdmin === true,
  });

  // Admins available to own the background-check step. Falls back to an empty
  // list (the picker then only offers "Every admin") if the fetch fails.
  const adminsQ = useQuery<{ rows: { id: string; email: string; firstName: string | null; lastName: string | null; role: string }[] }>({
    queryKey: ["platform", "admin-users"],
    queryFn: () => api("/admin/tables/users?limit=1000"),
    enabled: meQ.data?.isSuperAdmin === true,
  });
  const adminUsers = (adminsQ.data?.rows ?? []).filter((u) => u.role === "admin");

  const [brandDraft, setBrandDraft] = useState<BrandCfg>(EMPTY_BRAND);
  const logoInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (brandQ.data) {
      const c = brandQ.data.config;
      setBrandDraft(c ? {
        companyName: c.companyName,
        shortName: c.shortName,
        tagline: c.tagline,
        companyLicense: c.companyLicense,
        appName: c.appName,
        colorNavy: c.colorNavy,
        colorGold: c.colorGold,
        colorCream: c.colorCream,
        billingEmail: c.billingEmail,
        hrEmail: c.hrEmail,
        adminNotifyEmail: c.adminNotifyEmail,
        backgroundCheckAdminUserId: c.backgroundCheckAdminUserId,
        logoDataUrl: c.logoDataUrl,
      } : EMPTY_BRAND);
    }
  }, [brandQ.data]);

  const saveBrand = useMutation({
    mutationFn: (data: BrandCfg) =>
      api("/admin/platform/brand", { method: "PUT", body: data }),
    onSuccess: async () => {
      await refreshBrand();
      toast({ title: "Branding saved", description: "New branding is live across the portal." });
      qc.invalidateQueries({ queryKey: ["platform", "brand"] });
    },
    onError: (err: unknown) => {
      toast({ title: "Failed to save", description: err instanceof Error ? err.message : "Unknown error", variant: "destructive" });
    },
  });

  const brandDirty = (() => {
    const c = brandQ.data?.config;
    const keys: (keyof BrandCfg)[] = ["companyName", "shortName", "tagline", "companyLicense", "appName", "colorNavy", "colorGold", "colorCream", "billingEmail", "hrEmail", "adminNotifyEmail", "backgroundCheckAdminUserId", "logoDataUrl"];
    return keys.some((k) => (brandDraft[k] ?? null) !== ((c?.[k] as string | null | undefined) ?? null));
  })();

  function onLogoFile(file: File | undefined) {
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      toast({ title: "Not an image", description: "Choose a PNG, JPG, or SVG file.", variant: "destructive" });
      return;
    }
    if (file.size > MAX_LOGO_BYTES) {
      toast({ title: "Logo too large", description: "Keep it under 300 KB (a square PNG works best).", variant: "destructive" });
      return;
    }
    const reader = new FileReader();
    reader.onload = () => setBrandDraft((p) => ({ ...p, logoDataUrl: String(reader.result) }));
    reader.readAsDataURL(file);
  }

  const [billingPeriod, setBillingPeriod] = useState<"monthly" | "annual">("monthly");

  // Local "dirty" overrides — applied on Save. null = use env baseline.
  const [draft, setDraft] = useState<Record<string, boolean | null>>({});

  useEffect(() => {
    if (flagsQ.data) {
      const d: Record<string, boolean | null> = {};
      for (const f of flagsQ.data.features) {
        d[f.key] = f.source === "override" ? f.enabled : null;
      }
      setDraft(d);
    }
  }, [flagsQ.data]);

  const save = useMutation({
    mutationFn: (updates: Array<{ key: string; enabled: boolean | null }>) =>
      api("/admin/platform/features", { method: "PUT", body: { updates } }),
    onSuccess: async () => {
      await refreshBrand();
      toast({ title: "Saved", description: "Feature flags updated. Navigation will refresh on next page load." });
      qc.invalidateQueries({ queryKey: ["platform", "features"] });
    },
    onError: (err: unknown) => {
      toast({
        title: "Failed to save",
        description: err instanceof Error ? err.message : "Unknown error",
        variant: "destructive",
      });
    },
  });

  if (meQ.isLoading) {
    return <div className="p-6"><Loader2 className="w-5 h-5 animate-spin" /></div>;
  }
  if (meQ.data && !meQ.data.isSuperAdmin) {
    return (
      <div className="p-6 max-w-2xl">
        <Card>
          <CardContent className="p-6 text-sm">
            <Shield className="w-5 h-5 mb-2 text-brand-gold" />
            This page is restricted to platform super-admins.
            Add your email to the <code>SUPER_ADMIN_EMAILS</code> env var on the API server to gain access.
          </CardContent>
        </Card>
      </div>
    );
  }

  const features = flagsQ.data?.features ?? [];
  const effective = (k: string) => {
    const d = draft[k];
    if (d !== undefined && d !== null) return d;
    if (d === null) {
      // env baseline
      const f = features.find((x) => x.key === k);
      return f ? !f.envDisabled : true;
    }
    return features.find((x) => x.key === k)?.enabled ?? true;
  };

  const dirty = features.some((f) => {
    const d = draft[f.key];
    const current = f.source === "override" ? f.enabled : null;
    return d !== current;
  });

  return (
    <div className="p-4 lg:p-6 max-w-4xl space-y-4">
      <header>
        <h1 className="brand-wordmark text-2xl text-brand-navy flex items-center gap-2">
          <Shield className="w-6 h-6 text-brand-gold" />
          Platform — Feature flags &amp; pricing
        </h1>
        <p className="text-sm opacity-70 mt-1">
          Owner-only. Toggling a feature hides it from the admin portal nav and mobile tabs,
          and the API returns 403 on every route inside that surface. Apply a pricing tier below
          to preset the toggles, then click Save changes. Public pricing page lives at{" "}
          <a className="underline text-brand-gold" href="/home/pricing" target="_blank" rel="noreferrer">
            /home/pricing <ExternalLink className="inline w-3 h-3" />
          </a>.
        </p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Palette className="w-4 h-4 text-brand-gold" />
            Branding
          </CardTitle>
          <p className="text-xs opacity-60 mt-1">
            Customize this deployment's identity. Saved values override the deployment env defaults and
            apply live across the portal, emails, and PDFs — no redeploy needed. Leave a field blank to
            fall back to the default. (The shared sign-in screen keeps the SecureOps Command mark.)
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-1">
              <p className="text-xs font-semibold uppercase tracking-wide opacity-60">Company name</p>
              <Input
                placeholder="Williams Council Security Group"
                value={brandDraft.companyName ?? ""}
                onChange={(e) => setBrandDraft((p) => ({ ...p, companyName: e.target.value || null }))}
              />
            </div>
            <div className="space-y-1">
              <p className="text-xs font-semibold uppercase tracking-wide opacity-60">Short name</p>
              <Input
                placeholder="WCSG"
                value={brandDraft.shortName ?? ""}
                onChange={(e) => setBrandDraft((p) => ({ ...p, shortName: e.target.value || null }))}
              />
            </div>
            <div className="space-y-1">
              <p className="text-xs font-semibold uppercase tracking-wide opacity-60">Tagline</p>
              <Input
                placeholder="Professional Security Services"
                value={brandDraft.tagline ?? ""}
                onChange={(e) => setBrandDraft((p) => ({ ...p, tagline: e.target.value || null }))}
              />
            </div>
            <div className="space-y-1">
              <p className="text-xs font-semibold uppercase tracking-wide opacity-60">App name</p>
              <Input
                placeholder="SecureOps"
                value={brandDraft.appName ?? ""}
                onChange={(e) => setBrandDraft((p) => ({ ...p, appName: e.target.value || null }))}
              />
            </div>
            <div className="space-y-1 md:col-span-2">
              <p className="text-xs font-semibold uppercase tracking-wide opacity-60">Company license #</p>
              <Input
                placeholder='e.g. TX DPS Lic. #B12345'
                value={brandDraft.companyLicense ?? ""}
                onChange={(e) => setBrandDraft((p) => ({ ...p, companyLicense: e.target.value || null }))}
              />
              <p className="text-xs opacity-50">Shown exactly as typed across the portal, mobile app, marketing site, emails, and every generated PDF. Leave blank to hide.</p>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            {([
              ["Navy (primary)", "colorNavy", BRAND_DEFAULTS.navy],
              ["Gold (accent)", "colorGold", BRAND_DEFAULTS.gold],
              ["Cream (surface)", "colorCream", BRAND_DEFAULTS.cream],
            ] as const).map(([label, key, def]) => (
              <div className="space-y-1" key={key}>
                <p className="text-xs font-semibold uppercase tracking-wide opacity-60">{label}</p>
                <div className="flex items-center gap-2">
                  <input
                    type="color"
                    aria-label={label}
                    className="h-10 w-12 shrink-0 rounded-md border cursor-pointer bg-background"
                    value={brandDraft[key] ?? def}
                    onChange={(e) => setBrandDraft((p) => ({ ...p, [key]: e.target.value }))}
                  />
                  <Input
                    placeholder={def}
                    value={brandDraft[key] ?? ""}
                    onChange={(e) => setBrandDraft((p) => ({ ...p, [key]: e.target.value || null }))}
                  />
                </div>
              </div>
            ))}
          </div>

          <div className="space-y-2">
            <p className="text-xs font-semibold uppercase tracking-wide opacity-60">Company logo</p>
            <div className="flex items-center gap-4">
              <div className="w-16 h-16 shrink-0 rounded-md border bg-brand-navy flex items-center justify-center overflow-hidden">
                {brandDraft.logoDataUrl ? (
                  <img src={brandDraft.logoDataUrl} alt="Logo preview" className="w-full h-full object-contain" />
                ) : (
                  <span className="text-[10px] text-white/50 px-1 text-center">No logo</span>
                )}
              </div>
              <div className="flex items-center gap-2">
                <input
                  ref={logoInputRef}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={(e) => { onLogoFile(e.target.files?.[0]); e.target.value = ""; }}
                />
                <Button type="button" variant="outline" size="sm" onClick={() => logoInputRef.current?.click()}>
                  <Upload className="w-4 h-4 mr-2" /> Upload logo
                </Button>
                {brandDraft.logoDataUrl && (
                  <Button type="button" variant="ghost" size="sm" onClick={() => setBrandDraft((p) => ({ ...p, logoDataUrl: null }))}>
                    <X className="w-4 h-4 mr-1" /> Remove
                  </Button>
                )}
              </div>
            </div>
            <p className="text-xs opacity-50">Square PNG or SVG, under 300 KB. Shown on post-login headers, onboarding pages, and PDFs.</p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="space-y-1">
              <p className="text-xs font-semibold uppercase tracking-wide opacity-60">Billing email</p>
              <Input
                type="email"
                placeholder="billing@…"
                value={brandDraft.billingEmail ?? ""}
                onChange={(e) => setBrandDraft((p) => ({ ...p, billingEmail: e.target.value || null }))}
              />
            </div>
            <div className="space-y-1">
              <p className="text-xs font-semibold uppercase tracking-wide opacity-60">HR email</p>
              <Input
                type="email"
                placeholder="hr@…"
                value={brandDraft.hrEmail ?? ""}
                onChange={(e) => setBrandDraft((p) => ({ ...p, hrEmail: e.target.value || null }))}
              />
            </div>
            <div className="space-y-1">
              <p className="text-xs font-semibold uppercase tracking-wide opacity-60">Ops / alerts email</p>
              <Input
                type="email"
                placeholder="ops@…"
                value={brandDraft.adminNotifyEmail ?? ""}
                onChange={(e) => setBrandDraft((p) => ({ ...p, adminNotifyEmail: e.target.value || null }))}
              />
            </div>
            <div className="space-y-1">
              <p className="text-xs font-semibold uppercase tracking-wide opacity-60">Background-check admin</p>
              <select
                aria-label="Background-check admin"
                className="w-full h-9 rounded-md border border-input bg-background px-3 text-sm"
                value={brandDraft.backgroundCheckAdminUserId ?? ""}
                onChange={(e) => setBrandDraft((p) => ({ ...p, backgroundCheckAdminUserId: e.target.value || null }))}
              >
                <option value="">Every admin</option>
                {adminUsers.map((u) => (
                  <option key={u.id} value={u.id}>
                    {[u.firstName, u.lastName].filter(Boolean).join(" ") || u.email}
                  </option>
                ))}
              </select>
              <p className="text-xs opacity-60">
                Gets the notification when an approved applicant needs a background check.
              </p>
            </div>
          </div>

          {brandQ.data?.config?.updatedBy && (
            <p className="text-xs opacity-50">
              Last updated by {brandQ.data.config.updatedBy}
              {brandQ.data.config.updatedAt
                ? ` · ${new Date(brandQ.data.config.updatedAt).toLocaleDateString()}`
                : ""}
            </p>
          )}
          <div className="flex items-center gap-3">
            <Button
              size="sm"
              onClick={() => saveBrand.mutate(brandDraft)}
              disabled={!brandDirty || saveBrand.isPending}
            >
              {saveBrand.isPending ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
              Save branding
            </Button>
            {brandDirty && <span className="text-xs opacity-70">Unsaved changes</span>}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Building2 className="w-4 h-4 text-brand-gold" />
            Customer account
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-1">
              <p className="text-xs font-semibold uppercase tracking-wide opacity-60">Company name</p>
              <Input
                placeholder="e.g. Williams Council Security Group"
                value={configDraft.customerName ?? ""}
                onChange={(e) => setConfigDraft((p) => ({ ...p, customerName: e.target.value || null }))}
              />
            </div>
            <div className="space-y-1">
              <p className="text-xs font-semibold uppercase tracking-wide opacity-60">Plan tier</p>
              <select
                className="w-full h-10 border rounded-md px-3 text-sm bg-background text-foreground"
                value={configDraft.planTier ?? ""}
                onChange={(e) => setConfigDraft((p) => ({ ...p, planTier: (e.target.value as CustomerConfig["planTier"]) || null }))}
              >
                <option value="">— not set —</option>
                <option value="starter">Starter</option>
                <option value="professional">Professional</option>
                <option value="enterprise">Enterprise</option>
                <option value="custom">Custom</option>
              </select>
            </div>
            <div className="space-y-1">
              <p className="text-xs font-semibold uppercase tracking-wide opacity-60">Monthly price</p>
              <div className="flex items-center gap-2">
                <span className="text-sm opacity-60">$</span>
                <Input
                  type="number"
                  min={0}
                  step={1}
                  placeholder={
                    configDraft.planTier && STANDARD_PRICES[configDraft.planTier]
                      ? `${(STANDARD_PRICES[configDraft.planTier]! / 100).toFixed(0)} (standard)`
                      : "e.g. 899"
                  }
                  value={configDraft.monthlyPriceCents != null ? (configDraft.monthlyPriceCents / 100).toFixed(0) : ""}
                  onChange={(e) => {
                    const v = parseFloat(e.target.value);
                    setConfigDraft((p) => ({ ...p, monthlyPriceCents: isNaN(v) ? null : Math.round(v * 100) }));
                  }}
                />
                <span className="text-sm opacity-60 whitespace-nowrap">/mo</span>
              </div>
              {configDraft.planTier && STANDARD_PRICES[configDraft.planTier] && configDraft.monthlyPriceCents == null && (
                <p className="text-xs opacity-50">Standard: ${(STANDARD_PRICES[configDraft.planTier]! / 100).toFixed(0)}/mo</p>
              )}
            </div>
            <div className="space-y-1">
              <p className="text-xs font-semibold uppercase tracking-wide opacity-60">Active officers</p>
              <Input
                type="number"
                min={1}
                placeholder="e.g. 47"
                value={configDraft.officerCount ?? ""}
                onChange={(e) => {
                  const v = parseInt(e.target.value, 10);
                  setConfigDraft((p) => ({ ...p, officerCount: isNaN(v) ? null : v }));
                }}
              />
            </div>
            <div className="space-y-1">
              <p className="text-xs font-semibold uppercase tracking-wide opacity-60">Plan start date</p>
              <Input
                type="date"
                value={configDraft.planStartDate ?? ""}
                onChange={(e) => setConfigDraft((p) => ({ ...p, planStartDate: e.target.value || null }))}
              />
            </div>
          </div>
          <div className="space-y-2 border rounded-lg p-4">
            <div>
              <p className="text-sm font-semibold">Officer time-edit limit</p>
              <p className="text-xs opacity-60">
                How far an officer may move their own clock-in / clock-out from the recorded time
                when confirming a shift. Larger corrections are blocked and must be handled by an admin.
              </p>
            </div>
            <div className="flex items-center gap-2 pt-1">
              <p className="text-xs font-semibold uppercase tracking-wide opacity-60 whitespace-nowrap">Limit</p>
              <Input
                type="number"
                min={0}
                step={0.25}
                className="w-28"
                placeholder="2"
                value={configDraft.timeConfirmEditWindowHours ?? ""}
                onChange={(e) => setConfigDraft((p) => ({ ...p, timeConfirmEditWindowHours: e.target.value || null }))}
              />
              <span className="text-sm opacity-60">hours (blank = default 2h)</span>
            </div>
          </div>
          <div className="space-y-1">
            <p className="text-xs font-semibold uppercase tracking-wide opacity-60">Billing notes</p>
            <Textarea
              placeholder="Custom terms, discounts, renewal dates, contact info…"
              rows={3}
              value={configDraft.billingNotes ?? ""}
              onChange={(e) => setConfigDraft((p) => ({ ...p, billingNotes: e.target.value || null }))}
            />
          </div>
          {configQ.data?.config?.updatedBy && (
            <p className="text-xs opacity-50">
              Last updated by {configQ.data.config.updatedBy}
              {configQ.data.config.updatedAt
                ? ` · ${new Date(configQ.data.config.updatedAt).toLocaleDateString()}`
                : ""}
            </p>
          )}
          <div className="flex items-center gap-3">
            <Button
              size="sm"
              onClick={() => saveConfig.mutate(configDraft)}
              disabled={!configDirty || saveConfig.isPending}
            >
              {saveConfig.isPending ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
              Save account details
            </Button>
            {configDirty && <span className="text-xs opacity-70">Unsaved changes</span>}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-4 flex-wrap">
            <CardTitle className="text-base">Pricing tiers</CardTitle>
            <div className="flex items-center text-xs border rounded-lg overflow-hidden shadow-sm">
              <button
                type="button"
                className={
                  "px-3 py-1.5 transition-colors " +
                  (billingPeriod === "monthly"
                    ? "bg-brand-navy text-white font-semibold"
                    : "hover:bg-slate-50 text-foreground")
                }
                onClick={() => setBillingPeriod("monthly")}
              >
                Monthly
              </button>
              <button
                type="button"
                className={
                  "px-3 py-1.5 transition-colors flex items-center gap-1.5 " +
                  (billingPeriod === "annual"
                    ? "bg-brand-navy text-white font-semibold"
                    : "hover:bg-slate-50 text-foreground")
                }
                onClick={() => setBillingPeriod("annual")}
              >
                Annual
                {billingPeriod !== "annual" && (
                  <span className="text-green-600 font-bold">−17%</span>
                )}
              </button>
            </div>
          </div>
          {billingPeriod === "annual" && (
            <p className="text-xs text-green-600 mt-1 font-medium">
              2 months free — billed as a single annual payment
            </p>
          )}
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            {TIERS.map((t) => (
              <div
                key={t.key}
                className={
                  "relative rounded-lg border p-4 flex flex-col " +
                  (t.highlight ? "border-brand-gold bg-brand-gold/5" : "border-slate-200")
                }
              >
                {t.highlight && (
                  <span className="absolute -top-2 left-3 px-2 py-0.5 text-[10px] tracking-wider uppercase font-bold rounded-full bg-brand-gold text-brand-navy">
                    Most popular
                  </span>
                )}
                <div className="text-sm font-semibold text-brand-navy">{t.name}</div>
                <div className="text-xs opacity-70">{t.tagline}</div>
                {billingPeriod === "monthly" ? (
                  <>
                    <div className="mt-2 text-2xl font-bold text-brand-gold leading-none">{t.price}</div>
                    <div className="text-[11px] uppercase tracking-wide opacity-60 mt-1">{t.cadence}</div>
                  </>
                ) : (
                  <>
                    <div className="mt-2 text-2xl font-bold text-brand-gold leading-none">
                      {fmtDollars(Math.round(ANNUAL_CENTS[t.key]! / 12))}/mo
                    </div>
                    <div className="text-[11px] opacity-60 mt-0.5">
                      {fmtDollars(ANNUAL_CENTS[t.key]!)}/yr billed annually
                    </div>
                    <div className="mt-1 inline-flex items-center gap-1 text-[11px] font-semibold text-green-600">
                      Save {fmtDollars(STANDARD_PRICES[t.key]! * 2)}/yr
                      <span className="opacity-60 font-normal">(2 months free)</span>
                    </div>
                    <div className="text-[11px] uppercase tracking-wide opacity-60 mt-1">{t.cadence}</div>
                  </>
                )}
                <ul className="mt-3 space-y-1 text-xs flex-1">
                  {t.included.map((line) => (
                    <li key={line} className="flex gap-1.5">
                      <Check className="w-3 h-3 text-brand-gold mt-0.5 flex-shrink-0" />
                      <span>{line}</span>
                    </li>
                  ))}
                </ul>
                <Button
                  variant="outline"
                  size="sm"
                  className="mt-3"
                  onClick={() => {
                    const disabled = new Set(TIER_DISABLED[t.key]);
                    const next: Record<string, boolean | null> = {};
                    for (const f of features) {
                      next[f.key] = !disabled.has(f.key);
                    }
                    setDraft(next);
                    setConfigDraft((p) => ({ ...p, planTier: t.key }));
                    toast({
                      title: `Previewing ${t.name}`,
                      description: "Toggles updated below. Click Save changes to apply.",
                    });
                  }}
                >
                  Apply {t.name} preset
                </Button>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Features</CardTitle>
        </CardHeader>
        <CardContent className="space-y-1">
          {features.map((f) => {
            const on = effective(f.key);
            const d = draft[f.key];
            const overridden = d !== null && d !== undefined;
            return (
              <div key={f.key} className="flex items-center justify-between gap-3 py-2 border-b last:border-b-0">
                <div className="flex-1">
                  <div className="font-medium text-sm">{LABELS[f.key] ?? f.key}</div>
                  <div className="text-xs opacity-60 font-mono">
                    {f.key}
                    {overridden ? " · override" : ` · ${f.envDisabled ? "off via env" : "on via env"}`}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {overridden && (
                    <button
                      type="button"
                      onClick={() => setDraft((p) => ({ ...p, [f.key]: null }))}
                      className="text-xs underline opacity-60 hover:opacity-100"
                    >
                      reset
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => setDraft((p) => ({ ...p, [f.key]: !on }))}
                    aria-pressed={on}
                    className={
                      "relative inline-flex h-6 w-11 items-center rounded-full transition " +
                      (on ? "bg-emerald-500" : "bg-slate-300")
                    }
                  >
                    <span className={
                      "inline-block h-5 w-5 transform rounded-full bg-white shadow transition " +
                      (on ? "translate-x-5" : "translate-x-1")
                    } />
                  </button>
                </div>
              </div>
            );
          })}
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Add-ons</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {ADDONS.map((a) => (
              <div key={a.name} className="flex items-center justify-between text-sm py-1.5 border-b last:border-b-0">
                <span>{a.name}</span>
                <span className="font-semibold text-brand-gold whitespace-nowrap">{a.price}</span>
              </div>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Setup &amp; onboarding (one-time)</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {SETUP.map((s) => (
              <div key={s.name} className="flex items-center justify-between text-sm py-1.5 border-b last:border-b-0">
                <span>{s.name}</span>
                <span className="font-semibold text-brand-gold whitespace-nowrap">{s.price}</span>
              </div>
            ))}
            <div className="pt-2 text-xs opacity-70">
              Typical launch bundle: <strong className="text-brand-gold">$5,650</strong> (branding +
              white-label deploy + App Store + Play Store + basic migration + admin training).
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="flex items-center gap-3">
        <Button
          onClick={() => {
            const updates = features
              .map((f) => ({ key: f.key, enabled: draft[f.key] === undefined ? (f.source === "override" ? f.enabled : null) : draft[f.key]! }))
              .filter((u, _, _arr) => {
                const orig = features.find((x) => x.key === u.key);
                const current = orig?.source === "override" ? orig.enabled : null;
                return u.enabled !== current;
              });
            if (updates.length === 0) return;
            save.mutate(updates);
          }}
          disabled={!dirty || save.isPending}
        >
          {save.isPending ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
          Save changes
        </Button>
        {dirty && (
          <span className="text-xs opacity-70">Unsaved changes</span>
        )}
      </div>
    </div>
  );
}
