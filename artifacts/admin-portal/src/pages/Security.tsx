import { useEffect, useState, useCallback } from "react";
import { api } from "@/lib/api";
import { formatDate } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2, ShieldCheck, ShieldAlert, KeyRound, Copy, Check } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

type Status = { enrolled: boolean; enrolledAt: string | null; recoveryCodesRemaining: number };

export default function SecurityPage() {
  const [status, setStatus] = useState<Status | null>(null);
  const [enroll, setEnroll] = useState<{ secret: string; otpauthUrl: string; qrcodeDataUri: string } | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [disableCode, setDisableCode] = useState("");
  const [copied, setCopied] = useState(false);
  const { toast } = useToast();

  const refresh = useCallback(async () => {
    try {
      setStatus(await api<Status>("/me/totp/status"));
    } catch (err) {
      toast({ title: "Could not load 2FA status", description: (err as Error).message, variant: "destructive" });
    }
  }, [toast]);

  useEffect(() => { void refresh(); }, [refresh]);

  async function startEnroll() {
    setBusy(true);
    try {
      setEnroll(await api("/me/totp/enroll", { method: "POST" }));
    } catch (err) {
      toast({ title: "Enrollment failed", description: (err as Error).message, variant: "destructive" });
    } finally { setBusy(false); }
  }

  async function confirmEnroll() {
    setBusy(true);
    try {
      const res = await api<{ enrolled: boolean; recoveryCodes: string[] }>(
        "/me/totp/confirm",
        { method: "POST", body: { code } },
      );
      setRecoveryCodes(res.recoveryCodes);
      setEnroll(null);
      setCode("");
      await refresh();
      toast({ title: "Two-factor enabled" });
    } catch (err) {
      toast({ title: "Invalid code", description: (err as Error).message, variant: "destructive" });
    } finally { setBusy(false); }
  }

  async function disable() {
    setBusy(true);
    try {
      await api("/me/totp/disable", { method: "POST", body: { code: disableCode } });
      setDisableCode("");
      setRecoveryCodes(null);
      await refresh();
      toast({ title: "Two-factor disabled" });
    } catch (err) {
      toast({ title: "Could not disable 2FA", description: (err as Error).message, variant: "destructive" });
    } finally { setBusy(false); }
  }

  async function regenRecovery() {
    setBusy(true);
    try {
      const res = await api<{ recoveryCodes: string[] }>(
        "/me/totp/recovery-codes",
        { method: "POST", body: { code: disableCode } },
      );
      setRecoveryCodes(res.recoveryCodes);
      setDisableCode("");
      await refresh();
    } catch (err) {
      toast({ title: "Could not regenerate codes", description: (err as Error).message, variant: "destructive" });
    } finally { setBusy(false); }
  }

  function copyRecovery() {
    if (!recoveryCodes) return;
    navigator.clipboard.writeText(recoveryCodes.join("\n")).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    });
  }

  return (
    <div className="flex-1 overflow-auto p-6 max-w-2xl">
      <div className="flex items-center gap-3 mb-1">
        <ShieldCheck className="w-5 h-5 brand-navy" />
        <h1 className="text-xl brand-wordmark brand-navy">Account security</h1>
      </div>
      <p className="text-sm text-muted-foreground mb-6">
        Two-factor authentication adds a 6-digit code from an authenticator app
        (Google Authenticator, 1Password, Authy) on top of your password.
      </p>

      {recoveryCodes && (
        <div className="border-2 border-brand-gold rounded-lg p-4 mb-6 bg-amber-50">
          <div className="flex items-center gap-2 mb-2">
            <KeyRound className="w-4 h-4 brand-gold" />
            <strong className="brand-navy">Save your recovery codes</strong>
          </div>
          <p className="text-xs text-muted-foreground mb-3">
            Each code can be used once if you lose access to your authenticator app.
            We will never show these again — store them somewhere safe right now.
          </p>
          <div className="grid grid-cols-2 gap-2 font-mono text-sm bg-white rounded border p-3 mb-3">
            {recoveryCodes.map((c) => <div key={c}>{c}</div>)}
          </div>
          <Button size="sm" variant="outline" onClick={copyRecovery}>
            {copied ? <><Check className="w-3 h-3 mr-1" />Copied</> : <><Copy className="w-3 h-3 mr-1" />Copy all</>}
          </Button>
        </div>
      )}

      {!status ? (
        <div className="text-sm text-muted-foreground"><Loader2 className="w-4 h-4 animate-spin inline mr-2" />Loading…</div>
      ) : !status.enrolled ? (
        <div className="border rounded-lg p-5 bg-white">
          <div className="flex items-center gap-2 mb-2">
            <ShieldAlert className="w-4 h-4 text-amber-600" />
            <strong>Two-factor is OFF</strong>
          </div>
          {!enroll ? (
            <Button onClick={startEnroll} disabled={busy} className="bg-brand-navy text-white hover:opacity-90">
              {busy ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}Set up two-factor
            </Button>
          ) : (
            <div className="space-y-4">
              <p className="text-sm">1. Scan this QR code with your authenticator app:</p>
              <img src={enroll.qrcodeDataUri} alt="TOTP QR" className="w-48 h-48 border rounded" />
              <details className="text-xs text-muted-foreground">
                <summary className="cursor-pointer">Or enter the secret manually</summary>
                <code className="block mt-1 p-2 bg-muted rounded break-all">{enroll.secret}</code>
              </details>
              <div>
                <Label className="text-xs uppercase">2. Enter the 6-digit code</Label>
                <Input value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                  inputMode="numeric" placeholder="000000" autoComplete="one-time-code" />
              </div>
              <div className="flex gap-2">
                <Button onClick={confirmEnroll} disabled={busy || code.length !== 6}
                  className="bg-brand-navy text-white hover:opacity-90">
                  {busy ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}Confirm & enable
                </Button>
                <Button variant="ghost" onClick={() => { setEnroll(null); setCode(""); }}>Cancel</Button>
              </div>
            </div>
          )}
        </div>
      ) : (
        <div className="border rounded-lg p-5 bg-white space-y-4">
          <div className="flex items-center gap-2">
            <ShieldCheck className="w-4 h-4 text-emerald-700" />
            <strong>Two-factor is ON</strong>
            <span className="text-xs text-muted-foreground">
              · enabled {status.enrolledAt ? formatDate(status.enrolledAt) : ""}
              · {status.recoveryCodesRemaining} recovery codes remaining
            </span>
          </div>
          <div className="border-t pt-4 space-y-2">
            <Label className="text-xs uppercase">Current 6-digit code or recovery code</Label>
            <Input value={disableCode} onChange={(e) => setDisableCode(e.target.value)}
              placeholder="000000 or XXXXX-XXXXX" autoComplete="one-time-code" />
            <div className="flex gap-2">
              <Button variant="outline" onClick={regenRecovery} disabled={busy || !disableCode}>
                Regenerate recovery codes
              </Button>
              <Button variant="destructive" onClick={disable} disabled={busy || !disableCode}>
                Disable two-factor
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
