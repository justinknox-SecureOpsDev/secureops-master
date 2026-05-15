import { useState } from "react";
import { useAuth } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2, AlertCircle } from "lucide-react";

export function LoginPage() {
  const { login } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(email, password);
    } catch (err) {
      setError((err as Error).message || "Login failed");
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
          <span className="absolute top-3 right-3 text-[9px] uppercase tracking-wider px-1.5 py-px rounded-sm bg-brand-gold/20 brand-gold border border-brand-gold/40">
            Beta
          </span>
          <img
            src={`${import.meta.env.BASE_URL}logo-256.png`}
            alt="Williams Council Security Group"
            className="w-24 h-24 mx-auto mb-3 object-contain drop-shadow-[0_4px_12px_rgba(201,168,76,0.35)]"
          />
          <div className="brand-wordmark text-xl">Williams Council</div>
          <div className="brand-wordmark text-xl brand-gold">Security Group</div>
          <div className="text-xs uppercase tracking-widest opacity-70 mt-1">Admin Portal</div>
        </div>
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
      </div>
      <div className="absolute bottom-3 left-0 right-0 text-center text-[10px] text-white/40 select-none">
        v1.0 beta · © {new Date().getFullYear()} Williams Council Security Group
      </div>
    </div>
  );
}
