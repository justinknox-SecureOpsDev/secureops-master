import { useEffect, useState, useCallback } from "react";
import { api, getToken } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Loader2, ShieldCheck, ShieldAlert, KeyRound, Copy, Check,
  AlertTriangle, LogOut, BellOff, UserX, Trash2, AlertCircle,
} from "lucide-react";
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
  const { logout } = useAuth();

  // Account deletion (parity with the mobile app's in-app account closure).
  const [deletePassword, setDeletePassword] = useState("");
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  async function deleteAccount() {
    if (!deletePassword || deleteBusy) return;
    setDeleteBusy(true);
    setDeleteError(null);
    try {
      // Raw fetch (not the shared `api()` helper) so a wrong-password 401 shows
      // an inline retry instead of tripping the global 401 auto-logout.
      const token = getToken();
      const res = await fetch("/api/auth/delete-account", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ password: deletePassword }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setDeleteError(
          (data as { message?: string })?.message ||
            "Could not delete your account. Please try again.",
        );
        return;
      }
      // Success: the server has revoked every session. Clear the local session,
      // which routes the app back to the sign-in screen.
      setConfirmOpen(false);
      toast({
        title: "Account deleted",
        description: "Your account has been closed and you've been signed out.",
      });
      logout();
    } catch (err) {
      setDeleteError(
        (err as Error)?.message ||
          "Can't reach the server. Check your connection and try again.",
      );
    } finally {
      setDeleteBusy(false);
    }
  }

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
              · enabled {status.enrolledAt ? new Date(status.enrolledAt).toLocaleDateString() : ""}
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

      <div className="mt-10 border-t pt-8">
        <div className="flex items-center gap-3 mb-1">
          <AlertTriangle className="w-5 h-5 text-destructive" />
          <h2 className="text-lg font-semibold text-destructive">Delete account</h2>
        </div>
        <p className="text-sm text-muted-foreground mb-4">
          Permanently close your account and sign out on every device. This
          can't be undone from here — to return, HR must re-invite you.
        </p>

        <div className="border rounded-lg p-5 bg-white space-y-4">
          <div>
            <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
              What happens
            </div>
            <ul className="space-y-2 text-sm">
              <li className="flex items-start gap-2">
                <LogOut className="w-4 h-4 mt-0.5 text-muted-foreground shrink-0" />
                <span>You're signed out on every device and can no longer sign in.</span>
              </li>
              <li className="flex items-start gap-2">
                <BellOff className="w-4 h-4 mt-0.5 text-muted-foreground shrink-0" />
                <span>Notifications and live location sharing stop immediately.</span>
              </li>
              <li className="flex items-start gap-2">
                <UserX className="w-4 h-4 mt-0.5 text-muted-foreground shrink-0" />
                <span>Your account is deactivated. To return, HR must re-invite you.</span>
              </li>
            </ul>
          </div>

          <div className="border-t pt-4">
            <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
              What is retained
            </div>
            <p className="text-sm text-muted-foreground">
              As your employer, the company is legally required to keep certain
              records after your account is closed — such as employment,
              timekeeping, payroll and 1099 tax records, filed incident reports,
              and audit history — for the period required by law. These are
              retained by HR under the company retention policy and are no longer
              accessible to you here. To request a records review, contact HR.
            </p>
          </div>

          <div className="border-t pt-4 space-y-2">
            <Label htmlFor="delete-password" className="text-xs uppercase">
              Enter your password to confirm
            </Label>
            <Input
              id="delete-password"
              type="password"
              value={deletePassword}
              onChange={(e) => { setDeletePassword(e.target.value); if (deleteError) setDeleteError(null); }}
              placeholder="Password"
              autoComplete="current-password"
            />
            {deleteError && (
              <div className="flex items-center gap-2 text-sm text-destructive">
                <AlertCircle className="w-4 h-4 shrink-0" />
                <span>{deleteError}</span>
              </div>
            )}
            <Button
              variant="destructive"
              disabled={deleteBusy || !deletePassword}
              onClick={() => { setDeleteError(null); setConfirmOpen(true); }}
            >
              <Trash2 className="w-4 h-4 mr-2" />
              Delete my account
            </Button>
          </div>
        </div>
      </div>

      <AlertDialog open={confirmOpen} onOpenChange={(o) => { if (!deleteBusy) setConfirmOpen(o); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete your account?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently closes your account and signs you out on every
              device. You won't be able to sign in again. This can't be undone
              from here.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteBusy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => { e.preventDefault(); void deleteAccount(); }}
              disabled={deleteBusy}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleteBusy ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
              Delete account
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
