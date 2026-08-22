import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";
import { LoadFailedNotice } from "@/components/SettingsStatus";
import { KeyRound, Loader2 } from "lucide-react";

type OwnerRow = {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  role: string;
  status: string;
  isCompanyOwner: boolean;
};

export default function CompanyOwnersPage() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { user } = useAuth();

  const q = useQuery<{ users: OwnerRow[]; ownerCount: number }>({
    queryKey: ["admin", "company-owners"],
    queryFn: () => api("/admin/company-owners"),
  });

  const [pendingRevoke, setPendingRevoke] = useState<OwnerRow | null>(null);

  const setOwner = useMutation({
    mutationFn: ({ id, isCompanyOwner }: { id: string; isCompanyOwner: boolean }) =>
      api(`/admin/company-owners/${id}`, { method: "PATCH", body: { isCompanyOwner } }),
    onSuccess: (_data, vars) => {
      toast({
        title: vars.isCompanyOwner ? "Owner access granted" : "Owner access revoked",
        description: vars.isCompanyOwner
          ? "This user can now see company-wide financial dashboards."
          : "Their next API call to a financial dashboard is blocked immediately — no re-login needed.",
      });
      qc.invalidateQueries({ queryKey: ["admin", "company-owners"] });
    },
    onError: (err: unknown) => {
      toast({ title: "Failed to update", description: err instanceof Error ? err.message : "Unknown error", variant: "destructive" });
    },
  });

  if (q.isLoading) {
    return <div className="p-6"><Loader2 className="w-5 h-5 animate-spin" /></div>;
  }

  // A 403 is the server telling us plainly that the viewer isn't (or is no
  // longer) a company owner — distinct from a transient read/refetch
  // failure. The mutation's onSuccess triggers a background invalidation
  // refetch right after a toggle; if THAT fails (network blip, 5xx), it must
  // never be presented as "you lost owner access" — the toast already
  // confirmed the toggle worked.
  const isForbidden = q.error instanceof ApiError && q.error.status === 403;
  if (isForbidden) {
    return (
      <div className="p-6 max-w-2xl">
        <Card>
          <CardContent className="p-6 text-sm">
            <KeyRound className="w-5 h-5 mb-2 text-brand-gold" />
            Owner access required. This page is restricted to existing company owners.
          </CardContent>
        </Card>
      </div>
    );
  }

  // Any other read failure is unknown, not a refusal (dropped connection,
  // 5xx, proxy hiccup) — see @/lib/settingsStatus. With no last-known rows to
  // fall back on, say so plainly with a retry instead of guessing.
  if (q.isError && !q.data) {
    return (
      <div className="p-6 max-w-2xl">
        <LoadFailedNotice
          label="company owners"
          message="Couldn't load the company owners list — the server didn't respond."
          hasLastKnown={false}
          onRetry={() => void q.refetch()}
          retrying={q.isFetching}
        />
      </div>
    );
  }

  const rows = q.data?.users ?? [];
  const ownerCount = q.data?.ownerCount ?? 0;

  return (
    <div className="p-4 lg:p-6 max-w-4xl space-y-4">
      <header>
        <h1 className="brand-wordmark text-2xl text-brand-navy flex items-center gap-2">
          <KeyRound className="w-6 h-6 text-brand-gold" />
          Company Owners
        </h1>
        <p className="text-sm opacity-70 mt-1">
          Company owner is independent of role and of the Permissions matrix — it only controls
          access to company-wide revenue, margin, payroll, and invoice dashboards. Only an existing
          owner can grant or revoke it. At least one owner must always remain, and this can never
          grant platform-level super-admin access.
        </p>
      </header>

      {q.isError && (
        // A background refetch failed (e.g. right after a toggle's
        // invalidateQueries) but we still have the last-known rows — keep
        // the table on screen instead of blanking it, per
        // @/components/SettingsStatus.
        <LoadFailedNotice
          label="company owners"
          message="Couldn't refresh the owners list — the server didn't respond."
          hasLastKnown={true}
          onRetry={() => void q.refetch()}
          retrying={q.isFetching}
        />
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            Users
            <Badge variant="secondary">{ownerCount} owner{ownerCount === 1 ? "" : "s"}</Badge>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Email</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Company owner</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => {
                const isSelf = r.id === user?.id;
                return (
                  <TableRow key={r.id} data-testid={`row-owner-${r.id}`}>
                    <TableCell>{[r.firstName, r.lastName].filter(Boolean).join(" ") || "—"}</TableCell>
                    <TableCell className="text-sm opacity-70">{r.email}</TableCell>
                    <TableCell className="capitalize">{r.role}</TableCell>
                    <TableCell className="capitalize">{r.status}</TableCell>
                    <TableCell className="text-right">
                      <Switch
                        checked={r.isCompanyOwner}
                        disabled={setOwner.isPending}
                        aria-label={`Toggle company owner for ${r.email}`}
                        data-testid={`switch-owner-${r.id}`}
                        onCheckedChange={(checked) => {
                          if (!checked) {
                            // Revoking is destructive (loses dashboard access
                            // immediately) — confirm first, especially for self.
                            setPendingRevoke(r);
                          } else {
                            setOwner.mutate({ id: r.id, isCompanyOwner: true });
                          }
                        }}
                      />
                      {isSelf && <span className="ml-2 text-xs opacity-50">(you)</span>}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <AlertDialog open={!!pendingRevoke} onOpenChange={(open) => { if (!open) setPendingRevoke(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Revoke company owner access?</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingRevoke?.id === user?.id
                ? "This will immediately remove your own access to financial dashboards. "
                : `${pendingRevoke?.firstName} ${pendingRevoke?.lastName} will immediately lose access to financial dashboards. `}
              This takes effect on their very next request — no re-login required. This does not
              change their role or any other permission.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (pendingRevoke) setOwner.mutate({ id: pendingRevoke.id, isCompanyOwner: false });
                setPendingRevoke(null);
              }}
            >
              Revoke
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
