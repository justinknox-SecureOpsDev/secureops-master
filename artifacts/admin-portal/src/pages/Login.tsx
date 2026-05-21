import { useState } from "react";
import { useAuth } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2, AlertCircle } from "lucide-react";

export function LoginPage() {
  const { login, loginTotp } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [challengeToken, setChallengeToken] = useState<string | null>(null);
  const [code, setCode] = useState("");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(email, password);
    } catch (err) {
      const e2 = err as Error & { challengeToken?: string };
      if (e2.message === "TOTP_REQUIRED" && e2.challengeToken) {
        setChallengeToken(e2.challengeToken);
      } else {
        setError(e2.message || "Login failed");
      }
    } finally {
      setBusy(false);
    }
  }

  async function submitTotp(e: React.FormEvent) {
    e.preventDefault();
    if (!challengeToken) return;
    setBusy(true);
    setError(null);
    try {
      await loginTotp(challengeToken, code);
    } catch (err) {
      setError((err as Error).message || "Invalid code");
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
            "radial-gradient(circle at 25% 20%, #c9a84c 0, transparent 40%), radial-gradient(circle at 80% 80%, #c9a84c 0, transparent 35%)",
        }}
      />
      <div className="w-full max-w-md bg-card rounded-xl shadow-2xl overflow-hidden relative">
        <div className="bg-brand-navy text-white p-6 text-center border-b-4 border-brand-gold relative">
          <img
            src={`${import.meta.env.BASE_URL}logo-256.png`}
            alt="Williams Council Security Group"
            className="w-24 h-24 mx-auto mb-3 object-contain drop-shadow-[0_4px_12px_rgba(201,168,76,0.35)]"
          />
          <div className="brand-wordmark text-xl">Williams Council</div>
          <div className="brand-wordmark text-xl brand-gold">Security Group</div>
          <div className="text-xs uppercase tracking-widest opacity-70 mt-1">Admin Portal</div>
        </div>
        {challengeToken ? (
          <form onSubmit={submitTotp} className="p-6 space-y-4">
            <div>
              <Label htmlFor="totp" className="text-xs uppercase font-semibold brand-navy">Two-factor code</Label>
              <Input id="totp" inputMode="numeric" autoComplete="one-time-code" required autoFocus
                value={code} onChange={(e) => setCode(e.target.value)}
                placeholder="000000 or recovery code" disabled={busy} />
              <p className="text-xs text-muted-foreground mt-1">
                Enter the 6-digit code from your authenticator app, or one of your recovery codes.
              </p>
            </div>
            {error && (
              <div className="flex items-start gap-2 text-sm text-destructive bg-destructive/5 p-2.5 rounded border border-destructive/20">
                <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
                <span>{error}</span>
              </div>
            )}
            <Button type="submit" disabled={busy || !code}
              className="w-full bg-brand-navy hover:opacity-90 text-white">
              {busy ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Verifying…</> : "Verify & sign in"}
            </Button>
            <button type="button" onClick={() => { setChallengeToken(null); setCode(""); setError(null); }}
              className="text-xs text-muted-foreground hover:underline w-full text-center">
              ← Use a different account
            </button>
          </form>
        ) : (
        <form onSubmit={submit} className="p-6 space-y-4">
          <div>
            <Label htmlFor="email" className="text-xs uppercase font-semibold brand-navy">Email</Label>
            <Input
              id="email" type="email" autoComplete="email" required autoFocus
              value={email} onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              disabled={busy}
            />
          </div>
          <div>
            <Label htmlFor="password" className="text-xs uppercase font-semibold brand-navy">Password</Label>
            <Input
              id="password" type="password" autoComplete="current-password" required
              value={password} onChange={(e) => setPassword(e.target.value)}
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
            type="submit" disabled={busy || !email || !password}
            className="w-full bg-brand-navy hover:opacity-90 text-white"
          >
            {busy ? (
              <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Signing in…</>
            ) : (
              "Sign in"
            )}
          </Button>
          <p className="text-xs text-muted-foreground text-center pt-2">
            Admin access only. Employees use the SecureOps mobile app.
          </p>
        </form>
        )}
        <div className="text-center text-[11px] text-white/50 mt-4 space-x-3">
          <a href={`${import.meta.env.BASE_URL}privacy`} className="hover:text-white/80 underline">Privacy</a>
          <a href={`${import.meta.env.BASE_URL}terms`} className="hover:text-white/80 underline">Terms</a>
          <a href={`${import.meta.env.BASE_URL}data-rights`} className="hover:text-white/80 underline">Your data rights</a>
        </div>
      </div>
      <div className="absolute bottom-3 left-0 right-0 text-center text-[10px] text-white/40 select-none">
        v1.0 · © {new Date().getFullYear()} Williams Council Security Group
      </div>
    </div>
  );
}
