import { useState } from "react";
import { useLocation } from "wouter";
import { api, ApiError } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AlertTriangle, Loader2, MailCheck, Send } from "lucide-react";

/**
 * Public "request a password reset" page. Companion to ResetPasswordPage
 * (which handles the emailed /reset-password/:token link).
 *
 * Anti-enumeration: the API always answers {ok:true} whether or not the email
 * exists, so the success state deliberately says "if an account exists…" and
 * we never branch on account existence client-side.
 */
export function ForgotPasswordPage() {
  const [, navigate] = useLocation();
  const [email, setEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await api("/auth/forgot-password", { method: "POST", body: { email } });
      setSent(true);
    } catch (err) {
      // Only transport-level failures land here (e.g. rate limiting) — the
      // endpoint never reveals whether the account exists.
      setError(err instanceof ApiError ? err.message : "Could not send the reset email. Try again shortly.");
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
          <div className="text-xs uppercase tracking-widest opacity-70 mt-1">Forgot password</div>
        </div>

        <div className="p-6 space-y-4">
          {!sent ? (
            <form onSubmit={submit} className="space-y-4">
              <p className="text-sm text-muted-foreground">
                Enter the email address for your account and we&apos;ll send you a link to reset your password.
              </p>

              <div>
                <Label htmlFor="email" className="text-xs uppercase font-semibold brand-navy">Email</Label>
                <Input
                  id="email" type="email" autoComplete="email" required autoFocus
                  value={email} onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  disabled={submitting}
                />
              </div>

              {error && (
                <div className="flex items-start gap-2 text-sm text-destructive bg-destructive/5 p-2.5 rounded border border-destructive/20">
                  <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
                  <span>{error}</span>
                </div>
              )}

              <Button
                type="submit"
                disabled={submitting || !email}
                className="w-full bg-brand-navy hover:opacity-90 text-white"
              >
                {submitting ? (
                  <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Sending…</>
                ) : (
                  <><Send className="w-4 h-4 mr-2" />Email me a reset link</>
                )}
              </Button>

              <button
                type="button"
                onClick={() => navigate("/")}
                className="text-xs text-muted-foreground hover:underline w-full text-center"
              >
                ← Back to sign in
              </button>
            </form>
          ) : (
            <div className="space-y-4 text-center py-4">
              <div className="mx-auto w-14 h-14 rounded-full bg-emerald-100 flex items-center justify-center">
                <MailCheck className="w-8 h-8 text-emerald-600" />
              </div>
              <div className="brand-wordmark text-lg brand-navy">Check your email</div>
              <p className="text-sm text-muted-foreground">
                If an account exists for <span className="font-mono">{email}</span>, a password reset link is on its
                way. The link expires after a short time, so use it soon. Don&apos;t forget to check your spam folder.
              </p>
              <Button
                onClick={() => navigate("/")}
                className="w-full bg-brand-navy text-white hover:opacity-90"
              >
                Back to sign in
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
