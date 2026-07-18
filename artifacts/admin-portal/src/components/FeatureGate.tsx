/**
 * Pricing-tier feature gating for the admin portal.
 *
 * `FeatureGuard` wraps a route's content: when the deployment's plan does not
 * include the feature, the underlying page is replaced with a consistent
 * "upgrade required" affordance instead of rendering (and hitting a server 403).
 *
 * Feature state comes from GET /api/brand (see lib/brand.ts) — all keys default
 * to ENABLED, so newly added features show up automatically on older plans.
 */

import { Link } from "wouter";
import { Lock } from "lucide-react";
import { isFeatureEnabled, type FeatureKey } from "@/lib/brand";

/** Human-readable name + the tier that unlocks each gated feature. */
const FEATURE_META: Record<FeatureKey, { label: string; tier: string }> = {
  chat:            { label: "Team Chat",              tier: "Professional" },
  radio:           { label: "Push-to-Talk Radio",     tier: "Enterprise" },
  incidents:       { label: "Incident Reporting",     tier: "Professional" },
  payroll:         { label: "Payroll",                tier: "Enterprise" },
  invoicing:       { label: "Invoicing",              tier: "Enterprise" },
  hr:              { label: "HR Pipeline",            tier: "Enterprise" },
  liveMap:         { label: "Live Officer Map",       tier: "Professional" },
  policies:        { label: "Policies",               tier: "Professional" },
  swapRequests:    { label: "Shift Swap Requests",    tier: "Professional" },
  licenseRenewals: { label: "License Renewals",       tier: "Professional" },
  dar:             { label: "Daily Activity Reports", tier: "Professional" },
  exports:         { label: "Bulk Data Exports",      tier: "Enterprise" },
  trainings:       { label: "Training Certifications", tier: "Enterprise" },
  patrol:          { label: "Patrol Checkpoints",     tier: "Professional" },
  availability:    { label: "Officer Availability",   tier: "Professional" },
  officerShares:   { label: "Officer Share Links",    tier: "Enterprise" },
};

export function UpgradeRequired({ feature }: { feature: FeatureKey }) {
  const meta = FEATURE_META[feature];
  return (
    <div className="flex flex-1 items-center justify-center p-6">
      <div className="max-w-md w-full rounded-xl border border-border bg-card text-card-foreground p-8 text-center shadow-sm">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-muted">
          <Lock className="h-6 w-6 text-muted-foreground" />
        </div>
        <h2 className="text-lg font-semibold text-foreground">
          {meta.label} isn’t included in your plan
        </h2>
        <p className="mt-2 text-sm text-muted-foreground">
          This feature is available on the{" "}
          <span className="font-semibold brand-gold">{meta.tier}</span> plan and
          above. Upgrade your subscription to unlock it for your whole team.
        </p>
        <Link
          href="/"
          className="mt-6 inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:opacity-90 transition-opacity"
        >
          Back to dashboard
        </Link>
      </div>
    </div>
  );
}

/** Renders children when the feature is enabled, otherwise the upgrade card. */
export function FeatureGuard({
  feature,
  children,
}: {
  feature: FeatureKey;
  children: React.ReactNode;
}) {
  if (!isFeatureEnabled(feature)) return <UpgradeRequired feature={feature} />;
  return <>{children}</>;
}
