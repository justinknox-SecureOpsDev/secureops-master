import { useEffect, useState } from "react";
import { useRoute, useLocation } from "wouter";
import { api, ApiError, setToken } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CheckCircle2, AlertTriangle, Loader2, Lock, Eye, EyeOff } from "lucide-react";

type TokenInfo = { email: string; firstName: string; expiresAt: string };
type AuthResponse = { token: string; user: { role: string } };

export function ResetPasswordPage() {
  const [, params] = useRoute("/reset-password/:token");
  const [, navigate] = useLocation();
  const token = params?.token ?? "";

  const [loading, setLoading] = useState(true);
  const [info, setInfo] = useState<TokenInfo | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [newPassword, setNewPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [show, setShow] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (!token) { setLoadError("Missing reset token"); setLoading(false); return; }
    let cancelled = false;
    (async () => {
      try {
        const data = await api<TokenInfo>(`/auth/reset-password/${encodeURIComponent(token)}`);
        if (!cancelled) setInfo(data);
      } catch (err) {
        if (!cancelled) setLoadError(err instanceof ApiError ? err.message : "Could not load reset link");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [token]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitError(null);
    if (newPassword.length < 8) { setSubmitError("Password must be at least 8 characters"); return; }
    if (newPassword !== confirm) { setSubmitError("Passwords do not match"); return; }
    setSubmitting(true);
    try {
      const resp = await api<AuthResponse>("/auth/reset-password", {
        method: "POST",
        body: { token, newPassword },
      });
      // Sign the admin in if they are an admin; for employees just show success
      // (they'll sign in on the mobile app with their new password).
      if (resp.user.role === "admin") {
        setToken(resp.token);
      }
      setDone(true);
    } catch (err) {
      setSubmitError(err instanceof ApiError ? err.message : "Could not reset password");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen w-full flex items-center justify-center bg-brand-navy p-4">
      <div className="w-full max-w-md bg-card rounded-xl shadow-2xl overflow-hidden">
        <div className="bg-brand-navy text-white p-6 text-center border-b-4 border-brand-gold">
          <img
            src={(window as any).__BRAND__?.logoDataUrl || `${import.meta.env.BASE_URL}logo-256.png`}
            alt={(window as any).__BRAND__?.companyName ?? "Williams Council Security Group"}
            className="w-20 h-20 mx-auto mb-3 object-contain"
          />
          <div className="brand-wordmark text-lg">{(window as any).__BRAND__?.companyName ?? "Williams Council Security Group"}</div>
          <div className="text-xs uppercase tracking-widest opacity-70 mt-1">Reset password</div>
        </div>

        <div className="p-6 space-y-4">
          {loading && (
            <div className="flex items-center justify-center gap-2 text-muted-foreground py-8">
              <Loader2 className="w-4 h-4 animate-spin" /> Checking reset link…
            </div>
          )}

          {!loading && loadError && (
            <div className="space-y-3">
              <div className="flex items-start gap-2 text-sm text-destructive bg-destructive/5 p-3 rounded border border-destructive/20">
                <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
                <span>{loadError}</span>
              </div>
              <p className="text-sm text-muted-foreground">
                This link may have expired or already been used. Request a new one from the sign-in screen.
              </p>
              <Button onClick={() => navigate("/")} className="w-full bg-brand-navy text-white hover:opacity-90">
                Back to sign in
              </Button>
            </div>
          )}

          {!loading && !loadError && info && !done && (
            <form onSubmit={submit} className="space-y-4">
              <div className="text-sm text-muted-foreground">
                Hi <span className="font-semibold brand-navy">{info.firstName}</span>, choose a new password for{" "}
                <span className="font-mono">{info.email}</span>.
              </div>

              <div>
                <Label htmlFor="newPassword" className="text-xs uppercase font-semibold brand-navy">New password</Label>
                <div className="relative">
                  <Input
                    id="newPassword"
                    type={show ? "text" : "password"}
                    autoComplete="new-password"
                    required minLength={8}
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    placeholder="At least 8 characters"
                    disabled={submitting}
                  />
                  <button
                    type="button"
                    onClick={() => setShow((s) => !s)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground p-1"
                    aria-label={show ? "Hide password" : "Show password"}
                  >
                    {show ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>

              <div>
                <Label htmlFor="confirm" className="text-xs uppercase font-semibold brand-navy">Confirm password</Label>
                <Input
                  id="confirm"
                  type={show ? "text" : "password"}
                  autoComplete="new-password"
                  required minLength={8}
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  disabled={submitting}
                />
              </div>

              {submitError && (
                <div className="flex items-start gap-2 text-sm text-destructive bg-destructive/5 p-2.5 rounded border border-destructive/20">
                  <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
                  <span>{submitError}</span>
                </div>
              )}

              <Button
                type="submit"
                disabled={submitting || !newPassword || !confirm}
                className="w-full bg-brand-navy hover:opacity-90 text-white"
              >
                {submitting ? (
                  <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Updating…</>
                ) : (
                  <><Lock className="w-4 h-4 mr-2" />Set new password</>
                )}
              </Button>
            </form>
          )}

          {done && (
            <div className="space-y-4 text-center py-4">
              <div className="mx-auto w-14 h-14 rounded-full bg-emerald-100 flex items-center justify-center">
                <CheckCircle2 className="w-8 h-8 text-emerald-600" />
              </div>
              <div className="brand-wordmark text-lg brand-navy">Password updated</div>
              <p className="text-sm text-muted-foreground">
                Your password has been reset. You can now sign in with your new password.
              </p>
              <Button
                onClick={() => navigate("/")}
                className="w-full bg-brand-navy text-white hover:opacity-90"
              >
                Continue to sign in
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
