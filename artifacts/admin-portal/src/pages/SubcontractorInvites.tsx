import { useEffect, useState } from "react";
import {
  UserPlus, RefreshCw, Mail, CheckCircle2, Clock,
  Building2, AlertTriangle, Copy, Check,
} from "lucide-react";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";

type Invite = {
  id: string;
  email: string;
  status: string;
  mustChangePassword: boolean;
  invitedAt: string | null;
  createdAt: string;
  lastLoginAt: string | null;
  subcontractorId: string | null;
  companyName: string | null;
};

function fmt(d: string | null) {
  if (!d) return "Never";
  return new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function StatusBadge({ status }: { status: string }) {
  const cfg: Record<string, { cls: string; icon: React.ReactNode }> = {
    active: { cls: "bg-green-100 text-green-700", icon: <CheckCircle2 className="w-3 h-3" /> },
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

export default function SubcontractorInvites() {
  const { toast } = useToast();
  const [invites, setInvites] = useState<Invite[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [inviteResult, setInviteResult] = useState<{ email: string; tempPassword?: string; loginUrl?: string; emailSent: boolean } | null>(null);
  const [email, setEmail] = useState("");

  function refresh() {
    return api<Invite[]>("/admin/subcontractor-invites").then(setInvites);
  }

  useEffect(() => { refresh().finally(() => setLoading(false)); }, []);

  async function invite(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    try {
      const res = await api<{ id: string; email: string; emailSent: boolean; loginUrl?: string; tempPassword?: string; status: string }>(
        "/admin/subcontractor-invites",
        { method: "POST", body: { email } },
      );
      toast({ title: res.status === "reinvited" ? "Vendor re-invited." : "Vendor invited." });
      setShowForm(false);
      setEmail("");
      if (res.tempPassword || res.loginUrl) {
        setInviteResult({ email: res.email, tempPassword: res.tempPassword, loginUrl: res.loginUrl, emailSent: res.emailSent });
      }
      await refresh();
    } catch (err: any) {
      toast({ title: err?.message ?? "Failed to invite vendor.", variant: "destructive" });
    } finally {
      setSubmitting(false);
    }
  }

  async function reinvite(inv: Invite) {
    setSubmitting(true);
    try {
      const res = await api<{ email: string; tempPassword?: string; loginUrl?: string; emailSent: boolean; status: string }>(
        "/admin/subcontractor-invites",
        { method: "POST", body: { email: inv.email } },
      );
      toast({ title: "Re-invitation sent." });
      if (res.tempPassword || res.loginUrl) {
        setInviteResult({ email: res.email, tempPassword: res.tempPassword, loginUrl: res.loginUrl, emailSent: res.emailSent });
      }
      await refresh();
    } catch (err: any) {
      toast({ title: err?.message ?? "Failed.", variant: "destructive" });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="max-w-4xl mx-auto px-4 py-8">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-xl font-bold flex items-center gap-2">
          <Building2 className="w-5 h-5" /> Subcontractor Portal Users
        </h1>
        <Button size="sm" className="gap-1" onClick={() => setShowForm((s) => !s)}>
          <UserPlus className="w-4 h-4" /> Invite subcontractor
        </Button>
      </div>

      <p className="text-sm text-muted-foreground mb-6">
        Invite a vendor by email — they'll set their own company info, tax ID/W-9, certificate of insurance, and
        banking details in their own portal. No need to enter it for them.
      </p>

      {inviteResult && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg px-4 py-3 mb-6 space-y-1">
          <div className="flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 text-amber-500 shrink-0 mt-0.5" />
            <div>
              <p className="text-sm font-medium text-amber-800">
                {inviteResult.emailSent
                  ? "Invitation emailed — you can also share the link and temp password directly"
                  : "Email not configured — share credentials manually"}
              </p>
              <div className="text-sm text-amber-700 mt-1 space-y-0.5">
                <div className="flex items-center gap-2">
                  <span className="font-mono">{inviteResult.email}</span>
                </div>
                {inviteResult.tempPassword && (
                  <div className="flex items-center gap-2">
                    <span>Temp password:</span>
                    <code className="bg-white border rounded px-1.5 py-0.5 text-xs">{inviteResult.tempPassword}</code>
                    <CopyButton text={inviteResult.tempPassword} />
                  </div>
                )}
                {inviteResult.loginUrl && (
                  <div className="flex items-center gap-2">
                    <span>Login link:</span>
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

      {showForm && (
        <form onSubmit={invite} className="border rounded-lg bg-card p-6 mb-8 space-y-4">
          <h2 className="text-base font-semibold">Invite a subcontractor</h2>
          <p className="text-sm text-muted-foreground">
            A temporary password will be generated and emailed to them (if SMTP is configured). They'll set a new
            password and fill out their company profile on first login.
          </p>
          <div className="space-y-1">
            <Label htmlFor="email">Email address *</Label>
            <Input id="email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
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

      {loading ? (
        <div className="text-center py-16 text-muted-foreground text-sm">Loading…</div>
      ) : invites.length === 0 ? (
        <div className="text-center py-16 text-muted-foreground">
          <Building2 className="w-10 h-10 mx-auto mb-3 opacity-30" />
          <p className="text-sm">No subcontractor portal users yet.</p>
          <Button size="sm" className="mt-4 gap-1" onClick={() => setShowForm(true)}>
            <UserPlus className="w-4 h-4" /> Invite the first one
          </Button>
        </div>
      ) : (
        <div className="border rounded-lg overflow-x-auto" tabIndex={0} role="region" aria-label="Subcontractor portal users table">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-muted/40 border-b text-left">
                <th className="px-4 py-3 font-medium text-muted-foreground text-xs">Vendor</th>
                <th className="px-4 py-3 font-medium text-muted-foreground text-xs hidden sm:table-cell">Company</th>
                <th className="px-4 py-3 font-medium text-muted-foreground text-xs hidden md:table-cell">Status</th>
                <th className="px-4 py-3 font-medium text-muted-foreground text-xs hidden lg:table-cell">Last login</th>
                <th className="px-4 py-3 font-medium text-muted-foreground text-xs hidden lg:table-cell">Invited</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y">
              {invites.map((inv) => (
                <tr key={inv.id} className="hover:bg-muted/20 transition-colors">
                  <td className="px-4 py-3">
                    <div className="text-xs text-muted-foreground">{inv.email}</div>
                    {inv.mustChangePassword && (
                      <div className="text-[10px] text-amber-600 mt-0.5">Password change required</div>
                    )}
                  </td>
                  <td className="px-4 py-3 hidden sm:table-cell">
                    <span className="text-sm">
                      {inv.companyName ?? (
                        <span className="text-muted-foreground italic">Not filled in yet</span>
                      )}
                    </span>
                  </td>
                  <td className="px-4 py-3 hidden md:table-cell">
                    <StatusBadge status={inv.status} />
                  </td>
                  <td className="px-4 py-3 text-xs text-muted-foreground hidden lg:table-cell">
                    {fmt(inv.lastLoginAt)}
                  </td>
                  <td className="px-4 py-3 text-xs text-muted-foreground hidden lg:table-cell">
                    {fmt(inv.invitedAt)}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 px-2 gap-1 text-xs"
                      disabled={submitting}
                      onClick={() => reinvite(inv)}
                    >
                      <RefreshCw className="w-3 h-3" /> Re-invite
                    </Button>
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
