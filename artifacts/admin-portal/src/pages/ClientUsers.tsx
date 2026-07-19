import { useEffect, useState } from "react";
import {
  UserPlus, Trash2, RefreshCw, Mail, CheckCircle2, XCircle, Clock,
  Building2, AlertTriangle, Copy, Check,
} from "lucide-react";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";

type Client = { id: string; name: string };
type ClientUser = {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  status: string;
  clientId: string | null;
  clientName: string | null;
  createdAt: string;
  lastLoginAt: string | null;
  mustChangePassword: boolean;
  invitedAt: string | null;
};

function fmt(d: string | null) {
  if (!d) return "Never";
  return new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function StatusBadge({ status }: { status: string }) {
  const cfg: Record<string, { cls: string; icon: React.ReactNode }> = {
    active: { cls: "bg-green-100 text-green-700", icon: <CheckCircle2 className="w-3 h-3" /> },
    inactive: { cls: "bg-gray-100 text-gray-500", icon: <XCircle className="w-3 h-3" /> },
    pending: { cls: "bg-amber-100 text-amber-700", icon: <Clock className="w-3 h-3" /> },
  };
  const { cls, icon } = cfg[status] ?? { cls: "bg-gray-100 text-gray-500", icon: null };
  return (
    <span className={`inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full uppercase tracking-wide ${cls}`}>
      {icon}{status}
    </span>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  function copy() {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }
  return (
    <button
      onClick={copy}
      className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
      title="Copy to clipboard"
    >
      {copied ? <Check className="w-3 h-3 text-green-500" /> : <Copy className="w-3 h-3" />}
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

export default function ClientUsers() {
  const { toast } = useToast();
  const [users, setUsers] = useState<ClientUser[]>([]);
  const [clients, setClients] = useState<Client[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [inviteResult, setInviteResult] = useState<{ email: string; tempPassword?: string; loginUrl?: string } | null>(null);
  const [deactivating, setDeactivating] = useState<string | null>(null);

  const [form, setForm] = useState({ email: "", firstName: "", lastName: "", clientId: "" });

  function refresh() {
    return Promise.all([
      api<ClientUser[]>("/admin/client-users"),
      api<Client[]>("/admin/tables/clients?limit=500"),
    ]).then(([u, c]) => {
      setUsers(u);
      setClients(c);
    });
  }

  useEffect(() => { refresh().finally(() => setLoading(false)); }, []);

  function fld(k: keyof typeof form, v: string) { setForm((f) => ({ ...f, [k]: v })); }

  async function invite(e: React.FormEvent) {
    e.preventDefault();
    if (!form.clientId) { toast({ title: "Select a client organisation.", variant: "destructive" }); return; }
    setSubmitting(true);
    try {
      const res = await api<{ id: string; email: string; emailSent: boolean; loginUrl?: string; tempPassword?: string; status: string }>(
        "/admin/client-users/invite",
        { method: "POST", body: form },
      );
      toast({ title: res.status === "reinvited" ? "User re-invited." : "Client user created and invited." });
      setShowForm(false);
      setForm({ email: "", firstName: "", lastName: "", clientId: "" });
      if (!res.emailSent && res.tempPassword) {
        setInviteResult({ email: res.email, tempPassword: res.tempPassword, loginUrl: res.loginUrl });
      }
      await refresh();
    } catch (err: any) {
      toast({ title: err?.message ?? "Failed to invite user.", variant: "destructive" });
    } finally {
      setSubmitting(false);
    }
  }

  async function deactivate(id: string, email: string) {
    if (!confirm(`Deactivate client user ${email}? They will no longer be able to sign in.`)) return;
    setDeactivating(id);
    try {
      await api(`/admin/client-users/${id}`, { method: "DELETE" });
      toast({ title: "User deactivated." });
      await refresh();
    } catch (err: any) {
      toast({ title: err?.message ?? "Failed to deactivate.", variant: "destructive" });
    } finally {
      setDeactivating(null);
    }
  }

  return (
    <div className="max-w-4xl mx-auto px-4 py-8">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-xl font-bold flex items-center gap-2">
          <Building2 className="w-5 h-5" /> Client Portal Users
        </h1>
        <Button size="sm" className="gap-1" onClick={() => setShowForm((s) => !s)}>
          <UserPlus className="w-4 h-4" /> Invite client user
        </Button>
      </div>

      {/* Manual credentials notice */}
      {inviteResult && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg px-4 py-3 mb-6 space-y-1">
          <div className="flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 text-amber-500 shrink-0 mt-0.5" />
            <div>
              <p className="text-sm font-medium text-amber-800">Email not configured — share credentials manually</p>
              <div className="text-sm text-amber-700 mt-1 space-y-0.5">
                <div className="flex items-center gap-2">
                  <span className="font-mono">{inviteResult.email}</span>
                </div>
                <div className="flex items-center gap-2">
                  <span>Temp password:</span>
                  <code className="bg-white border rounded px-1.5 py-0.5 text-xs">{inviteResult.tempPassword}</code>
                  <CopyButton text={inviteResult.tempPassword!} />
                </div>
                {inviteResult.loginUrl && (
                  <div className="flex items-center gap-2">
                    <span>Login:</span>
                    <a href={inviteResult.loginUrl} className="underline text-xs">{inviteResult.loginUrl}</a>
                    <CopyButton text={inviteResult.loginUrl} />
                  </div>
                )}
              </div>
            </div>
          </div>
          <Button size="sm" variant="outline" className="mt-2" onClick={() => setInviteResult(null)}>Dismiss</Button>
        </div>
      )}

      {/* Invite form */}
      {showForm && (
        <form onSubmit={invite} className="border rounded-lg bg-card p-6 mb-8 space-y-4">
          <h2 className="text-base font-semibold">Invite a client portal user</h2>
          <p className="text-sm text-muted-foreground">
            A temporary password will be generated and emailed to the user (if SMTP is configured). They will be prompted to set a new password on first login.
          </p>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1">
              <Label htmlFor="firstName">First name *</Label>
              <Input id="firstName" required value={form.firstName} onChange={(e) => fld("firstName", e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="lastName">Last name *</Label>
              <Input id="lastName" required value={form.lastName} onChange={(e) => fld("lastName", e.target.value)} />
            </div>
          </div>
          <div className="space-y-1">
            <Label htmlFor="email">Email address *</Label>
            <Input id="email" type="email" required value={form.email} onChange={(e) => fld("email", e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="client">Client organisation *</Label>
            <select
              id="client"
              required
              value={form.clientId}
              onChange={(e) => fld("clientId", e.target.value)}
              className="w-full border rounded px-3 py-2 text-sm bg-background"
            >
              <option value="">Select a client…</option>
              {clients.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </div>
          <div className="flex gap-3 pt-1">
            <Button type="submit" disabled={submitting} className="gap-1">
              <Mail className="w-4 h-4" />
              {submitting ? "Inviting…" : "Send invitation"}
            </Button>
            <Button type="button" variant="outline" onClick={() => setShowForm(false)}>Cancel</Button>
          </div>
        </form>
      )}

      {/* User table */}
      {loading ? (
        <div className="text-center py-16 text-muted-foreground text-sm">Loading…</div>
      ) : users.length === 0 ? (
        <div className="text-center py-16 text-muted-foreground">
          <Building2 className="w-10 h-10 mx-auto mb-3 opacity-30" />
          <p className="text-sm">No client portal users yet.</p>
          <Button size="sm" className="mt-4 gap-1" onClick={() => setShowForm(true)}>
            <UserPlus className="w-4 h-4" /> Invite the first one
          </Button>
        </div>
      ) : (
        <div className="border rounded-lg overflow-x-auto" tabIndex={0} role="region" aria-label="Client users table">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-muted/40 border-b text-left">
                <th className="px-4 py-3 font-medium text-muted-foreground text-xs">User</th>
                <th className="px-4 py-3 font-medium text-muted-foreground text-xs hidden sm:table-cell">Client</th>
                <th className="px-4 py-3 font-medium text-muted-foreground text-xs hidden md:table-cell">Status</th>
                <th className="px-4 py-3 font-medium text-muted-foreground text-xs hidden lg:table-cell">Last login</th>
                <th className="px-4 py-3 font-medium text-muted-foreground text-xs hidden lg:table-cell">Invited</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y">
              {users.map((u) => (
                <tr key={u.id} className={`hover:bg-muted/20 transition-colors ${u.status === "inactive" ? "opacity-50" : ""}`}>
                  <td className="px-4 py-3">
                    <div className="font-medium">{u.firstName} {u.lastName}</div>
                    <div className="text-xs text-muted-foreground">{u.email}</div>
                    {u.mustChangePassword && (
                      <div className="text-[10px] text-amber-600 mt-0.5">Password change required</div>
                    )}
                  </td>
                  <td className="px-4 py-3 hidden sm:table-cell">
                    <span className="text-sm">{u.clientName ?? "—"}</span>
                  </td>
                  <td className="px-4 py-3 hidden md:table-cell">
                    <StatusBadge status={u.status} />
                  </td>
                  <td className="px-4 py-3 text-xs text-muted-foreground hidden lg:table-cell">
                    {fmt(u.lastLoginAt)}
                  </td>
                  <td className="px-4 py-3 text-xs text-muted-foreground hidden lg:table-cell">
                    {fmt(u.invitedAt)}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex items-center gap-2 justify-end">
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 px-2 gap-1 text-xs"
                        disabled={submitting}
                        onClick={async () => {
                          setSubmitting(true);
                          try {
                            const res = await api<{ email: string; tempPassword?: string; loginUrl?: string; emailSent: boolean; status: string }>(
                              "/admin/client-users/invite",
                              { method: "POST", body: { email: u.email, firstName: u.firstName, lastName: u.lastName, clientId: u.clientId } },
                            );
                            toast({ title: "Re-invitation sent." });
                            if (!res.emailSent && res.tempPassword) {
                              setInviteResult({ email: res.email, tempPassword: res.tempPassword, loginUrl: res.loginUrl });
                            }
                            await refresh();
                          } catch (err: any) {
                            toast({ title: err?.message ?? "Failed.", variant: "destructive" });
                          } finally {
                            setSubmitting(false); }
                        }}
                      >
                        <RefreshCw className="w-3 h-3" /> Re-invite
                      </Button>
                      {u.status !== "inactive" && (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7 px-2 text-destructive hover:bg-destructive/10"
                          disabled={deactivating === u.id}
                          onClick={() => deactivate(u.id, u.email)}
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </Button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
