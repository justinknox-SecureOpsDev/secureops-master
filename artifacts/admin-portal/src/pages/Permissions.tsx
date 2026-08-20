import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { errorText, writeWasRefused, type SettingsMessage } from "@/lib/settingsStatus";
import { ControlMessage, LoadFailedNotice } from "@/components/SettingsStatus";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
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

type PermsResponse = { permissions: PermissionDetail[]; assignableRoles: string[] };

const PERMS_KEY = ["admin", "permissions"] as const;

export default function PermissionsPage() {
  const qc = useQueryClient();

  const permsQ = useQuery<PermsResponse>({
    queryKey: PERMS_KEY,
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

  // Per-permission result, rendered on the row that produced it. A page-top
  // banner is scrolled off-screen on a phone, where these rows stack.
  const [messages, setMessages] = useState<Record<string, SettingsMessage | undefined>>({});
  const [busyKey, setBusyKey] = useState<string | null>(null);

  /** Re-reads the matrix and syncs one key's checkboxes to what is stored. */
  async function rereadKey(key: string): Promise<boolean> {
    const r = await permsQ.refetch();
    if (r.isError || !r.data) return false;
    const stored = r.data.permissions.find((p) => p.key === key);
    if (stored) setDraft((d) => ({ ...d, [key]: stored.allowedRoles }));
    return true;
  }

  async function applyRoles(
    perm: PermissionDetail,
    allowedRoles: string[] | null,
    optimistic: string[],
  ) {
    setMessages((m) => ({ ...m, [perm.key]: undefined }));
    setDraft((d) => ({ ...d, [perm.key]: optimistic }));
    setBusyKey(perm.key);
    try {
      const reply = await api<{ permission: PermissionDetail }>(
        `/admin/permissions/${perm.key}`,
        { method: "PATCH", body: { allowedRoles } },
      );
      // The write reply is authoritative: commit it (fencing any read that was
      // already in flight) *before* the confirming refresh, so a failed refresh
      // can't redraw a stored change as if it never happened.
      await qc.cancelQueries({ queryKey: PERMS_KEY });
      qc.setQueryData<PermsResponse>(PERMS_KEY, (prev) =>
        prev
          ? {
              ...prev,
              permissions: prev.permissions.map((p) =>
                p.key === reply.permission.key ? reply.permission : p,
              ),
            }
          : prev,
      );
      setDraft((d) => ({ ...d, [perm.key]: reply.permission.allowedRoles }));
      const reread = await permsQ.refetch();
      setMessages((m) => ({
        ...m,
        [perm.key]: reread.isError
          ? {
              kind: "warn",
              text: "Saved — this page couldn't re-read the matrix, so the boxes show what the server returned.",
            }
          : { kind: "ok", text: "Saved — in effect immediately, no redeploy needed." },
      }));
    } catch (e) {
      if (writeWasRefused(e)) {
        // The route refused it: nothing was written, so undo the optimistic tick.
        setDraft((d) => ({ ...d, [perm.key]: perm.allowedRoles }));
        setMessages((m) => ({
          ...m,
          [perm.key]: { kind: "error", text: `Not saved — ${errorText(e)}` },
        }));
        return;
      }
      // 5xx / no answer: unknown outcome. Show what is actually stored instead
      // of guessing in either direction.
      const reread = await rereadKey(perm.key);
      setMessages((m) => ({
        ...m,
        [perm.key]: {
          kind: "error",
          text: reread
            ? `Couldn't confirm the change (${errorText(e)}). The boxes now show what is stored — if they didn't change, try again.`
            : `Couldn't confirm the change (${errorText(e)}) and this page couldn't re-read the matrix. Reload the page to see what is stored.`,
        },
      }));
    } finally {
      setBusyKey(null);
    }
  }

  if (permsQ.isLoading) {
    return <div className="p-6"><Loader2 className="w-5 h-5 animate-spin" /></div>;
  }

  const permissions = permsQ.data?.permissions ?? [];
  // Never invent a role list: with the matrix unread, a hard-coded fallback
  // would draw made-up defaults as if they were the stored configuration.
  const roles = permsQ.data?.assignableRoles ?? [];
  const byArea = new Map<string, PermissionDetail[]>();
  for (const p of permissions) {
    if (!byArea.has(p.area)) byArea.set(p.area, []);
    byArea.get(p.area)!.push(p);
  }

  function toggle(perm: PermissionDetail, role: string) {
    const current = draft[perm.key] ?? perm.allowedRoles;
    const next = current.includes(role) ? current.filter((r) => r !== role) : [...current, role];
    void applyRoles(perm, next, next);
  }

  function resetToDefault(perm: PermissionDetail) {
    void applyRoles(perm, null, perm.defaultAllowedRoles);
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

      {permsQ.isError && (
        <LoadFailedNotice
          label="permission"
          hasLastKnown={!!permsQ.data}
          onRetry={() => void permsQ.refetch()}
          retrying={permsQ.isFetching}
        />
      )}

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
                        disabled={busyKey === perm.key}
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
                            disabled={isAdmin || busyKey === perm.key}
                            onCheckedChange={() => toggle(perm, role)}
                            data-testid={`checkbox-${perm.key}-${role}`}
                          />
                          {ROLE_LABELS[role] ?? role}
                          {isAdmin && <span className="text-xs opacity-50">(always allowed)</span>}
                        </label>
                      );
                    })}
                  </div>
                  <ControlMessage message={messages[perm.key] ?? null} />
                </div>
              );
            })}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
