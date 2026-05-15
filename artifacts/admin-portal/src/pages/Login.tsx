import { useState } from "react";
import { useAuth } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ShieldCheck } from "lucide-react";

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
    <div className="min-h-screen w-full flex items-center justify-center bg-brand-navy p-4">
      <div className="w-full max-w-md bg-card rounded-xl shadow-2xl overflow-hidden">
        <div className="bg-brand-navy text-white p-6 text-center border-b-4 border-brand-gold">
          <ShieldCheck className="w-12 h-12 mx-auto mb-2 brand-gold" />
          <div className="brand-wordmark text-xl">Williams Council</div>
          <div className="brand-wordmark text-xl brand-gold">Security Group</div>
          <div className="text-xs uppercase tracking-widest opacity-70 mt-1">Admin Portal</div>
        </div>
        <form onSubmit={submit} className="p-6 space-y-4">
          <div>
            <Label htmlFor="email" className="text-xs uppercase font-semibold brand-navy">Email</Label>
            <Input
              id="email" type="email" autoComplete="email" required
              value={email} onChange={(e) => setEmail(e.target.value)}
              placeholder="admin@secureops.com"
            />
          </div>
          <div>
            <Label htmlFor="password" className="text-xs uppercase font-semibold brand-navy">Password</Label>
            <Input
              id="password" type="password" autoComplete="current-password" required
              value={password} onChange={(e) => setPassword(e.target.value)}
            />
          </div>
          {error && (
            <div className="text-sm text-destructive bg-destructive/5 p-2 rounded border border-destructive/20">
              {error}
            </div>
          )}
          <Button
            type="submit" disabled={busy}
            className="w-full bg-brand-navy hover:opacity-90 text-white"
          >
            {busy ? "Signing in…" : "Sign in"}
          </Button>
          <p className="text-xs text-muted-foreground text-center pt-2">
            Admin access only. Employees use the SecureOps mobile app.
          </p>
        </form>
      </div>
    </div>
  );
}
