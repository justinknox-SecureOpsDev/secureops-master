import { useState } from "react";
import { useAuth } from "@/lib/auth";
import { getToken } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2, AlertCircle, ShieldCheck } from "lucide-react";

type User = {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  role: string;
  mustChangePassword?: boolean;
};

/**
 * Shown when a signed-in user still has `mustChangePassword: true` (e.g. a
 * client contact who just signed in with the temp password from their invite
 * email). The API blocks every non-/auth route with 403 until the credential
 * is rotated, so without this screen the client portal is unusable.
 *
 * We call /auth/change-password with a raw fetch (not the shared api() helper)
 * because a wrong current password returns 401 — routing that through api()
 * would trip the global "session expired" handler and bounce the user back to
 * the login screen instead of showing an inline "current password is wrong".
 */
export function MandatoryPasswordChange() {
  const { user, logout, applySession } = useAuth();
  const brandCfg = (window as any).__BRAND__ as
    | { companyName: string }
    | undefined;
  const companyName =
    brandCfg?.companyName ?? "Williams Council Security Group";

  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (newPassword.length < 8) {
      setError("New password must be at least 8 characters.");
      return;
    }
    if (newPassword !== confirm) {
      setError("New password and confirmation do not match.");
      return;
    }
    if (newPassword === currentPassword) {
      setError("New password must be different from the temporary password.");
      return;
    }
    setBusy(true);
    try {
      const token = getToken();
      const res = await fetch("/api/auth/change-password", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      const text = await res.text();
      let data: unknown = null;
      if (text) {
        try {
          data = JSON.parse(text);
        } catch {
          data = text;
        }
      }
      if (!res.ok) {
        const msg =
          (data as { message?: string; error?: string })?.message ??
          (data as { error?: string })?.error ??
          `Request failed (${res.status})`;
        setError(msg);
        return;
      }
      const { token: newToken, user: newUser } = data as {
        token: string;
        user: User;
      };
      if (!newToken || !newUser) {
        setError("Unexpected response. Please try again.");
        return;
      }
      applySession(newToken, newUser);
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen w-full flex items-center justify-center bg-brand-navy p-4 relative overflow-hidden">
      <div
        aria-hidden
        className="absolute inset-0 opacity-[0.04] pointer-events-none"
        style={{
          backgroundImage:
            "radial-gradient(circle at 25% 20%, #c9a04a 0, transparent 40%), radial-gradient(circle at 80% 80%, #c9a04a 0, transparent 35%)",
        }}
      />
      <div className="w-full max-w-md bg-card rounded-xl shadow-2xl overflow-hidden relative">
        <div className="bg-brand-navy text-white p-6 text-center border-b-4 border-brand-gold">
          <ShieldCheck className="w-12 h-12 mx-auto mb-2 text-brand-gold" />
          <div className="brand-wordmark text-xl">{companyName}</div>
          <div className="text-xs uppercase tracking-widest opacity-70 mt-1">
            Set a new password
          </div>
        </div>
        <form onSubmit={submit} className="p-6 space-y-4">
          <p className="text-sm text-muted-foreground">
            Welcome{user?.firstName ? `, ${user.firstName}` : ""}. For your
            security, please replace the temporary password from your invite
            email before continuing.
          </p>
          <div>
            <Label
              htmlFor="current"
              className="text-xs uppercase font-semibold brand-navy"
            >
              Temporary password
            </Label>
            <Input
              id="current"
              type="password"
              autoComplete="current-password"
              required
              autoFocus
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              disabled={busy}
            />
          </div>
          <div>
            <Label
              htmlFor="new"
              className="text-xs uppercase font-semibold brand-navy"
            >
              New password
            </Label>
            <Input
              id="new"
              type="password"
              autoComplete="new-password"
              required
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              disabled={busy}
              placeholder="At least 8 characters"
            />
          </div>
          <div>
            <Label
              htmlFor="confirm"
              className="text-xs uppercase font-semibold brand-navy"
            >
              Confirm new password
            </Label>
            <Input
              id="confirm"
              type="password"
              autoComplete="new-password"
              required
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              disabled={busy}
            />
          </div>
          {error && (
            <div className="flex items-start gap-2 text-sm text-destructive bg-destructive/5 p-2.5 rounded border border-destructive/20">
              <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}
          <Button
            type="submit"
            disabled={busy || !currentPassword || !newPassword || !confirm}
            className="w-full bg-brand-navy hover:opacity-90 text-white"
          >
            {busy ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                Saving…
              </>
            ) : (
              "Save & continue"
            )}
          </Button>
          <button
            type="button"
            onClick={logout}
            className="text-xs text-muted-foreground hover:underline w-full text-center"
          >
            ← Sign out
          </button>
        </form>
      </div>
    </div>
  );
}
