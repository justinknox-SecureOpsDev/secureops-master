import { Lock } from "lucide-react";
import { useAuth } from "@/lib/auth";

/**
 * Gates a financial-dashboard section behind the current user's company-owner
 * flag. This is UI convenience only — every underlying endpoint it protects
 * also enforces `requireCompanyOwner` server-side, so bypassing this
 * component (or calling the API directly) still gets blocked/sanitized.
 *
 * Use to wrap an entire page/section that shows aggregate financial data
 * (revenue, margin, payroll/invoice totals, exports) — NOT for an officer's
 * or site manager's own-pay view, which is unaffected by this flag.
 */
export function OwnerGate({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  if (user?.isCompanyOwner) return <>{children}</>;
  return <OwnerLockedState />;
}

export function OwnerLockedState({ label = "financial dashboard" }: { label?: string }) {
  return (
    <div
      className="border rounded-lg bg-card p-8 flex flex-col items-center text-center gap-2"
      data-testid="owner-locked-state"
      role="status"
    >
      <Lock className="w-6 h-6 text-muted-foreground" />
      <p className="text-sm font-semibold">Owner access required</p>
      <p className="text-xs text-muted-foreground max-w-sm">
        This {label} is restricted to company owners. Ask an existing owner to grant you
        access from Platform → Company Owners.
      </p>
    </div>
  );
}
