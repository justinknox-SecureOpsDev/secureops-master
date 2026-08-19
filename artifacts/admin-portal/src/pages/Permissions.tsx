import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { useToast } from "@/hooks/use-toast";
import { SlidersHorizontal, Loader2, RotateCcw } from "lucide-react";

type PermissionDetail = {
  key: string;
  label: string;
  description: string;
  area: string;
  allowedRoles: string[];
  defaultAllowedRoles: string[];
  isOverridden: boolean;
};

const ROLE_LABELS: Record<string, string> = {
  admin: "Admin",
  dispatcher: "Dispatcher",
  employee: "Officer",
  site_manager: "Site Manager",
};

export default function PermissionsPage() {
  const qc = useQueryClient();
  const { toast } = useToast();

  const permsQ = useQuery<{ permissions: PermissionDetail[]; assignableRoles: string[] }>({
    queryKey: ["admin", "permissions"],
    queryFn: () => api("/admin/permissions"),
  });

  // Local draft — one entry per key while it's being edited, so the checkbox
  // grid feels responsive without waiting for the round-trip on every click.
  const [draft, setDraft] = useState<Record<string, string[]>>({});
  useEffect(() => {
    if (permsQ.data) {
      const d: Record<string, string[]> = {};
      for (const p of permsQ.data.permissions) d[p.key] = p.allowedRoles;
      setDraft(d);
    }
  }, [permsQ.data]);

  const save = useMutation({
    mutationFn: ({ key, allowedRoles }: { key: string; allowedRoles: string[] | null }) =>
      api(`/admin/permissions/${key}`, { method: "PATCH", body: { allowedRoles } }),
    onSuccess: () => {
      toast({ title: "Saved", description: "Permission updated — takes effect immediately, no redeploy needed." });
      qc.invalidateQueries({ queryKey: ["admin", "permissions"] });
    },
    onError: (err: unknown) => {
      toast({ title: "Failed to save", description: err instanceof Error ? err.message : "Unknown error", variant: "destructive" });
      // Revert the optimistic checkbox change.
      qc.invalidateQueries({ queryKey: ["admin", "permissions"] });
    },
  });

  if (permsQ.isLoading) {
    return <div className="p-6"><Loader2 className="w-5 h-5 animate-spin" /></div>;
  }

  const permissions = permsQ.data?.permissions ?? [];
  const roles = permsQ.data?.assignableRoles ?? ["admin", "dispatcher", "employee", "site_manager"];
  const byArea = new Map<string, PermissionDetail[]>();
  for (const p of permissions) {
    if (!byArea.has(p.area)) byArea.set(p.area, []);
    byArea.get(p.area)!.push(p);
  }

  function toggle(perm: PermissionDetail, role: string) {
    const current = draft[perm.key] ?? perm.allowedRoles;
    const next = current.includes(role) ? current.filter((r) => r !== role) : [...current, role];
    setDraft((d) => ({ ...d, [perm.key]: next }));
    save.mutate({ key: perm.key, allowedRoles: next });
  }

  function resetToDefault(perm: PermissionDetail) {
    setDraft((d) => ({ ...d, [perm.key]: perm.defaultAllowedRoles }));
    save.mutate({ key: perm.key, allowedRoles: null });
  }

  return (
    <div className="p-4 lg:p-6 max-w-4xl space-y-4">
      <header>
        <h1 className="brand-wordmark text-2xl text-brand-navy flex items-center gap-2">
          <SlidersHorizontal className="w-6 h-6 text-brand-gold" />
          Permissions
        </h1>
        <p className="text-sm opacity-70 mt-1">
          Controls which roles may use scheduling, time &amp; attendance, personnel, dispatch, and
          accounting/payroll-transaction actions. Toggling a role here changes what that role can do
          immediately — no redeploy. The <strong>admin</strong> role can never be removed, so a
          mis-click can never lock every admin out of this page. This is separate from the
          company-owner flag, which only gates financial dashboards, not day-to-day transactions.
        </p>
      </header>

      {Array.from(byArea.entries()).map(([area, perms]) => (
        <Card key={area}>
          <CardHeader>
            <CardTitle className="text-base">{area}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {perms.map((perm) => {
              const current = draft[perm.key] ?? perm.allowedRoles;
              return (
                <div key={perm.key} className="border rounded-lg p-3 space-y-2">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <p className="text-sm font-semibold">{perm.label}</p>
                      <p className="text-xs opacity-60">{perm.description}</p>
                    </div>
                    {perm.isOverridden && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="shrink-0 text-xs"
                        onClick={() => resetToDefault(perm)}
                        disabled={save.isPending}
                        data-testid={`reset-${perm.key}`}
                      >
                        <RotateCcw className="w-3 h-3 mr-1" /> Reset to default
                      </Button>
                    )}
                  </div>
                  <div className="flex flex-wrap gap-4">
                    {roles.map((role) => {
                      const isAdmin = role === "admin";
                      return (
                        <label key={role} className="flex items-center gap-2 text-sm select-none">
                          <Checkbox
                            checked={current.includes(role)}
                            disabled={isAdmin || save.isPending}
                            onCheckedChange={() => toggle(perm, role)}
                            data-testid={`checkbox-${perm.key}-${role}`}
                          />
                          {ROLE_LABELS[role] ?? role}
                          {isAdmin && <span className="text-xs opacity-50">(always allowed)</span>}
                        </label>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
